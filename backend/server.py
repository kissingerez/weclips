import os
import uuid
import base64
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header, Request
from fastapi.responses import Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext
from jose import jwt, JWTError
from pydantic import BaseModel, EmailStr, Field

# --- Setup ---
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("slate")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET_KEY"]
JWT_ALG = os.environ.get("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES", "10080"))
RC_WEBHOOK_SECRET = os.environ.get("REVENUECAT_WEBHOOK_SECRET", "")
RC_REST_API_KEY = os.environ.get("REVENUECAT_REST_API_KEY", "")
RC_ENTITLEMENT = os.environ.get("REVENUECAT_ENTITLEMENT_ID", "premium")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
users_col = db["users"]
videos_col = db["videos"]
comments_col = db["comments"]
rc_events_col = db["rc_events"]

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)

app = FastAPI(title="WeClips API")
api = APIRouter(prefix="/api")


# --- Models ---
class SignupReq(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)
    display_name: str = Field(min_length=1, max_length=40)


class LoginReq(BaseModel):
    email: EmailStr
    password: str


class TokenResp(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserPublic(BaseModel):
    id: str
    email: EmailStr
    display_name: str
    is_subscribed: bool
    subscription_status: str
    created_at: datetime


class VideoUploadReq(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    content_base64: str
    mime_type: str = "video/mp4"
    thumbnail_base64: Optional[str] = None
    no_ai_confirmed: bool


class VideoPublic(BaseModel):
    id: str
    title: str
    description: str
    mime_type: str
    creator_id: str
    creator_name: str
    views: int
    likes: int
    has_thumbnail: bool
    created_at: datetime


class CommentReq(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class CommentPublic(BaseModel):
    id: str
    video_id: str
    user_id: str
    user_name: str
    text: str
    created_at: datetime


# --- Helpers ---
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def hash_password(p: str) -> str:
    return pwd_context.hash(p)


def verify_password(p: str, h: str) -> bool:
    try:
        return pwd_context.verify(p, h)
    except Exception:
        return False


def create_access_token(sub: str) -> str:
    expire = now_utc() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": sub, "exp": expire}, JWT_SECRET, algorithm=JWT_ALG)


async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> dict:
    if creds is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = await users_col.find_one({"_id": user_id}, {"password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def user_to_public(u: dict) -> UserPublic:
    return UserPublic(
        id=u["_id"],
        email=u["email"],
        display_name=u["display_name"],
        is_subscribed=bool(u.get("is_subscribed", False)),
        subscription_status=u.get("subscription_status", "none"),
        created_at=u["created_at"],
    )


def video_to_public(v: dict) -> VideoPublic:
    return VideoPublic(
        id=v["_id"],
        title=v["title"],
        description=v.get("description", ""),
        mime_type=v.get("mime_type", "video/mp4"),
        creator_id=v["creator_id"],
        creator_name=v.get("creator_name", "Anonymous"),
        views=int(v.get("views", 0)),
        likes=int(v.get("likes", 0)),
        has_thumbnail=bool(v.get("thumbnail_base64")),
        created_at=v["created_at"],
    )


# --- Routes: Auth ---
@api.get("/")
async def root():
    return {"app": "WeClips", "status": "ok"}


@api.post("/auth/signup", response_model=TokenResp)
async def signup(body: SignupReq):
    email = body.email.lower()
    existing = await users_col.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id = str(uuid.uuid4())
    doc = {
        "_id": user_id,
        "email": email,
        "password_hash": hash_password(body.password),
        "display_name": body.display_name.strip(),
        "is_subscribed": False,
        "subscription_status": "none",
        "subscription_expires_at": None,
        "rc_last_event": None,
        "rc_environment": None,
        "created_at": now_utc(),
    }
    await users_col.insert_one(doc)
    return TokenResp(access_token=create_access_token(user_id))


@api.post("/auth/login", response_model=TokenResp)
async def login(body: LoginReq):
    email = body.email.lower()
    user = await users_col.find_one({"email": email})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    return TokenResp(access_token=create_access_token(user["_id"]))


@api.get("/auth/me", response_model=UserPublic)
async def me(user: dict = Depends(get_current_user)):
    return user_to_public(user)


# --- Routes: Subscription (RevenueCat-backed) ---
@api.get("/subscription/status")
async def subscription_status(user: dict = Depends(get_current_user)):
    return {
        "is_subscribed": bool(user.get("is_subscribed", False)),
        "subscription_status": user.get("subscription_status", "none"),
        "current_period_end": user.get("subscription_expires_at"),
    }


@api.post("/subscription/sync")
async def sync_subscription(user: dict = Depends(get_current_user)):
    """Client calls this immediately after a successful purchase to optimistically
    update server state. If REVENUECAT_REST_API_KEY is set, we authoritatively
    verify with RevenueCat REST API. Otherwise we trust the client and rely on
    webhook for eventual consistency."""
    is_subscribed = False
    sub_status = "none"
    expires_at: Optional[datetime] = None

    if RC_REST_API_KEY:
        url = f"https://api.revenuecat.com/v1/subscribers/{user['_id']}"
        headers = {"Authorization": f"Bearer {RC_REST_API_KEY}"}
        try:
            async with httpx.AsyncClient(timeout=10) as hc:
                r = await hc.get(url, headers=headers)
            if r.status_code == 200:
                data = r.json().get("subscriber", {})
                ents = data.get("entitlements", {}) or {}
                ent = ents.get(RC_ENTITLEMENT)
                if ent:
                    expires_str = ent.get("expires_date")
                    if expires_str:
                        expires_at = datetime.fromisoformat(expires_str.replace("Z", "+00:00"))
                        is_subscribed = expires_at > now_utc()
                        sub_status = "active" if is_subscribed else "expired"
        except Exception as e:
            logger.warning(f"RevenueCat REST sync failed: {e}")
    else:
        # No server-side verification available -> trust client (set active for 30 days as a hint)
        is_subscribed = True
        sub_status = "active"
        expires_at = now_utc() + timedelta(days=30)

    await users_col.update_one(
        {"_id": user["_id"]},
        {
            "$set": {
                "is_subscribed": is_subscribed,
                "subscription_status": sub_status,
                "subscription_expires_at": expires_at,
            }
        },
    )
    return {
        "is_subscribed": is_subscribed,
        "subscription_status": sub_status,
        "current_period_end": expires_at,
        "verified": bool(RC_REST_API_KEY),
    }


@api.post("/subscription/dev-activate")
async def dev_activate(user: dict = Depends(get_current_user)):
    """Preview/Expo-Go testing only. Disabled if a real REVENUECAT_REST_API_KEY is set."""
    if RC_REST_API_KEY:
        raise HTTPException(status_code=403, detail="Dev activation disabled in live mode")
    expires = now_utc() + timedelta(days=30)
    await users_col.update_one(
        {"_id": user["_id"]},
        {
            "$set": {
                "is_subscribed": True,
                "subscription_status": "active",
                "subscription_expires_at": expires,
            }
        },
    )
    return {"is_subscribed": True, "subscription_status": "active", "current_period_end": expires}


# --- Routes: RevenueCat Webhook ---
ACTIVE_EVENTS = {"INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE", "UNCANCELLATION"}
INACTIVE_EVENTS = {"EXPIRATION", "BILLING_ISSUE"}
# Note: CANCELLATION typically means non-renewing but still active until EXPIRATION.


@api.post("/webhooks/revenuecat")
async def revenuecat_webhook(
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    if not RC_WEBHOOK_SECRET:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")
    expected = f"Bearer {RC_WEBHOOK_SECRET}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")

    payload = await request.json()
    event = payload.get("event") or {}
    event_type = event.get("type")
    app_user_id = event.get("app_user_id")
    environment = event.get("environment")
    expiration_at_ms = event.get("expiration_at_ms")

    if not event_type or not app_user_id:
        raise HTTPException(status_code=400, detail="Missing event.type or event.app_user_id")

    await rc_events_col.insert_one(
        {
            "_id": str(uuid.uuid4()),
            "type": event_type,
            "app_user_id": app_user_id,
            "environment": environment,
            "raw": payload,
            "received_at": now_utc(),
        }
    )

    update: dict = {"rc_last_event": event_type, "rc_environment": environment}

    if event_type in ACTIVE_EVENTS:
        update["is_subscribed"] = True
        update["subscription_status"] = "active"
        if expiration_at_ms:
            try:
                update["subscription_expires_at"] = datetime.fromtimestamp(
                    int(expiration_at_ms) / 1000, tz=timezone.utc
                )
            except Exception:
                pass
    elif event_type in INACTIVE_EVENTS:
        update["is_subscribed"] = False
        update["subscription_status"] = "expired" if event_type == "EXPIRATION" else "billing_issue"
    elif event_type == "CANCELLATION":
        # Keep is_subscribed=true until EXPIRATION
        update["subscription_status"] = "cancelled"
    else:
        return {"status": "ignored", "event": event_type}

    await users_col.update_one({"_id": app_user_id}, {"$set": update}, upsert=False)
    return {"status": "ok", "event": event_type}


# --- Routes: Videos ---
@api.post("/videos", response_model=VideoPublic)
async def upload_video(body: VideoUploadReq, user: dict = Depends(get_current_user)):
    if not body.no_ai_confirmed:
        raise HTTPException(status_code=400, detail="You must confirm the WeClips content policy")
    if not user.get("is_subscribed", False):
        raise HTTPException(status_code=402, detail="Active subscription required to upload")

    try:
        raw = base64.b64decode(body.content_base64, validate=False)
        if len(raw) == 0:
            raise ValueError("empty")
        if len(raw) > 60 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Video too large (max ~60MB)")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 video content")

    video_id = str(uuid.uuid4())
    doc = {
        "_id": video_id,
        "title": body.title.strip(),
        "description": body.description.strip(),
        "mime_type": body.mime_type,
        "content_base64": body.content_base64,
        "thumbnail_base64": body.thumbnail_base64,
        "creator_id": user["_id"],
        "creator_name": user["display_name"],
        "views": 0,
        "likes": 0,
        "liked_by": [],
        "created_at": now_utc(),
    }
    await videos_col.insert_one(doc)
    return video_to_public(doc)


@api.get("/videos", response_model=List[VideoPublic])
async def list_videos(q: Optional[str] = None, limit: int = 50):
    query: dict = {}
    if q:
        query = {
            "$or": [
                {"title": {"$regex": q, "$options": "i"}},
                {"description": {"$regex": q, "$options": "i"}},
                {"creator_name": {"$regex": q, "$options": "i"}},
            ]
        }
    cursor = videos_col.find(
        query, {"content_base64": 0, "thumbnail_base64": 0, "liked_by": 0}
    ).sort("created_at", -1).limit(min(limit, 100))
    items = []
    async for v in cursor:
        items.append(video_to_public(v))
    return items


@api.get("/videos/mine", response_model=List[VideoPublic])
async def my_videos(user: dict = Depends(get_current_user)):
    cursor = videos_col.find(
        {"creator_id": user["_id"]},
        {"content_base64": 0, "thumbnail_base64": 0, "liked_by": 0},
    ).sort("created_at", -1)
    out = []
    async for v in cursor:
        out.append(video_to_public(v))
    return out


@api.get("/videos/{video_id}", response_model=VideoPublic)
async def get_video(video_id: str):
    v = await videos_col.find_one(
        {"_id": video_id}, {"content_base64": 0, "thumbnail_base64": 0, "liked_by": 0}
    )
    if not v:
        raise HTTPException(status_code=404, detail="Not found")
    await videos_col.update_one({"_id": video_id}, {"$inc": {"views": 1}})
    v["views"] = int(v.get("views", 0)) + 1
    return video_to_public(v)


@api.get("/videos/{video_id}/stream")
async def stream_video(video_id: str):
    v = await videos_col.find_one({"_id": video_id}, {"content_base64": 1, "mime_type": 1})
    if not v:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        data = base64.b64decode(v["content_base64"])
    except Exception:
        raise HTTPException(status_code=500, detail="Corrupt video")
    return Response(content=data, media_type=v.get("mime_type", "video/mp4"))


@api.get("/videos/{video_id}/thumbnail")
async def get_thumbnail(video_id: str):
    v = await videos_col.find_one({"_id": video_id}, {"thumbnail_base64": 1})
    if not v or not v.get("thumbnail_base64"):
        raise HTTPException(status_code=404, detail="No thumbnail")
    try:
        data = base64.b64decode(v["thumbnail_base64"])
    except Exception:
        raise HTTPException(status_code=500, detail="Corrupt thumbnail")
    return Response(content=data, media_type="image/jpeg")


@api.post("/videos/{video_id}/like")
async def like_video(video_id: str, user: dict = Depends(get_current_user)):
    v = await videos_col.find_one({"_id": video_id}, {"liked_by": 1, "likes": 1})
    if not v:
        raise HTTPException(status_code=404, detail="Not found")
    liked_by = v.get("liked_by", []) or []
    if user["_id"] in liked_by:
        await videos_col.update_one(
            {"_id": video_id},
            {"$pull": {"liked_by": user["_id"]}, "$inc": {"likes": -1}},
        )
        return {"liked": False, "likes": max(0, int(v.get("likes", 0)) - 1)}
    await videos_col.update_one(
        {"_id": video_id},
        {"$addToSet": {"liked_by": user["_id"]}, "$inc": {"likes": 1}},
    )
    return {"liked": True, "likes": int(v.get("likes", 0)) + 1}


@api.get("/videos/{video_id}/comments", response_model=List[CommentPublic])
async def list_comments(video_id: str):
    cursor = comments_col.find({"video_id": video_id}).sort("created_at", -1).limit(200)
    out = []
    async for c in cursor:
        out.append(
            CommentPublic(
                id=c["_id"],
                video_id=c["video_id"],
                user_id=c["user_id"],
                user_name=c["user_name"],
                text=c["text"],
                created_at=c["created_at"],
            )
        )
    return out


@api.post("/videos/{video_id}/comments", response_model=CommentPublic)
async def add_comment(video_id: str, body: CommentReq, user: dict = Depends(get_current_user)):
    v = await videos_col.find_one({"_id": video_id}, {"_id": 1})
    if not v:
        raise HTTPException(status_code=404, detail="Video not found")
    cid = str(uuid.uuid4())
    doc = {
        "_id": cid,
        "video_id": video_id,
        "user_id": user["_id"],
        "user_name": user["display_name"],
        "text": body.text.strip(),
        "created_at": now_utc(),
    }
    await comments_col.insert_one(doc)
    return CommentPublic(
        id=cid,
        video_id=video_id,
        user_id=user["_id"],
        user_name=user["display_name"],
        text=body.text.strip(),
        created_at=doc["created_at"],
    )


# --- Mount ---
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    client.close()
