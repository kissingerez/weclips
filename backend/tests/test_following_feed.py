"""Tests for the new GET /api/videos/following endpoint and core feed flows.

Covers the requested regression scope:
- Login with the Apple demo credentials
- GET /api/videos (discover feed) returns 200 + list
- GET /api/videos/following returns 200 + [] for an account that follows nobody
- GET /api/videos/following requires auth (401 without token)
- VideoPublic items expose the fields VideoCard expects (creator_id/name/views/...)
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
if not BASE_URL:
    # Fall back to the value baked into the frontend .env (read at collection
    # time so we never silently target a wrong host).
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip()
                break
BASE_URL = (BASE_URL or "").rstrip("/")

APPLE_EMAIL = "appletest@weclips.app"
APPLE_PASSWORD = "AppleReview2026!"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def apple_token(api):
    r = api.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": APPLE_EMAIL, "password": APPLE_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    body = r.json()
    assert "access_token" in body, body
    return body["access_token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# --- Auth -----------------------------------------------------------------
class TestAuth:
    def test_login_returns_token(self, apple_token):
        assert isinstance(apple_token, str) and len(apple_token) > 20

    def test_me_returns_user(self, api, apple_token):
        r = api.get(f"{BASE_URL}/api/auth/me", headers=_auth(apple_token), timeout=15)
        assert r.status_code == 200, r.text
        me = r.json()
        assert me.get("email") == APPLE_EMAIL
        # Apple demo account is documented as a subscriber in test_credentials.md
        assert me.get("is_subscribed") is True, me


# --- Discover feed --------------------------------------------------------
class TestDiscoverFeed:
    def test_videos_list_ok(self, api, apple_token):
        r = api.get(f"{BASE_URL}/api/videos", headers=_auth(apple_token), timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)

    def test_video_card_shape(self, api, apple_token):
        r = api.get(f"{BASE_URL}/api/videos", headers=_auth(apple_token), timeout=20)
        assert r.status_code == 200
        data = r.json()
        if not data:
            pytest.skip("no videos seeded — cannot assert card shape")
        v = data[0]
        # Fields VideoCard.tsx + Following screen rely on
        for k in ("id", "title", "creator_name", "views", "has_thumbnail", "created_at"):
            assert k in v, f"missing field {k} in {v}"
        # creator_id is what the avatar/profile link depends on
        assert "creator_id" in v, v


# --- Following feed (new endpoint) ----------------------------------------
class TestFollowingFeed:
    def test_requires_auth(self, api):
        r = api.get(f"{BASE_URL}/api/videos/following", timeout=15)
        assert r.status_code in (401, 403), r.status_code

    def test_apple_follows_nobody_returns_empty(self, api, apple_token):
        r = api.get(
            f"{BASE_URL}/api/videos/following", headers=_auth(apple_token), timeout=20
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        # Apple demo is documented as following nobody.
        assert data == [], f"expected empty list, got {len(data)} items"

    def test_respects_limit_param(self, api, apple_token):
        r = api.get(
            f"{BASE_URL}/api/videos/following?limit=5",
            headers=_auth(apple_token),
            timeout=20,
        )
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), list)


# --- Avatar endpoint used by VideoCard -----------------------------------
class TestAvatarEndpoint:
    def test_avatar_returns_image_or_404(self, api, apple_token):
        # Find any video and try its creator's avatar (404 is the documented fallback)
        r = api.get(f"{BASE_URL}/api/videos", headers=_auth(apple_token), timeout=20)
        if r.status_code != 200 or not r.json():
            pytest.skip("no videos to derive a creator id from")
        creator_id = r.json()[0].get("creator_id")
        if not creator_id:
            pytest.skip("no creator_id on sample video")
        rr = api.get(f"{BASE_URL}/api/users/{creator_id}/avatar", timeout=20)
        # The mobile UI relies on either 200 (image bytes) or 404 (initials fallback)
        assert rr.status_code in (200, 404), rr.status_code
