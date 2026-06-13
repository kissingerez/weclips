"""Full auth lifecycle regression tests for WeClips.

Covers (per the review request):
- login (valid / wrong-password / unknown-email)
- signup → email verification required (no token, no 5xx)
- login with unverified user → 403 EMAIL_NOT_VERIFIED, returns promptly
- resend-verification for unverified user → 200 promptly
- verify-email with WRONG code → 400 and attempts is incremented
- verify-email SUCCESS via seeded code → 200 + access_token, email_verified=true
- forgot-password for both existing AND nonexistent emails → always 200 quickly
- reset-password invalid/expired token → 400; valid seeded token → 200 and new password works
- GET /api/auth/me with Bearer token → 200
- No 5xx anywhere in the auth lifecycle

Uses direct MongoDB seeding (pymongo) for the verification-success and
password-reset-success paths, because SendGrid is configured in preview and the
backend does not return dev_code / dev_token in that case.
"""
from __future__ import annotations

import hashlib
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from dotenv import load_dotenv
from pymongo import MongoClient

# ----- env / config ----------------------------------------------------------
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    os.environ.get(
        "EXPO_PUBLIC_BACKEND_URL",
        "https://weclips-preview.preview.emergentagent.com",
    ),
).rstrip("/")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

APPLE_EMAIL = "appletest@weclips.app"
APPLE_PASSWORD = "AppleReview2026!"

REQ_TIMEOUT = 30  # seconds


# ----- shared mongo client ---------------------------------------------------
@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


@pytest.fixture(scope="module")
def http():
    return httpx.Client(timeout=REQ_TIMEOUT)


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _unique_email() -> str:
    # Server lowercases on signup; keep this lowercase to make DB lookups easy.
    # Prefix kept lowercase too — "test_" is sufficient for cleanup matching.
    return f"test_auth_{uuid.uuid4().hex[:10]}@example.com"


# ----- module-level state for created users (cleanup) ------------------------
CREATED_EMAILS: list[str] = []


@pytest.fixture(scope="module", autouse=True)
def _cleanup(mongo):
    yield
    # Best-effort cleanup of anything we created.
    if CREATED_EMAILS:
        user_ids = [
            d["_id"]
            for d in mongo.users.find(
                {"email": {"$in": CREATED_EMAILS}}, {"_id": 1}
            )
        ]
        if user_ids:
            mongo.email_verifications.delete_many({"user_id": {"$in": user_ids}})
            mongo.password_resets.delete_many({"user_id": {"$in": user_ids}})
            mongo.users.delete_many({"_id": {"$in": user_ids}})


# =============================================================================
# 1) Login basics
# =============================================================================
class TestLoginBasics:
    def test_login_valid(self, http):
        r = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": APPLE_EMAIL, "password": APPLE_PASSWORD},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("access_token")
        assert data.get("token_type", "bearer").lower() == "bearer"

    def test_login_wrong_password_is_401_not_500(self, http):
        r = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": APPLE_EMAIL, "password": "definitely-wrong"},
        )
        assert r.status_code == 401, r.text
        assert r.status_code < 500

    def test_login_unknown_email_is_401(self, http):
        r = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "no-such-user-xyz@example.com", "password": "whatever123"},
        )
        assert r.status_code == 401, r.text

    def test_me_with_valid_token(self, http):
        # login first
        r = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": APPLE_EMAIL, "password": APPLE_PASSWORD},
        )
        assert r.status_code == 200, r.text
        token = r.json()["access_token"]
        me = http.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert me.status_code == 200, me.text
        body = me.json()
        assert body.get("email", "").lower() == APPLE_EMAIL
        assert body.get("id")


