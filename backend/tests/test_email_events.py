"""
Tests for SendGrid delivery-visibility wiring:
- POST /webhooks/sendgrid ingests event arrays (delivered/bounce/...) -> 200.
- GET /admin/email-events is founder-gated (401 without auth).
"""
import os
import requests

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or "https://weclips-preview.preview.emergentagent.com"
).rstrip("/")
API = f"{BASE_URL}/api"


def test_sendgrid_webhook_ingests_events():
    payload = [
        {
            "email": "someone@yahoo.com",
            "event": "bounce",
            "reason": "550 5.7.1 DMARC policy violation",
            "sg_message_id": "test-msg-1",
            "timestamp": 1718000000,
        },
        {"email": "someone@yahoo.com", "event": "delivered", "sg_message_id": "test-msg-2"},
    ]
    r = requests.post(f"{API}/webhooks/sendgrid", json=payload, timeout=30)
    assert r.status_code == 200, r.text[:200]
    body = r.json()
    assert body.get("received") == 2, body


def test_sendgrid_webhook_handles_single_object():
    r = requests.post(
        f"{API}/webhooks/sendgrid",
        json={"email": "x@x.com", "event": "dropped", "reason": "blocked"},
        timeout=30,
    )
    assert r.status_code == 200, r.text[:200]
    assert r.json().get("received") == 1


def test_admin_email_events_requires_auth():
    r = requests.get(f"{API}/admin/email-events", timeout=30)
    assert r.status_code == 401, f"{r.status_code} {r.text[:200]}"
