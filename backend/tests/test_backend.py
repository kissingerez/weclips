"""Slate backend API tests - auth, subscription, videos, comments, likes."""
import os
import base64
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://weclips-preview.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def user_a(s):
    email = f"TEST_a_{uuid.uuid4().hex[:8]}@slate.app"
    r = s.post(f"{API}/auth/signup", json={"email": email, "password": "Password123!", "display_name": "TestA"})
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    return {"email": email, "password": "Password123!", "token": token, "h": {"Authorization": f"Bearer {token}"}}


@pytest.fixture(scope="module")
def user_b(s):
    email = f"TEST_b_{uuid.uuid4().hex[:8]}@slate.app"
    r = s.post(f"{API}/auth/signup", json={"email": email, "password": "Password123!", "display_name": "TestB"})
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    return {"email": email, "token": token, "h": {"Authorization": f"Bearer {token}"}}


# --- Health ---
def test_root(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


# --- Auth ---
def test_signup_duplicate(s, user_a):
    r = s.post(f"{API}/auth/signup", json={"email": user_a["email"], "password": "Password123!", "display_name": "Dup"})
    assert r.status_code == 400


def test_login_success(s, user_a):
    r = s.post(f"{API}/auth/login", json={"email": user_a["email"], "password": user_a["password"]})
    assert r.status_code == 200 and "access_token" in r.json()


def test_login_wrong_password(s, user_a):
    r = s.post(f"{API}/auth/login", json={"email": user_a["email"], "password": "wrong"})
    assert r.status_code == 401


def test_me_requires_auth(s):
    r = s.get(f"{API}/auth/me")
    assert r.status_code in (401, 403)


def test_me_returns_user(s, user_a):
    r = s.get(f"{API}/auth/me", headers=user_a["h"])
    assert r.status_code == 200
    d = r.json()
    assert d["email"] == user_a["email"]
    assert d["is_subscribed"] is False
    assert d["subscription_status"] == "none"
    assert "id" in d and "display_name" in d


# --- Subscription ---
def test_status_unsubscribed(s, user_a):
    r = s.get(f"{API}/subscription/status", headers=user_a["h"])
    assert r.status_code == 200 and r.json()["is_subscribed"] is False


def test_checkout_session(s, user_a):
    """With placeholder Stripe key, 500 is acceptable."""
    r = s.post(f"{API}/subscription/checkout-session", headers=user_a["h"])
    assert r.status_code in (200, 500)
    if r.status_code == 200:
        d = r.json()
        assert "checkout_url" in d and "session_id" in d


def test_upload_without_subscription_returns_402(s, user_a):
    payload = {
        "title": "TEST no sub",
        "description": "",
        "content_base64": base64.b64encode(b"hello-video").decode(),
        "mime_type": "video/mp4",
        "no_ai_confirmed": True,
    }
    r = s.post(f"{API}/videos", json=payload, headers=user_a["h"])
    assert r.status_code == 402


def test_dev_activate(s, user_a):
    r = s.post(f"{API}/subscription/dev-activate", headers=user_a["h"])
    assert r.status_code == 200
    d = r.json()
    assert d["is_subscribed"] is True
    assert d["subscription_status"] == "active"
    # Verify persistence via /me
    me = s.get(f"{API}/auth/me", headers=user_a["h"]).json()
    assert me["is_subscribed"] is True
    assert me["subscription_status"] == "active"


def test_status_after_activate(s, user_a):
    r = s.get(f"{API}/subscription/status", headers=user_a["h"])
    assert r.status_code == 200 and r.json()["is_subscribed"] is True


# --- Videos ---
def test_upload_no_ai_false_returns_400(s, user_a):
    payload = {
        "title": "TEST no_ai false",
        "content_base64": base64.b64encode(b"data").decode(),
        "no_ai_confirmed": False,
    }
    r = s.post(f"{API}/videos", json=payload, headers=user_a["h"])
    assert r.status_code == 400


@pytest.fixture(scope="module")
def created_video(s, user_a):
    payload = {
        "title": "TEST Sample Video",
        "description": "demo description with unique_kw_zxq",
        "content_base64": base64.b64encode(b"this-is-fake-video-bytes-but-valid-base64").decode(),
        "mime_type": "video/mp4",
        "no_ai_confirmed": True,
    }
    r = s.post(f"{API}/videos", json=payload, headers=user_a["h"])
    assert r.status_code == 200, r.text
    return r.json()


def test_upload_video_success(created_video, user_a):
    assert created_video["title"] == "TEST Sample Video"
    assert created_video["creator_name"] == "TestA"
    assert created_video["views"] == 0
    assert "id" in created_video


def test_list_feed(s, created_video):
    r = s.get(f"{API}/videos")
    assert r.status_code == 200
    items = r.json()
    assert any(v["id"] == created_video["id"] for v in items)


def test_search_videos(s, created_video):
    r = s.get(f"{API}/videos", params={"q": "unique_kw_zxq"})
    assert r.status_code == 200
    items = r.json()
    assert any(v["id"] == created_video["id"] for v in items)


def test_get_video_increments_views(s, created_video):
    vid = created_video["id"]
    r1 = s.get(f"{API}/videos/{vid}")
    assert r1.status_code == 200
    v1 = r1.json()
    r2 = s.get(f"{API}/videos/{vid}")
    v2 = r2.json()
    assert v2["views"] > v1["views"]


def test_stream_video(s, created_video):
    r = s.get(f"{API}/videos/{created_video['id']}/stream")
    assert r.status_code == 200
    assert len(r.content) > 0


def test_my_videos_requires_auth(s):
    r = s.get(f"{API}/videos/mine")
    assert r.status_code in (401, 403)


def test_my_videos(s, user_a, created_video):
    r = s.get(f"{API}/videos/mine", headers=user_a["h"])
    assert r.status_code == 200
    ids = [v["id"] for v in r.json()]
    assert created_video["id"] in ids


# --- Likes & Comments ---
def test_like_toggle(s, user_b, created_video):
    vid = created_video["id"]
    r1 = s.post(f"{API}/videos/{vid}/like", headers=user_b["h"])
    assert r1.status_code == 200 and r1.json()["liked"] is True
    r2 = s.post(f"{API}/videos/{vid}/like", headers=user_b["h"])
    assert r2.status_code == 200 and r2.json()["liked"] is False


def test_add_comment_and_list(s, user_b, created_video):
    vid = created_video["id"]
    r = s.post(f"{API}/videos/{vid}/comments", json={"text": "TEST nice video!"}, headers=user_b["h"])
    assert r.status_code == 200
    c = r.json()
    assert c["text"] == "TEST nice video!"
    assert c["user_name"] == "TestB"

    lr = s.get(f"{API}/videos/{vid}/comments")
    assert lr.status_code == 200
    assert any(x["id"] == c["id"] for x in lr.json())


def test_comment_requires_auth(s, created_video):
    r = s.post(f"{API}/videos/{created_video['id']}/comments", json={"text": "hi"})
    assert r.status_code in (401, 403)


def test_get_video_404(s):
    r = s.get(f"{API}/videos/nonexistent-id-xyz")
    assert r.status_code == 404