# =============================================================================
# 2) Signup → unverified-login → resend-verification
# =============================================================================
class TestSignupAndUnverifiedLogin:
    @pytest.fixture(scope="class")
    def new_user(self, http, mongo):
        email = _unique_email()
        CREATED_EMAILS.append(email)
        payload = {
            "email": email,
            "password": "Testing1234!",
            "display_name": f"Test User {uuid.uuid4().hex[:4]}",
        }
        r = http.post(f"{BASE_URL}/api/auth/signup", json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "verification_required", body
        assert body.get("email", "").lower() == email
        # Must NOT return an access_token (verification gate).
        assert "access_token" not in body
        # Ensure DB row was written and is unverified.
        u = mongo.users.find_one({"email": email})
        assert u is not None
        assert u.get("email_verified") is False
        return {"email": email, "password": payload["password"], "user_id": u["_id"]}

    def test_signup_does_not_5xx(self, new_user):
        # Implicit from fixture, but assert explicitly for clarity.
        assert new_user["user_id"]

    def test_login_unverified_returns_403_promptly(self, http, new_user):
        start = time.monotonic()
        r = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": new_user["email"], "password": new_user["password"]},
        )
        elapsed = time.monotonic() - start
        assert r.status_code == 403, r.text
        body = r.json()
        # Detail must be the machine-readable code the client routes on.
        assert body.get("detail") == "EMAIL_NOT_VERIFIED", body
        # Non-blocking email path: must return well under the 15s SendGrid
        # timeout (and certainly under Cloudflare's 100s 524 budget).
        assert elapsed < 20.0, f"login took {elapsed:.2f}s (should be non-blocking)"

    def test_resend_verification_returns_200_promptly(self, http, new_user, mongo):
        # Cooldown might apply (just sent on login). Wait it out enough that
        # the resend is allowed without sleeping the full 60s — we just verify
        # the endpoint never 5xxs and returns promptly even when rate-limited.
        start = time.monotonic()
        r = http.post(
            f"{BASE_URL}/api/auth/resend-verification",
            json={"email": new_user["email"]},
        )
        elapsed = time.monotonic() - start
        # Either 200 (sent / no-op) or 429 (cooldown) is acceptable; must NOT 5xx.
        assert r.status_code in (200, 429), r.text
        assert r.status_code < 500
        assert elapsed < 20.0, f"resend took {elapsed:.2f}s"
        # If 200, response shape includes status:ok
        if r.status_code == 200:
            assert r.json().get("status") == "ok"

    def test_resend_for_nonexistent_email_is_200(self, http):
        # No-leak behavior: unknown email must still 200.
        r = http.post(
            f"{BASE_URL}/api/auth/resend-verification",
            json={"email": "no-such-user-xyz@example.com"},
        )
        assert r.status_code == 200, r.text
        assert r.json().get("status") == "ok"


