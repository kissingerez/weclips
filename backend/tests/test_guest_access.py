"""
Guest (Apple 5.1.1) access tests:
- 4 endpoints must allow NO Authorization header and still return 200.
- Gated endpoints (stream-url, comments, likes, follow, upload) must still 401.
- Logged-in regression: same endpoints still 200 + stream-url 200 for subscriber.
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
if not BASE_URL:
    # fallback to frontend/.env public URL used by tests prior
    BASE_URL = "https://weclips-preview.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"

APPLE_EMAIL = "appletest@weclips.app"
APPLE_PASSWORD = "AppleReview2026!"
SAMPLE_USER_ID = "f4a60da3-4a82-4da7-924c-6c02cbf10887"
SAMPLE_VIDEO_ID = "24516610-e939-4374-97f7-93862c5848f7"


# ---------- Fixtures ----------

@pytest.fixture(scope="module")
def guest():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def apple_token():
    r = requests.post(
        f"{API}/auth/login",
        json={"email": APPLE_EMAIL, "password": APPLE_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"Apple login failed: {r.status_code} {r.text[:200]}"
    data = r.json()
    tok = data.get("access_token")
    assert tok, f"No access_token: {data}"
    return tok


@pytest.fixture(scope="module")
def auth_client(apple_token):
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "Authorization": f"Bearer {apple_token}"})
    return s


# ---------- GUEST: previously-gated read endpoints must now return 200 ----------

class TestGuestReadEndpoints:
    def test_guest_videos_feed(self, guest):
        r = guest.get(f"{API}/videos", timeout=30)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert isinstance(data, list)

    def test_guest_get_user_public(self, guest):
        r = guest.get(f"{API}/users/{SAMPLE_USER_ID}", timeout=30)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert data.get("id") == SAMPLE_USER_ID
        assert "display_name" in data or "username" in data

    def test_guest_get_user_videos(self, guest):
        r = guest.get(f"{API}/users/{SAMPLE_USER_ID}/videos", timeout=30)
        assert r.status_code == 200, r.text[:200]
        assert isinstance(r.json(), list)

    def test_guest_search_users(self, guest):
        r = guest.get(f"{API}/users/search", params={"q": "ni"}, timeout=30)
        assert r.status_code == 200, r.text[:200]
        assert isinstance(r.json(), list)

    def test_guest_get_video_detail(self, guest):
        r = guest.get(f"{API}/videos/{SAMPLE_VIDEO_ID}", timeout=30)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert data.get("id") == SAMPLE_VIDEO_ID
        assert "title" in data
        assert "creator_id" in data


# ---------- GUEST: gated endpoints must still 401 ----------

class TestGuestGatedEndpoints:
    def test_guest_stream_url_blocked(self, guest):
        r = guest.get(f"{API}/videos/{SAMPLE_VIDEO_ID}/stream-url", timeout=30)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_guest_comments_get_blocked(self, guest):
        r = guest.get(f"{API}/videos/{SAMPLE_VIDEO_ID}/comments", timeout=30)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_guest_like_blocked(self, guest):
        r = guest.post(f"{API}/videos/{SAMPLE_VIDEO_ID}/like", json={}, timeout=30)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_guest_comment_create_blocked(self, guest):
        r = guest.post(
            f"{API}/videos/{SAMPLE_VIDEO_ID}/comments",
            json={"text": "guest test"},
            timeout=30,
        )
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_guest_follow_blocked(self, guest):
        r = guest.post(f"{API}/users/{SAMPLE_USER_ID}/follow", json={}, timeout=30)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"

    def test_guest_upload_url_blocked(self, guest):
        r = guest.post(
            f"{API}/videos/upload-url",
            json={"title": "x", "description": "", "mime_type": "video/mp4", "no_ai_confirmed": True},
            timeout=30,
        )
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:200]}"


# ---------- LOGGED-IN regression ----------

class TestLoggedInRegression:
    def test_login_returns_token(self, apple_token):
        assert apple_token and isinstance(apple_token, str) and len(apple_token) > 20

    def test_auth_me(self, auth_client):
        r = auth_client.get(f"{API}/auth/me", timeout=30)
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert data.get("email") == APPLE_EMAIL

    def test_videos_feed_authed(self, auth_client):
        r = auth_client.get(f"{API}/videos", timeout=30)
        assert r.status_code == 200

    def test_get_video_detail_authed(self, auth_client):
        r = auth_client.get(f"{API}/videos/{SAMPLE_VIDEO_ID}", timeout=30)
        assert r.status_code == 200
        assert r.json().get("id") == SAMPLE_VIDEO_ID

    def test_stream_url_authed_subscriber(self, auth_client):
        r = auth_client.get(f"{API}/videos/{SAMPLE_VIDEO_ID}/stream-url", timeout=30)
        # Apple demo is a subscriber; should be 200
        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:200]}"
        data = r.json()
        assert "stream_url" in data
        assert isinstance(data["stream_url"], str) and len(data["stream_url"]) > 0

    def test_comments_get_authed(self, auth_client):
        r = auth_client.get(f"{API}/videos/{SAMPLE_VIDEO_ID}/comments", timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_get_user_public_authed(self, auth_client):
        r = auth_client.get(f"{API}/users/{SAMPLE_USER_ID}", timeout=30)
        assert r.status_code == 200

    def test_get_user_videos_authed(self, auth_client):
        r = auth_client.get(f"{API}/users/{SAMPLE_USER_ID}/videos", timeout=30)
        assert r.status_code == 200


# ---------- No 5xx anywhere on the touched paths ----------

class TestNo5xx:
    @pytest.mark.parametrize("path", [
        "/videos",
        f"/users/{SAMPLE_USER_ID}",
        f"/users/{SAMPLE_USER_ID}/videos",
        "/users/search?q=ni",
        f"/videos/{SAMPLE_VIDEO_ID}",
        f"/videos/{SAMPLE_VIDEO_ID}/stream-url",
        f"/videos/{SAMPLE_VIDEO_ID}/comments",
    ])
    def test_no_5xx_guest(self, guest, path):
        r = guest.get(f"{API}{path}", timeout=30)
        assert r.status_code < 500, f"5xx on guest GET {path}: {r.status_code} {r.text[:200]}"
