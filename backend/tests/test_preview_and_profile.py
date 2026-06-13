"""
Tests for the guest video preview + public-profile parity additions:
- GET /videos/{id}/preview-url returns a stream_url + preview_seconds for guests.
- GET /users/{id} now includes a `following` count (web-parity stat line).
- Subscribers can still get the full stream via /stream-url (regression).
"""
import os
import requests

BASE_URL = (
    os.environ.get("EXPO_BACKEND_URL")
    or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or "https://weclips-preview.preview.emergentagent.com"
).rstrip("/")
API = f"{BASE_URL}/api"

APPLE_EMAIL = "appletest@weclips.app"
APPLE_PASSWORD = "AppleReview2026!"
SAMPLE_USER_ID = "f4a60da3-4a82-4da7-924c-6c02cbf10887"
SAMPLE_VIDEO_ID = "24516610-e939-4374-97f7-93862c5848f7"


def test_guest_preview_url_returns_stream_and_seconds():
    r = requests.get(f"{API}/videos/{SAMPLE_VIDEO_ID}/preview-url", timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
    data = r.json()
    assert isinstance(data.get("stream_url"), str) and data["stream_url"], data
    assert isinstance(data.get("preview_seconds"), int) and data["preview_seconds"] > 0, data


def test_public_user_includes_following_count():
    r = requests.get(f"{API}/users/{SAMPLE_USER_ID}", timeout=30)
    assert r.status_code == 200, r.text[:200]
    data = r.json()
    assert "following" in data, data
    assert isinstance(data["following"], int)
    assert "followers" in data and isinstance(data["followers"], int)


def test_subscriber_full_stream_still_works():
    login = requests.post(
        f"{API}/auth/login",
        json={"email": APPLE_EMAIL, "password": APPLE_PASSWORD},
        timeout=30,
    )
    assert login.status_code == 200, login.text[:200]
    tok = login.json().get("access_token")
    assert tok
    r = requests.get(
        f"{API}/videos/{SAMPLE_VIDEO_ID}/stream-url",
        headers={"Authorization": f"Bearer {tok}"},
        timeout=30,
    )
    assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
    assert r.json().get("stream_url")