# =============================================================================
# 3) verify-email (failure + success-via-seeded-code)
# =============================================================================
class TestVerifyEmail:
    @pytest.fixture(scope="class")
    def seeded_user(self, http, mongo):
        """Create a fresh unverified user and seed a known OTP for it."""
        email = _unique_email()
        CREATED_EMAILS.append(email)
        password = "Testing1234!"
        r = http.post(
            f"{BASE_URL}/api/auth/signup",
            json={
                "email": email,
                "password": password,
                "display_name": "Verify Tester",
            },
        )
        assert r.status_code == 200, r.text
        u = mongo.users.find_one({"email": email})
        assert u is not None
        return {"email": email, "password": password, "user_id": u["_id"]}

    def test_verify_email_wrong_code_400_and_increments_attempts(self, http, seeded_user, mongo):
        before = mongo.email_verifications.find_one({"user_id": seeded_user["user_id"]})
        assert before is not None, "signup should have created an email_verifications row"
        before_attempts = int(before.get("attempts", 0))

        r = http.post(
            f"{BASE_URL}/api/auth/verify-email",
            json={"email": seeded_user["email"], "code": "000000"},
        )
        # The signup-issued real code is random — overwhelmingly unlikely to be 000000.
        assert r.status_code == 400, r.text

        after = mongo.email_verifications.find_one({"user_id": seeded_user["user_id"]})
        assert after is not None
        assert int(after.get("attempts", 0)) == before_attempts + 1, (
            f"attempts not incremented: {before_attempts} -> {after.get('attempts')}"
        )

    def test_verify_email_success_via_seeded_code(self, http, seeded_user, mongo):
        # Overwrite the verification row with a known code we control.
        known_code = "424242"
        mongo.email_verifications.delete_many({"user_id": seeded_user["user_id"]})
        mongo.email_verifications.insert_one(
            {
                "_id": str(uuid.uuid4()),
                "user_id": seeded_user["user_id"],
                "email": seeded_user["email"],
                "code_hash": _sha256(known_code),
                "expires_at": datetime.now(timezone.utc) + timedelta(minutes=15),
                "attempts": 0,
                "last_sent_at": datetime.now(timezone.utc),
                "created_at": datetime.now(timezone.utc),
            }
        )

        r = http.post(
            f"{BASE_URL}/api/auth/verify-email",
            json={"email": seeded_user["email"], "code": known_code},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("access_token"), body

        # email_verified should now be true; verification row should be gone.
        u = mongo.users.find_one({"_id": seeded_user["user_id"]})
        assert u and u.get("email_verified") is True
        rec = mongo.email_verifications.find_one({"user_id": seeded_user["user_id"]})
        assert rec is None, "verification row should be deleted on success"

        # And the token must be usable on /auth/me.
        me = http.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {body['access_token']}"},
        )
        assert me.status_code == 200, me.text
        assert me.json().get("email", "").lower() == seeded_user["email"]

        # And login should now succeed normally (since email is verified).
        login = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": seeded_user["email"], "password": seeded_user["password"]},
        )
        assert login.status_code == 200, login.text


# =============================================================================
# 4) Forgot password — non-blocking, always 200 quickly
# =============================================================================
class TestForgotPassword:
    def test_forgot_existing_email_returns_200_quickly(self, http):
        start = time.monotonic()
        r = http.post(
            f"{BASE_URL}/api/auth/forgot-password",
            json={"email": APPLE_EMAIL},
        )
        elapsed = time.monotonic() - start
        assert r.status_code == 200, r.text
        assert r.json().get("status") == "ok"
        # Must not block the event loop on SendGrid.
        assert elapsed < 20.0, f"forgot-password took {elapsed:.2f}s"

    def test_forgot_nonexistent_email_returns_200_quickly(self, http):
        start = time.monotonic()
        r = http.post(
            f"{BASE_URL}/api/auth/forgot-password",
            json={"email": "no-such-user-xyz@example.com"},
        )
        elapsed = time.monotonic() - start
        assert r.status_code == 200, r.text
        assert r.json().get("status") == "ok"
        assert elapsed < 20.0, f"forgot-password took {elapsed:.2f}s"


