"""
Guards the "nobody keeps premium forever" rule:
_subscription_active() must return True only when is_subscribed AND the stored
expiry is in the future. A stored 'subscribed' flag with no/past expiry must be
treated as expired (covers the old dev/test grants and any missed webhook).
"""
import sys
from datetime import timedelta

sys.argv = ["pytest"]
import server  # noqa: E402
from server import _subscription_active, now_utc  # noqa: E402


def test_not_subscribed_is_inactive():
    assert _subscription_active({"is_subscribed": False}) is False


def test_subscribed_without_expiry_is_inactive():
    assert _subscription_active({"is_subscribed": True}) is False


def test_subscribed_future_expiry_is_active():
    exp = now_utc() + timedelta(days=15)
    assert _subscription_active({"is_subscribed": True, "subscription_expires_at": exp}) is True


def test_subscribed_past_expiry_is_inactive():
    exp = now_utc() - timedelta(days=1)
    assert _subscription_active({"is_subscribed": True, "subscription_expires_at": exp}) is False


def test_iso_string_expiry_supported():
    exp = (now_utc() + timedelta(days=5)).isoformat()
    assert _subscription_active({"is_subscribed": True, "subscription_expires_at": exp}) is True


def test_naive_past_datetime_is_inactive():
    exp = (now_utc() - timedelta(days=2)).replace(tzinfo=None)
    assert _subscription_active({"is_subscribed": True, "subscription_expires_at": exp}) is False
