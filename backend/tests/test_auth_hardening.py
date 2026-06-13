"""Regression tests for the auth hardening fixes:
- Reset password links must use https://weclips.app (APP_PUBLIC_URL), not the old domain.
- Login must never 500 (wrong password -> 401; missing password_hash handled defensively).
- forgot-password is non-blocking and always returns 200 (no origin 5xx).
"""
import os
import httpx
import pytest

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL", "https://weclips-preview.preview.emergentagent.com"
).rstrip("/")

APPLE_EMAIL = "appletest@weclips.app"
APPLE_PASSWORD = "AppleReview2026!"


def test_app_public_url_is_weclips():
    # The reset email base URL must point at the production web domain.
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    base = os.environ.get("APP_PUBLIC_URL", "")
    assert base.rstrip("/") == "https://weclips.app", f"APP_PUBLIC_URL={base!r}"


def test_login_valid():
    r = httpx.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": APPLE_EMAIL, "password": APPLE_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("access_token")


def test_login_wrong_password_is_401_not_500():
    r = httpx.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": APPLE_EMAIL, "password": "definitely-wrong"},
        timeout=30,
    )
    assert r.status_code == 401, r.text


def test_login_unknown_email_is_401():
    r = httpx.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "no-such-user-xyz@example.com", "password": "whatever123"},
        timeout=30,
    )
    assert r.status_code == 401, r.text


def test_forgot_password_nonexistent_returns_200_quickly():
    # Non-blocking email path: must return promptly and never 5xx.
    r = httpx.post(
        f"{BASE_URL}/api/auth/forgot-password",
        json={"email": "no-such-user-xyz@example.com"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("status") == "ok"
