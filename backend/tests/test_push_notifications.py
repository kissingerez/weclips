"""Tests for the new push-notifications feature (iteration 6).

Coverage:
- POST /api/notifications/push-preference: auth required, persists, GET /auth/me reflects.
- POST /api/register-push: auth required; with valid token relays upstream and
  in this preview env the placeholder push key causes a 5xx (NOT 200) but the
  server stays healthy.
- Push hooks on like/comment/follow do not break those endpoints — they still
  return their normal 200 even though the upstream relay errors internally.
- GET /api/auth/me includes the new `push_enabled` field (defaults true).
"""

import os
import uuid
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

# Reviewer / google test account from /app/memory/test_credentials.md.
PRIMARY_EMAIL = "googletest@weclips.app"
PRIMARY_PASSWORD = "GoogleReview2026!"

# Apple reviewer account — used as a second subscriber so we can exercise
# like / comment / follow cross-user.
SECONDARY_EMAIL = "appletest@weclips.app"
SECONDARY_PASSWORD = "AppleReview2026!"


def _login(session: requests.Session, email: str, password: str) -> str:
    r = session.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    tok = r.json().get("access_token")
    assert tok, "login response missing access_token"
    return tok


@pytest.fixture(scope="module")
def primary():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    tok = _login(s, PRIMARY_EMAIL, PRIMARY_PASSWORD)
    s.headers.update({"Authorization": f"Bearer {tok}"})
    me = s.get(f"{API}/auth/me").json()
    return {"session": s, "token": tok, "me": me}


@pytest.fixture(scope="module")
def secondary():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    tok = _login(s, SECONDARY_EMAIL, SECONDARY_PASSWORD)
    s.headers.update({"Authorization": f"Bearer {tok}"})
    me = s.get(f"{API}/auth/me").json()
    return {"session": s, "token": tok, "me": me}


# ---------------------------------------------------------------------------
# /auth/me — new push_enabled field
# ---------------------------------------------------------------------------
class TestAuthMePushField:
    def test_me_includes_push_enabled(self, primary):
        me = primary["me"]
        assert "push_enabled" in me, "GET /auth/me missing push_enabled field"
        assert isinstance(me["push_enabled"], bool)


# ---------------------------------------------------------------------------
# /notifications/push-preference
# ---------------------------------------------------------------------------
class TestPushPreference:
    def test_requires_auth(self):
        r = requests.post(
            f"{API}/notifications/push-preference",
            json={"enabled": False},
        )
        assert r.status_code in (401, 403), r.status_code

    def test_toggle_off_then_on_persists(self, primary):
        s = primary["session"]

        # Turn OFF
        r = s.post(f"{API}/notifications/push-preference", json={"enabled": False})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {"push_enabled": False}

        me = s.get(f"{API}/auth/me").json()
        assert me["push_enabled"] is False, "push_enabled did not persist after toggle off"

        # Turn ON
        r = s.post(f"{API}/notifications/push-preference", json={"enabled": True})
        assert r.status_code == 200
        assert r.json() == {"push_enabled": True}

        me = s.get(f"{API}/auth/me").json()
        assert me["push_enabled"] is True, "push_enabled did not persist after toggle on"

    def test_validation_rejects_missing_body(self, primary):
        s = primary["session"]
        r = s.post(f"{API}/notifications/push-preference", json={})
        assert r.status_code in (400, 422), r.status_code


# ---------------------------------------------------------------------------
# /register-push — placeholder key in preview → expected 5xx, NOT 200, no crash
# ---------------------------------------------------------------------------
class TestRegisterPush:
    def test_requires_auth(self):
        r = requests.post(
            f"{API}/register-push",
            json={"platform": "ios", "device_token": "FAKE"},
        )
        assert r.status_code in (401, 403)

    def test_placeholder_key_does_not_succeed_but_server_healthy(self, primary):
        s = primary["session"]
        r = s.post(
            f"{API}/register-push",
            json={"platform": "ios", "device_token": "EXPO_FAKE_TOKEN_FOR_TEST"},
        )
        # Placeholder upstream key MUST NOT report success.
        assert r.status_code != 200, (
            f"register-push returned 200 with placeholder key — this would falsely "
            f"claim success. body={r.text}"
        )
        # Expected to be 5xx (500 if upstream 401/403, 502 otherwise).
        assert 500 <= r.status_code < 600, (
            f"unexpected status {r.status_code} for placeholder key; body={r.text}"
        )

        # Server must still be healthy afterwards.
        r2 = s.get(f"{API}/auth/me")
        assert r2.status_code == 200, "server unhealthy after register-push failure"
        assert "push_enabled" in r2.json()


# ---------------------------------------------------------------------------
# Notification-generating endpoints must still succeed despite push hook errors.
# ---------------------------------------------------------------------------
class TestPushHooksDoNotBreakEndpoints:
    """We exercise like / comment / follow using the SUBSCRIBED primary account
    (googletest) as the actor, against a video by another creator. The push
    relay will fail internally (placeholder key) but the user-visible response
    must still be 200 and the server must stay healthy.

    Note: in this preview env only googletest@weclips.app is currently
    subscribed; appletest's subscription is `none`. Like/comment require an
    active subscription so we use googletest as the actor.
    """

    def _get_video_not_owned_by(self, session: requests.Session, actor_id: str):
        r = session.get(f"{API}/videos")
        if r.status_code != 200:
            return None
        feed = r.json() if isinstance(r.json(), list) else []
        for v in feed:
            if v.get("creator_id") and v.get("creator_id") != actor_id:
                return v
        return None

    def test_follow_endpoint_succeeds_with_push_hook(self, primary, secondary):
        # Apple → Google (follow doesn't require subscription)
        s = secondary["session"]
        target_id = primary["me"]["id"]
        s.delete(f"{API}/users/{target_id}/follow")  # best-effort cleanup

        r = s.post(f"{API}/users/{target_id}/follow")
        assert r.status_code == 200, f"follow failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("following") is True
        assert isinstance(body.get("followers"), int)

        # cleanup
        s.delete(f"{API}/users/{target_id}/follow")

    def test_like_endpoint_succeeds_with_push_hook(self, primary):
        # google (subscribed) likes any other creator's video
        s = primary["session"]
        actor_id = primary["me"]["id"]
        v = self._get_video_not_owned_by(s, actor_id)
        if not v:
            pytest.skip("no video by another creator available to like")
        vid = v.get("id") or v.get("_id")
        r = s.post(f"{API}/videos/{vid}/like")
        assert r.status_code == 200, f"like failed: {r.status_code} {r.text}"
        body = r.json()
        assert "liked" in body and "likes" in body
        assert isinstance(body["likes"], int)

    def test_comment_endpoint_succeeds_with_push_hook(self, primary):
        s = primary["session"]
        actor_id = primary["me"]["id"]
        v = self._get_video_not_owned_by(s, actor_id)
        if not v:
            pytest.skip("no video by another creator available to comment on")
        vid = v.get("id") or v.get("_id")
        text = f"TEST_push_hook_{uuid.uuid4().hex[:8]}"
        r = s.post(f"{API}/videos/{vid}/comments", json={"text": text})
        assert r.status_code == 200, f"comment failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("text") == text
        assert "id" in body

    def test_server_healthy_after_push_hook_exercises(self, primary):
        # Final sanity check — auth/me still works.
        r = primary["session"].get(f"{API}/auth/me")
        assert r.status_code == 200
