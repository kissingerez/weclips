"""One-off: create/refresh the Google Play review demo account.

Mirrors the Apple review account: email-verified, with an active subscription
that carries a BOUNDED future expiry (not forever) so reviewers can access
premium features without going through a live purchase.
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

EMAIL = "googletest@weclips.app"
PASSWORD = "GoogleReview2026!"
USERNAME = "googlereview"
DISPLAY = "Google Review"
EXPIRES = datetime(2027, 6, 8, tzinfo=timezone.utc)


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    users = db["users"]

    existing = await users.find_one({"email": EMAIL})
    fields = {
        "email": EMAIL,
        "password_hash": pwd_context.hash(PASSWORD),
        "display_name": DISPLAY,
        "username": USERNAME,
        "is_subscribed": True,
        "subscription_status": "active",
        "subscription_expires_at": EXPIRES,
        "rc_last_event": None,
        "rc_environment": "review",
        "email_verified": True,
    }
    if existing:
        await users.update_one({"_id": existing["_id"]}, {"$set": fields})
        print(f"Updated existing account {EMAIL} (id={existing['_id']})")
    else:
        doc = {"_id": str(uuid.uuid4()), "created_at": datetime.now(timezone.utc), **fields}
        await users.insert_one(doc)
        print(f"Created account {EMAIL} (id={doc['_id']})")

    u = await users.find_one({"email": EMAIL}, {"password_hash": 0})
    print("Verify:", {k: u.get(k) for k in ["email", "username", "is_subscribed", "subscription_status", "subscription_expires_at", "email_verified"]})
    client.close()


asyncio.run(main())
