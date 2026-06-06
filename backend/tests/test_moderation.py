"""WeClips founder moderation pipeline tests.

Covers: report creation -> founder notification deep-link fields, admin
report enrichment, summary, dismiss, warn, suspend (7d/30d), permanent
ban, unban, delete-content, banned-accounts listing, /api/users/{id}
privacy guard, and require_founder authorization.
"""
import base64
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://ad-free-video-12.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "slate_db")

POLICY_PARAGRAPH = (
    "We aim to create a fun environment at WeClips. Repeated violations to "
    "our policies may result in temporary or permanent deletion of your account."
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _signup(email_prefix: str, display: str) -> dict:
    email = f"TEST_{email_prefix}_{uuid.uuid4().hex[:8]}@weclips.app"
    r = requests.post(
        f"{API}/auth/signup",
        json={"email": email, "password": "Password123!", "display_name": display},
        timeout=30,
    )
    assert r.status_code == 200, f"signup failed: {r.status_code} {r.text}"
    tok = r.json()["access_token"]
    me = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {tok}"}).json()
    return {
        "id": me["id"],
        "email": email,
        "token": tok,
        "h": {"Authorization": f"Bearer {tok}"},
        "display": display,
    }


@pytest.fixture(scope="module")
def founder(mongo):
    """Sign up a fresh user, elevate to founder via Mongo."""
    f = _signup("founder", "FounderMod")
    res = mongo["users"].update_one({"_id": f["id"]}, {"$set": {"is_founder": True}})
    assert res.matched_count == 1
    # Verify via /auth/me
    me = requests.get(f"{API}/auth/me", headers=f["h"]).json()
    assert me.get("is_founder") is True
    return f


@pytest.fixture(scope="module")
def uploader():
    """Subscribed creator who uploads the video being reported."""
    u = _signup("uploader", "UploaderUser")
    r = requests.post(f"{API}/subscription/dev-activate", headers=u["h"])
    assert r.status_code == 200, r.text
    return u


@pytest.fixture(scope="module")
def reporter():
    return _signup("reporter", "ReporterUser")


@pytest.fixture(scope="module")
def bystander():
    """Non-founder, non-target observer used to validate privacy guard."""
    return _signup("bystander", "BystanderUser")


@pytest.fixture(scope="module")
def uploaded_video(uploader) -> dict:
    """Upload a video via multipart form-data."""
    files = {
        "file": ("clip.mp4", b"fake-bytes-for-mod-test", "video/mp4"),
    }
    data = {
        "title": "TEST Moderation Video",
        "description": "moderation pipeline test",
        "mime_type": "video/mp4",
        "no_ai_confirmed": "true",
    }
    r = requests.post(
        f"{API}/videos", data=data, files=files, headers=uploader["h"]
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def cleanup_at_end(mongo, founder, uploader, reporter, bystander):
    yield
    # Best-effort teardown
    ids = [founder["id"], uploader["id"], reporter["id"], bystander["id"]]
    mongo["users"].delete_many({"_id": {"$in": ids}})
    mongo["reports"].delete_many({"reporter_id": {"$in": ids}})
    mongo["notifications"].delete_many({"recipient_id": {"$in": ids}})
    mongo["videos"].delete_many({"user_id": {"$in": ids}})


# ---------------------------------------------------------------------------
# Report creation -> founder notification deep-link
# ---------------------------------------------------------------------------
def _latest_report_notifications(founder_h):
    r = requests.get(f"{API}/notifications?limit=50", headers=founder_h)
    assert r.status_code == 200, r.text
    return [n for n in r.json() if n["type"] == "report"]


def test_report_video_creates_notification_with_deep_link(
    founder, uploader, reporter, uploaded_video
):
    """POST /api/videos/{id}/report -> founder bell gets a 'report' notification
    with report_id + report_target_type."""
    vid = uploaded_video["id"]
    r = requests.post(
        f"{API}/videos/{vid}/report",
        json={"reason": "TEST inappropriate content"},
        headers=reporter["h"],
    )
    assert r.status_code == 200, r.text

    notifs = _latest_report_notifications(founder["h"])
    # find the most recent notification pointing at the just-reported video
    match = next((n for n in notifs if n.get("video_id") == vid), None)
    assert match is not None, "founder did not receive a 'report' notification for the video"
    assert match["type"] == "report"
    assert match["report_target_type"] == "video"
    assert match["report_id"]  # must be present and truthy
    assert match["actor_id"] == reporter["id"]
    # text must reference the reported target
    assert "video" in (match.get("text") or "").lower()


def test_report_user_creates_notification_with_deep_link(founder, uploader, reporter):
    r = requests.post(
        f"{API}/users/{uploader['id']}/report",
        json={"reason": "TEST harassing other users"},
        headers=reporter["h"],
    )
    assert r.status_code == 200, r.text

    notifs = _latest_report_notifications(founder["h"])
    match = next(
        (n for n in notifs if n.get("report_target_type") == "user"),
        None,
    )
    assert match is not None, "founder did not receive a user-type report notification"
    assert match["report_id"]
    assert match["actor_id"] == reporter["id"]


def test_report_self_rejected(reporter):
    r = requests.post(
        f"{API}/users/{reporter['id']}/report",
        json={"reason": "TEST self"},
        headers=reporter["h"],
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Admin reports listing + summary + authorization
# ---------------------------------------------------------------------------
def test_require_founder_blocks_non_founder(reporter):
    r = requests.get(f"{API}/admin/reports?status=open", headers=reporter["h"])
    assert r.status_code == 403
    assert "founder" in r.json().get("detail", "").lower()


def test_admin_summary_returns_open_count(founder):
    r = requests.get(f"{API}/admin/reports/summary", headers=founder["h"])
    assert r.status_code == 200
    data = r.json()
    assert "open" in data and isinstance(data["open"], int)
    assert data["open"] >= 2  # at least the two we just filed


def test_list_open_reports_enriched(founder, uploader, uploaded_video):
    r = requests.get(f"{API}/admin/reports?status=open", headers=founder["h"])
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) >= 2

    # Find video report
    vrow = next(
        (x for x in rows if x["target_type"] == "video" and x["target_id"] == uploaded_video["id"]),
        None,
    )
    assert vrow is not None, "video report missing from admin list"
    # Enriched fields
    for key in (
        "target_warnings_count",
        "target_is_banned",
        "target_ban_type",
        "target_banned_until",
    ):
        assert key in vrow, f"missing enrichment key: {key}"
    assert vrow["target_user_id"] == uploader["id"]
    assert vrow["target_is_banned"] is False
    assert vrow["target_warnings_count"] == 0
    assert vrow["video_title"] == "TEST Moderation Video"

    urow = next(
        (x for x in rows if x["target_type"] == "user" and x["target_id"] == uploader["id"]),
        None,
    )
    assert urow is not None, "user report missing from admin list"
    assert urow["target_user_id"] == uploader["id"]


# ---------------------------------------------------------------------------
# Helper: create a fresh open report against uploader for action tests
# ---------------------------------------------------------------------------
def _open_user_report_against(uploader_id: str, reporter_h: dict) -> str:
    r = requests.post(
        f"{API}/users/{uploader_id}/report",
        json={"reason": "TEST action target"},
        headers=reporter_h,
    )
    assert r.status_code == 200
    # fetch latest open report against this user
    return None  # we'll fetch via admin


def _latest_open_report_id(founder_h, target_type: str, target_id: str) -> str:
    r = requests.get(f"{API}/admin/reports?status=open", headers=founder_h)
    assert r.status_code == 200
    rows = r.json()
    matches = [
        x
        for x in rows
        if x["target_type"] == target_type and x["target_id"] == target_id
    ]
    assert matches, f"no open report for {target_type}:{target_id}"
    return matches[0]["id"]


# ---------------------------------------------------------------------------
# Dismiss
# ---------------------------------------------------------------------------
def test_dismiss_report(founder, reporter, uploader):
    requests.post(
        f"{API}/users/{uploader['id']}/report",
        json={"reason": "TEST to dismiss"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "user", uploader["id"])
    r = requests.post(f"{API}/admin/reports/{rid}/dismiss", headers=founder["h"])
    assert r.status_code == 200
    # Non-founder can't dismiss
    r2 = requests.post(f"{API}/admin/reports/{rid}/dismiss", headers=reporter["h"])
    assert r2.status_code == 403


# ---------------------------------------------------------------------------
# Warn
# ---------------------------------------------------------------------------
def test_warn_target_increments_warnings_and_sends_policy_text(
    founder, mongo, reporter, uploader
):
    # File a new report so we have an open one to resolve
    requests.post(
        f"{API}/users/{uploader['id']}/report",
        json={"reason": "TEST warn target"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "user", uploader["id"])

    before = mongo["users"].find_one({"_id": uploader["id"]}, {"warnings_count": 1})
    before_count = int((before or {}).get("warnings_count") or 0)

    r = requests.post(
        f"{API}/admin/reports/{rid}/warn",
        json={"reason": "TEST warn reason"},
        headers=founder["h"],
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["warnings_count"] == before_count + 1

    # Report resolved
    after_db = mongo["reports"].find_one({"_id": rid})
    assert after_db["status"] == "resolved"
    assert after_db["resolution"] == "warned"

    # Target received a notification containing the policy paragraph
    notifs = requests.get(f"{API}/notifications", headers=uploader["h"]).json()
    warn = next((n for n in notifs if n["type"] == "warning"), None)
    assert warn is not None, "target did not receive 'warning' notification"
    assert POLICY_PARAGRAPH in (warn.get("text") or "")


# ---------------------------------------------------------------------------
# Suspend 7d (temporary)
# ---------------------------------------------------------------------------
def test_suspend_7d_bans_target_and_403s_protected_endpoints(
    founder, mongo, reporter, uploader
):
    requests.post(
        f"{API}/users/{uploader['id']}/report",
        json={"reason": "TEST suspend target"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "user", uploader["id"])

    r = requests.post(
        f"{API}/admin/reports/{rid}/suspend",
        json={"days": 7, "reason": "TEST 7d susp"},
        headers=founder["h"],
    )
    assert r.status_code == 200, r.text
    until = r.json()["banned_until"]
    assert until  # ISO timestamp

    # DB state
    u = mongo["users"].find_one({"_id": uploader["id"]})
    assert u["is_banned"] is True
    assert u["ban_type"] == "temporary"
    assert u["banned_until"] is not None

    # Banned user gets 403 on protected endpoint (videos/mine)
    r2 = requests.get(f"{API}/videos/mine", headers=uploader["h"])
    assert r2.status_code == 403
    body = r2.json()
    detail = body.get("detail")
    if isinstance(detail, dict):
        assert detail.get("code") == "account_banned"
        assert detail.get("ban_type") == "temporary"

    # /auth/me still works
    r3 = requests.get(f"{API}/auth/me", headers=uploader["h"])
    assert r3.status_code == 200
    me = r3.json()
    assert me.get("is_banned") is True
    assert me.get("ban_type") == "temporary"
    assert me.get("banned_until")


# ---------------------------------------------------------------------------
# Unban
# ---------------------------------------------------------------------------
def test_unban_clears_ban_state(founder, mongo, uploader):
    r = requests.post(
        f"{API}/admin/users/{uploader['id']}/unban", headers=founder["h"]
    )
    assert r.status_code == 200

    u = mongo["users"].find_one({"_id": uploader["id"]})
    assert u.get("is_banned") in (False, None)
    assert u.get("banned_until") is None
    assert u.get("ban_type") is None

    # Protected endpoint works again
    r2 = requests.get(f"{API}/videos/mine", headers=uploader["h"])
    assert r2.status_code == 200


# ---------------------------------------------------------------------------
# Suspend 30d and auto-expiry
# ---------------------------------------------------------------------------
def test_suspend_30d_and_auto_expiry_on_get_current_user(
    founder, mongo, reporter, uploader
):
    requests.post(
        f"{API}/users/{uploader['id']}/report",
        json={"reason": "TEST 30d"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "user", uploader["id"])
    r = requests.post(
        f"{API}/admin/reports/{rid}/suspend",
        json={"days": 30, "reason": "TEST 30d"},
        headers=founder["h"],
    )
    assert r.status_code == 200
    u = mongo["users"].find_one({"_id": uploader["id"]})
    assert u["ban_type"] == "temporary"
    now = datetime.now(timezone.utc)
    delta = u["banned_until"].replace(tzinfo=timezone.utc) - now
    assert 29 * 86400 < delta.total_seconds() < 31 * 86400

    # Force-expire ban by setting banned_until to the past
    mongo["users"].update_one(
        {"_id": uploader["id"]},
        {"$set": {"banned_until": datetime.now(timezone.utc) - timedelta(minutes=1)}},
    )
    # Now /auth/me should auto-clear and return is_banned=false
    me = requests.get(f"{API}/auth/me", headers=uploader["h"]).json()
    assert me.get("is_banned") is False
    # And protected endpoints accessible
    r2 = requests.get(f"{API}/videos/mine", headers=uploader["h"])
    assert r2.status_code == 200


# ---------------------------------------------------------------------------
# Permanent ban
# ---------------------------------------------------------------------------
def test_permanent_ban(founder, mongo, reporter, uploader):
    requests.post(
        f"{API}/users/{uploader['id']}/report",
        json={"reason": "TEST perma"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "user", uploader["id"])
    r = requests.post(
        f"{API}/admin/reports/{rid}/ban",
        json={"reason": "TEST perma reason"},
        headers=founder["h"],
    )
    assert r.status_code == 200

    u = mongo["users"].find_one({"_id": uploader["id"]})
    assert u["is_banned"] is True
    assert u["ban_type"] == "permanent"
    assert u.get("banned_until") in (None,)

    # 403 on protected
    r2 = requests.get(f"{API}/videos/mine", headers=uploader["h"])
    assert r2.status_code == 403

    # Notification received (read directly from mongo since banned user can't fetch /notifications)
    n = next(
        iter(
            list(
                __import__("pymongo").MongoClient(MONGO_URL)[DB_NAME]["notifications"].find(
                    {"recipient_id": uploader["id"], "type": "banned"}
                )
            )
        ),
        None,
    )
    # Fallback: query via the shared mongo client
    from pymongo import MongoClient as _MC
    _db = _MC(MONGO_URL)[DB_NAME]
    docs = list(_db["notifications"].find({"recipient_id": uploader["id"], "type": "banned"}))
    assert docs, "target user should have received a 'banned' notification"


# ---------------------------------------------------------------------------
# Banned-accounts listing
# ---------------------------------------------------------------------------
def test_banned_accounts_lists_currently_banned(founder, uploader):
    r = requests.get(f"{API}/admin/banned-accounts", headers=founder["h"])
    assert r.status_code == 200, r.text
    rows = r.json()
    match = next((u for u in rows if u["id"] == uploader["id"]), None)
    assert match is not None, "permanently banned user missing from listing"
    assert match["ban_type"] == "permanent"
    assert match["banned_until"] is None
    assert match["display_name"]


def test_banned_accounts_requires_founder(reporter):
    r = requests.get(f"{API}/admin/banned-accounts", headers=reporter["h"])
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Privacy guard on /api/users/{id}
# ---------------------------------------------------------------------------
def test_user_profile_hides_moderation_fields_from_non_founder(
    bystander, uploader
):
    r = requests.get(f"{API}/users/{uploader['id']}", headers=bystander["h"])
    assert r.status_code == 200
    data = r.json()
    # Non-founder must see is_banned=False/None and no real ban info
    assert data.get("is_banned") in (False, None)
    assert data.get("ban_type") in (None, "")
    assert data.get("banned_until") in (None, "")
    assert data.get("ban_reason") in (None, "")
    assert data.get("warnings_count") in (0, None)


def test_user_profile_exposes_moderation_fields_to_founder(founder, uploader):
    r = requests.get(f"{API}/users/{uploader['id']}", headers=founder["h"])
    assert r.status_code == 200
    data = r.json()
    assert data.get("is_banned") is True
    assert data.get("ban_type") == "permanent"
    assert data.get("warnings_count", 0) >= 1


# ---------------------------------------------------------------------------
# Unban again to allow video tests next
# ---------------------------------------------------------------------------
def test_unban_round_two(founder, mongo, uploader):
    r = requests.post(f"{API}/admin/users/{uploader['id']}/unban", headers=founder["h"])
    assert r.status_code == 200
    u = mongo["users"].find_one({"_id": uploader["id"]})
    assert u.get("is_banned") in (False, None)


# ---------------------------------------------------------------------------
# Delete content (video reports only)
# ---------------------------------------------------------------------------
def test_delete_content_removes_video_and_resolves_report(
    founder, mongo, reporter, uploader, uploaded_video
):
    vid = uploaded_video["id"]
    # File a fresh open report on the video
    requests.post(
        f"{API}/videos/{vid}/report",
        json={"reason": "TEST delete content"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "video", vid)

    r = requests.post(
        f"{API}/admin/reports/{rid}/delete-content", headers=founder["h"]
    )
    assert r.status_code == 200

    # Video must be gone from DB
    assert mongo["videos"].find_one({"_id": vid}) is None

    # Comments must be removed
    assert mongo["comments"].count_documents({"video_id": vid}) == 0


def test_delete_content_user_report_is_noop_but_resolves(
    founder, reporter, uploader, mongo
):
    """For user-type reports, delete-content must NOT remove the account,
    but should resolve the report."""
    requests.post(
        f"{API}/users/{uploader['id']}/report",
        json={"reason": "TEST user delete"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "user", uploader["id"])
    r = requests.post(
        f"{API}/admin/reports/{rid}/delete-content", headers=founder["h"]
    )
    assert r.status_code == 200
    # User must still exist
    assert mongo["users"].find_one({"_id": uploader["id"]}) is not None
    # Report resolved
    rep = mongo["reports"].find_one({"_id": rid})
    assert rep["status"] == "resolved"


# ---------------------------------------------------------------------------
# Founder/self target guards
# ---------------------------------------------------------------------------
def test_cannot_warn_founder(founder, reporter, mongo):
    """File a report against the founder and ensure warn/suspend/ban refuse."""
    # File user-report against founder
    requests.post(
        f"{API}/users/{founder['id']}/report",
        json={"reason": "TEST against founder"},
        headers=reporter["h"],
    )
    rid = _latest_open_report_id(founder["h"], "user", founder["id"])

    r1 = requests.post(
        f"{API}/admin/reports/{rid}/warn",
        json={"reason": "x"},
        headers=founder["h"],
    )
    assert r1.status_code == 400
    r2 = requests.post(
        f"{API}/admin/reports/{rid}/suspend",
        json={"days": 7, "reason": "x"},
        headers=founder["h"],
    )
    assert r2.status_code == 400
    r3 = requests.post(
        f"{API}/admin/reports/{rid}/ban",
        json={"reason": "x"},
        headers=founder["h"],
    )
    assert r3.status_code == 400


def test_admin_endpoints_require_founder_403(reporter):
    """Sanity sweep of /api/admin/* with non-founder token."""
    endpoints = [
        ("GET", "/admin/reports/summary"),
        ("GET", "/admin/reports?status=open"),
        ("GET", "/admin/banned-accounts"),
    ]
    for method, path in endpoints:
        r = requests.request(method, f"{API}{path}", headers=reporter["h"])
        assert r.status_code == 403, f"{method} {path} expected 403 got {r.status_code}"
        assert "founder" in r.json().get("detail", "").lower()
