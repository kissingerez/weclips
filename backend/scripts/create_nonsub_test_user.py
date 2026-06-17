import asyncio, os, uuid
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
EMAIL = "nosubtest@weclips.app"
PW = "NoSub2026!"


async def main():
    db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
    users = db["users"]
    fields = {
        "email": EMAIL,
        "password_hash": pwd.hash(PW),
        "display_name": "No Sub",
        "username": "nosubtest",
        "is_subscribed": False,
        "subscription_status": "none",
        "subscription_expires_at": None,
        "email_verified": True,
    }
    existing = await users.find_one({"email": EMAIL})
    if existing:
        await users.update_one({"_id": existing["_id"]}, {"$set": fields})
        print("updated", existing["_id"])
    else:
        await users.insert_one({"_id": str(uuid.uuid4()), "created_at": datetime.now(timezone.utc), **fields})
        print("created", EMAIL)


asyncio.run(main())