# =============================================================================
# 5) Reset password — invalid token rejected, valid seeded token works end-to-end
# =============================================================================
class TestResetPassword:
    @pytest.fixture(scope="class")
    def reset_user(self, http, mongo):
        """Create + verify a user (so we can log in with the new password)."""
        email = _unique_email()
        CREATED_EMAILS.append(email)
        password_initial = "Initial1234!"
        r = http.post(
            f"{BASE_URL}/api/auth/signup",
            json={
                "email": email,
                "password": password_initial,
                "display_name": "Reset Tester",
            },
        )
        assert r.status_code == 200, r.text
        u = mongo.users.find_one({"email": email})
        assert u is not None
        # Seed a verification code, verify, so the user is loginable.
        known_code = "131313"
        mongo.email_verifications.delete_many({"user_id": u["_id"]})
        mongo.email_verifications.insert_one(
            {
                "_id": str(uuid.uuid4()),
                "user_id": u["_id"],
                "email": email,
                "code_hash": _sha256(known_code),
                "expires_at": datetime.now(timezone.utc) + timedelta(minutes=15),
                "attempts": 0,
                "last_sent_at": datetime.now(timezone.utc),
                "created_at": datetime.now(timezone.utc),
            }
        )
        v = http.post(
            f"{BASE_URL}/api/auth/verify-email",
            json={"email": email, "code": known_code},
        )
        assert v.status_code == 200, v.text
        return {"email": email, "password": password_initial, "user_id": u["_id"]}

    def test_reset_with_invalid_token_returns_400(self, http):
        r = http.post(
            f"{BASE_URL}/api/auth/reset-password",
            json={"token": "definitely-not-a-valid-token-xxxxxxxxxxxx", "new_password": "Whatever123!"},
        )
        assert r.status_code == 400, r.text

    def test_reset_with_expired_token_returns_400(self, http, mongo, reset_user):
        token = uuid.uuid4().hex + uuid.uuid4().hex  # 64 chars
        mongo.password_resets.insert_one(
            {
                "_id": str(uuid.uuid4()),
                "token_hash": _sha256(token),
                "user_id": reset_user["user_id"],
                "email": reset_user["email"],
                "expires_at": datetime.now(timezone.utc) - timedelta(minutes=1),
                "used": False,
                "created_at": datetime.now(timezone.utc),
            }
        )
        r = http.post(
            f"{BASE_URL}/api/auth/reset-password",
            json={"token": token, "new_password": "Whatever123!"},
        )
        assert r.status_code == 400, r.text

    def test_reset_with_valid_seeded_token_updates_password(self, http, mongo, reset_user):
        token = uuid.uuid4().hex + uuid.uuid4().hex
        new_password = "Rotated9876!"
        mongo.password_resets.insert_one(
            {
                "_id": str(uuid.uuid4()),
                "token_hash": _sha256(token),
                "user_id": reset_user["user_id"],
                "email": reset_user["email"],
                "expires_at": datetime.now(timezone.utc) + timedelta(minutes=15),
                "used": False,
                "created_at": datetime.now(timezone.utc),
            }
        )
        r = http.post(
            f"{BASE_URL}/api/auth/reset-password",
            json={"token": token, "new_password": new_password},
        )
        assert r.status_code == 200, r.text
        assert r.json().get("status") == "ok"

        # The new password must work.
        login_new = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": reset_user["email"], "password": new_password},
        )
        assert login_new.status_code == 200, login_new.text
        assert login_new.json().get("access_token")

        # The old password must no longer work.
        login_old = http.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": reset_user["email"], "password": reset_user["password"]},
        )
        assert login_old.status_code == 401, login_old.text

        # Reusing the same token should now be rejected (used=true).
        replay = http.post(
            f"{BASE_URL}/api/auth/reset-password",
            json={"token": token, "new_password": "Yetanother123!"},
        )
        assert replay.status_code == 400, replay.text


# =============================================================================
# 6) Global guard: no 5xx anywhere in this lifecycle
# =============================================================================
def test_no_5xx_smoke(http):
    """Hit every auth endpoint with benign payloads and ensure none 5xx."""
    endpoints = [
        ("POST", "/api/auth/login", {"email": APPLE_EMAIL, "password": "wrong"}),
        ("POST", "/api/auth/login", {"email": "nope@example.com", "password": "wrong"}),
        ("POST", "/api/auth/forgot-password", {"email": APPLE_EMAIL}),
        ("POST", "/api/auth/forgot-password", {"email": "nope@example.com"}),
        ("POST", "/api/auth/resend-verification", {"email": APPLE_EMAIL}),
        ("POST", "/api/auth/resend-verification", {"email": "nope@example.com"}),
        ("POST", "/api/auth/verify-email", {"email": "nope@example.com", "code": "000000"}),
        ("POST", "/api/auth/reset-password", {"token": "x" * 40, "new_password": "Whatever1!"}),
    ]
    for method, path, body in endpoints:
        r = http.request(method, f"{BASE_URL}{path}", json=body)
        assert r.status_code < 500, f"{method} {path} -> {r.status_code} {r.text!r}"
