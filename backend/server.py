import os
import re
import uuid
import base64
import hashlib
import secrets
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import httpx
import boto3
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header, Request, UploadFile, File, Form
from fastapi.responses import Response, FileResponse, StreamingResponse
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
APP_PUBLIC_URL = os.environ.get("APP_PUBLIC_URL", "")
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY", "")
SENDGRID_SENDER_EMAIL = os.environ.get("SENDGRID_SENDER_EMAIL", "")
PASSWORD_RESET_TTL_MIN = int(os.environ.get("PASSWORD_RESET_TTL_MIN", "15"))

# Upload limits (cost-saving: 2-minute videos only)
MAX_VIDEO_DURATION_SEC = int(os.environ.get("MAX_VIDEO_DURATION_SEC", "120"))
MAX_VIDEO_SIZE_BYTES = int(os.environ.get("MAX_VIDEO_SIZE_BYTES", str(200 * 1024 * 1024)))  # 200 MB hard cap

# Contact (shown in app + legal pages — required by Apple for UGC apps)
SUPPORT_EMAIL = os.environ.get("SUPPORT_EMAIL", "support@weclips.app")

UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CHUNK_SIZE = 1024 * 1024  # 1 MB

# --- R2 (S3-compatible) ---
R2_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_PRESIGN_UPLOAD_TTL = int(os.environ.get("R2_PRESIGN_UPLOAD_TTL", "900"))
R2_PRESIGN_STREAM_TTL = int(os.environ.get("R2_PRESIGN_STREAM_TTL", "3600"))

s3 = None
if R2_ENDPOINT_URL and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and R2_BUCKET:
    s3 = boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT_URL,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    logger.info("R2 client configured for bucket %s", R2_BUCKET)
else:
    logger.warning("R2 not configured; falling back to local disk uploads")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]
users_col = db["users"]
videos_col = db["videos"]
comments_col = db["comments"]
rc_events_col = db["rc_events"]
password_resets_col = db["password_resets"]
reports_col = db["reports"]
blocks_col = db["blocks"]
follows_col = db["follows"]

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)

app = FastAPI(title="WeClips API")
api = APIRouter(prefix="/api")


# --- Models ---
class SignupReq(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)
    display_name: str = Field(min_length=1, max_length=40)
    username: Optional[str] = Field(default=None, min_length=3, max_length=20)


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
    username: Optional[str] = None
    has_avatar: bool = False
    is_subscribed: bool
    subscription_status: str
    created_at: datetime
    deletion_pending: bool = False
    deletion_expires_at: Optional[datetime] = None


class UserSearchResult(BaseModel):
    id: str
    display_name: str
    username: Optional[str] = None
    has_avatar: bool = False
    followers: int = 0


class UpdateMeReq(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    username: Optional[str] = Field(default=None, min_length=3, max_length=20)
    email: Optional[EmailStr] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = Field(default=None, min_length=6)


class SetThumbnailReq(BaseModel):
    thumbnail_base64: str = Field(min_length=20)


class SetAvatarReq(BaseModel):
    avatar_base64: str = Field(min_length=20)


class UpdateVideoReq(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)


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
    creator_username: Optional[str] = None
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


USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")


def _normalize_username(raw: str) -> str:
    return (raw or "").strip().lstrip("@").lower()


def _slug_from_display(name: str) -> str:
    # Strip non-alnum/underscore, lowercase, fall back to "user"
    s = re.sub(r"[^a-z0-9_]", "", (name or "").lower())
    return s[:18] or "user"


async def _generate_unique_username(base: str) -> str:
    candidate = base
    # try N suffixed variants
    for _ in range(50):
        if not await users_col.find_one({"username": candidate}, {"_id": 1}):
            return candidate
        candidate = f"{base[:14]}{secrets.randbelow(10000):04d}"
    # last resort
    return f"u{secrets.token_hex(4)}"


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


async def get_current_user_flexible(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
    token: Optional[str] = None,
) -> dict:
    """Like get_current_user but also accepts ?token=<jwt> for media players
    (expo-video, browsers) that can't easily attach Authorization headers to
    HTTP Range/streaming requests."""
    jwt_str: Optional[str] = None
    if creds is not None:
        jwt_str = creds.credentials
    elif token:
        jwt_str = token

    if not jwt_str:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(jwt_str, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = await users_col.find_one({"_id": user_id}, {"password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def require_subscriber(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_subscribed", False):
        raise HTTPException(status_code=402, detail="Active subscription required")
    return user


async def require_subscriber_flexible(
    user: dict = Depends(get_current_user_flexible),
) -> dict:
    if not user.get("is_subscribed", False):
        raise HTTPException(status_code=402, detail="Active subscription required")
    return user


def user_to_public(u: dict) -> UserPublic:
    deleted_at = u.get("deleted_at")
    deletion_pending = bool(deleted_at)
    deletion_expires_at = None
    if deleted_at:
        if deleted_at.tzinfo is None:
            deleted_at = deleted_at.replace(tzinfo=timezone.utc)
        deletion_expires_at = deleted_at + timedelta(days=int(os.environ.get("DELETION_GRACE_DAYS", "30")))
    return UserPublic(
        id=u["_id"],
        email=u["email"],
        display_name=u["display_name"],
        username=u.get("username"),
        has_avatar=bool(u.get("avatar_base64")),
        is_subscribed=bool(u.get("is_subscribed", False)),
        subscription_status=u.get("subscription_status", "none"),
        created_at=u["created_at"],
        deletion_pending=deletion_pending,
        deletion_expires_at=deletion_expires_at,
    )


def video_to_public(v: dict) -> VideoPublic:
    return VideoPublic(
        id=v["_id"],
        title=v["title"],
        description=v.get("description", ""),
        mime_type=v.get("mime_type", "video/mp4"),
        creator_id=v["creator_id"],
        creator_name=v.get("creator_name", "Anonymous"),
        creator_username=v.get("creator_username"),
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

    # Resolve username (validate provided OR auto-generate from display_name)
    if body.username:
        username = _normalize_username(body.username)
        if not USERNAME_RE.match(username):
            raise HTTPException(
                status_code=400,
                detail="Username must be 3-20 characters, lowercase letters/numbers/underscores only.",
            )
        if await users_col.find_one({"username": username}, {"_id": 1}):
            raise HTTPException(status_code=400, detail="Username already taken")
    else:
        base = _slug_from_display(body.display_name)
        username = await _generate_unique_username(base)

    user_id = str(uuid.uuid4())
    doc = {
        "_id": user_id,
        "email": email,
        "password_hash": hash_password(body.password),
        "display_name": body.display_name.strip(),
        "username": username,
        "is_subscribed": False,
        "subscription_status": "none",
        "subscription_expires_at": None,
        "rc_last_event": None,
        "rc_environment": None,
        "created_at": now_utc(),
    }
    await users_col.insert_one(doc)
    return TokenResp(access_token=create_access_token(user_id))


# --- Username availability + search ---
@api.get("/users/username-available")
async def username_available(u: str):
    norm = _normalize_username(u)
    if not USERNAME_RE.match(norm):
        return {"available": False, "reason": "invalid"}
    exists = await users_col.find_one({"username": norm}, {"_id": 1})
    return {"available": not exists, "username": norm}


@api.get("/users/search", response_model=List[UserSearchResult])
async def search_users(
    q: str,
    limit: int = 20,
    user: dict = Depends(get_current_user),
):
    term = (q or "").strip().lstrip("@")
    if len(term) < 1:
        return []
    # Case-insensitive partial match on username OR display_name
    safe = re.escape(term)
    cursor = users_col.find(
        {
            "$and": [
                {"deleted_at": {"$in": [None, False]}},
                {
                    "$or": [
                        {"username": {"$regex": safe, "$options": "i"}},
                        {"display_name": {"$regex": safe, "$options": "i"}},
                    ]
                },
            ]
        },
        {"_id": 1, "display_name": 1, "username": 1, "avatar_base64": 1},
    ).limit(min(max(limit, 1), 50))
    results: List[UserSearchResult] = []
    async for u in cursor:
        if u["_id"] == user["_id"]:
            continue
        followers = await follows_col.count_documents({"followee_id": u["_id"]})
        results.append(
            UserSearchResult(
                id=u["_id"],
                display_name=u.get("display_name") or "User",
                username=u.get("username"),
                has_avatar=bool(u.get("avatar_base64")),
                followers=followers,
            )
        )
    return results


@api.get("/users/{target_user_id}", response_model=UserSearchResult)
async def get_user_public(target_user_id: str, user: dict = Depends(get_current_user)):
    u = await users_col.find_one(
        {"_id": target_user_id},
        {"display_name": 1, "username": 1, "avatar_base64": 1},
    )
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    followers = await follows_col.count_documents({"followee_id": target_user_id})
    return UserSearchResult(
        id=u["_id"],
        display_name=u.get("display_name") or "User",
        username=u.get("username"),
        has_avatar=bool(u.get("avatar_base64")),
        followers=followers,
    )


@api.get("/users/{target_user_id}/avatar")
async def get_user_avatar(target_user_id: str):
    u = await users_col.find_one({"_id": target_user_id}, {"avatar_base64": 1})
    if not u or not u.get("avatar_base64"):
        raise HTTPException(status_code=404, detail="No avatar")
    try:
        data = base64.b64decode(u["avatar_base64"])
    except Exception:
        raise HTTPException(status_code=500, detail="Corrupt avatar")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@api.put("/auth/me/avatar")
async def set_my_avatar(body: SetAvatarReq, user: dict = Depends(get_current_user)):
    raw = body.avatar_base64
    if "," in raw and raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    if len(raw) > 600_000:
        raise HTTPException(status_code=413, detail="Avatar too large (max ~400KB)")
    try:
        base64.b64decode(raw, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")
    await users_col.update_one({"_id": user["_id"]}, {"$set": {"avatar_base64": raw}})
    return {"ok": True, "has_avatar": True}


@api.delete("/auth/me/avatar")
async def clear_my_avatar(user: dict = Depends(get_current_user)):
    await users_col.update_one({"_id": user["_id"]}, {"$unset": {"avatar_base64": ""}})
    return {"ok": True, "has_avatar": False}


@api.post("/auth/login", response_model=TokenResp)
async def login(body: LoginReq):
    email = body.email.lower()
    user = await users_col.find_one({"email": email})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    # If a previous soft-delete is past the grace period, hard-delete now and
    # treat the account as gone.
    deleted_at = user.get("deleted_at")
    if deleted_at:
        if deleted_at.tzinfo is None:
            deleted_at = deleted_at.replace(tzinfo=timezone.utc)
        if deleted_at + timedelta(days=DELETION_GRACE_DAYS) < now_utc():
            await _hard_delete_user_data(user["_id"])
            raise HTTPException(status_code=401, detail="Account has been permanently deleted")
    # Otherwise allow login (so the user can restore within grace period)
    return TokenResp(access_token=create_access_token(user["_id"]))


@api.get("/auth/me", response_model=UserPublic)
async def me(user: dict = Depends(get_current_user)):
    return user_to_public(user)


@api.patch("/auth/me", response_model=UserPublic)
async def update_me(body: UpdateMeReq, user: dict = Depends(get_current_user)):
    updates: dict = {}

    # Display name
    if body.display_name is not None:
        nm = body.display_name.strip()
        if not nm:
            raise HTTPException(status_code=400, detail="Display name cannot be empty")
        updates["display_name"] = nm

    # Username
    if body.username is not None:
        new_u = _normalize_username(body.username)
        if not USERNAME_RE.match(new_u):
            raise HTTPException(
                status_code=400,
                detail="Username must be 3-20 chars, lowercase letters/numbers/underscores.",
            )
        if new_u != user.get("username"):
            taken = await users_col.find_one(
                {"username": new_u, "_id": {"$ne": user["_id"]}}, {"_id": 1}
            )
            if taken:
                raise HTTPException(status_code=400, detail="Username already taken")
            updates["username"] = new_u

    # Email
    if body.email is not None:
        new_email = body.email.lower()
        if new_email != user.get("email"):
            taken = await users_col.find_one(
                {"email": new_email, "_id": {"$ne": user["_id"]}}, {"_id": 1}
            )
            if taken:
                raise HTTPException(status_code=400, detail="Email already in use")
            updates["email"] = new_email

    # Password change
    if body.new_password is not None:
        if not body.current_password:
            raise HTTPException(
                status_code=400, detail="Current password required to set a new password"
            )
        # Fetch hash (we omitted it from `user` dict)
        full = await users_col.find_one({"_id": user["_id"]}, {"password_hash": 1})
        if not full or not verify_password(body.current_password, full.get("password_hash", "")):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        updates["password_hash"] = hash_password(body.new_password)

    if not updates:
        return user_to_public(user)

    await users_col.update_one({"_id": user["_id"]}, {"$set": updates})

    # Propagate display_name + username changes to existing videos so the
    # creator badge stays in sync everywhere.
    cascade: dict = {}
    if "display_name" in updates:
        cascade["creator_name"] = updates["display_name"]
    if "username" in updates:
        cascade["creator_username"] = updates["username"]
    if cascade:
        await videos_col.update_many({"creator_id": user["_id"]}, {"$set": cascade})

    refreshed = await users_col.find_one({"_id": user["_id"]}, {"password_hash": 0})
    return user_to_public(refreshed or user)


# --- Password reset ---
class ForgotPasswordReq(BaseModel):
    email: EmailStr


class ResetPasswordReq(BaseModel):
    token: str = Field(min_length=20)
    new_password: str = Field(min_length=6)


def _hash_token(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def _send_password_reset_email(to_email: str, reset_url: str) -> bool:
    """Send via SendGrid if configured. Returns True on success, False otherwise."""
    if not SENDGRID_API_KEY or not SENDGRID_SENDER_EMAIL:
        logger.warning("SendGrid not configured — skipping email send")
        return False
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail
        html = f"""
        <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="color:#0F172A;">Reset your WeClips password</h2>
          <p style="color:#475569;line-height:1.5;">
            We received a request to reset the password for your WeClips account.
            This link is valid for {PASSWORD_RESET_TTL_MIN} minutes.
          </p>
          <p style="margin:24px 0;">
            <a href="{reset_url}" style="background:#89CFF0;color:#0A1929;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">
              Reset password
            </a>
          </p>
          <p style="color:#64748B;font-size:13px;">
            If you didn't request this, you can safely ignore this email.
          </p>
          <p style="color:#94A3B8;font-size:12px;margin-top:32px;">
            Or paste this link into your browser:<br>{reset_url}
          </p>
        </div>
        """
        msg = Mail(
            from_email=SENDGRID_SENDER_EMAIL,
            to_emails=to_email,
            subject="Reset your WeClips password",
            html_content=html,
        )
        resp = SendGridAPIClient(SENDGRID_API_KEY).send(msg)
        return 200 <= resp.status_code < 300
    except Exception as e:
        logger.exception(f"SendGrid send failed: {e}")
        return False


@api.post("/auth/forgot-password")
async def forgot_password(body: ForgotPasswordReq):
    email = body.email.lower()
    user = await users_col.find_one({"email": email}, {"_id": 1, "email": 1})
    # Always 200 — avoid leaking which emails exist
    resp: dict = {"status": "ok"}
    if not user:
        return resp

    token = secrets.token_urlsafe(32)
    token_hash = _hash_token(token)
    expires_at = now_utc() + timedelta(minutes=PASSWORD_RESET_TTL_MIN)
    await password_resets_col.insert_one(
        {
            "_id": str(uuid.uuid4()),
            "token_hash": token_hash,
            "user_id": user["_id"],
            "email": email,
            "expires_at": expires_at,
            "used": False,
            "created_at": now_utc(),
        }
    )

    base = APP_PUBLIC_URL.rstrip("/")
    reset_url = f"{base}/reset?token={token}"

    sent = _send_password_reset_email(email, reset_url)
    if not sent:
        # No email service configured (preview mode) — return the URL so the
        # user can still complete the reset. Disabled automatically once
        # SENDGRID_API_KEY + SENDGRID_SENDER_EMAIL are set in production.
        resp["dev_reset_url"] = reset_url
        resp["dev_token"] = token
        logger.info(f"PASSWORD RESET (dev) for {email}: {reset_url}")
    return resp


@api.post("/auth/reset-password")
async def reset_password(body: ResetPasswordReq):
    token_hash = _hash_token(body.token)
    record = await password_resets_col.find_one({"token_hash": token_hash})
    if not record:
        raise HTTPException(status_code=400, detail="Invalid or expired reset link")
    if record.get("used"):
        raise HTTPException(status_code=400, detail="This reset link has already been used")
    expires_at = record.get("expires_at")
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if not expires_at or expires_at < now_utc():
        raise HTTPException(status_code=400, detail="This reset link has expired")

    user_id = record["user_id"]
    new_hash = hash_password(body.new_password)
    await users_col.update_one({"_id": user_id}, {"$set": {"password_hash": new_hash}})
    await password_resets_col.update_one(
        {"_id": record["_id"]},
        {"$set": {"used": True, "used_at": now_utc()}},
    )
    # Invalidate all other outstanding reset tokens for this user
    await password_resets_col.update_many(
        {"user_id": user_id, "used": False},
        {"$set": {"used": True, "used_at": now_utc()}},
    )
    return {"status": "ok"}


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
class UploadUrlReq(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    mime_type: str = Field(default="video/mp4")
    no_ai_confirmed: bool


class UploadUrlResp(BaseModel):
    video_id: str
    upload_url: str
    object_key: str
    headers: dict
    expires_in: int


def _r2_key_for(video_id: str, mime_type: str) -> str:
    ext = "mp4"
    if mime_type and "/" in mime_type:
        candidate = mime_type.split("/", 1)[1].lower()
        # keep it short and alpha
        candidate = "".join(c for c in candidate if c.isalnum())[:5]
        if candidate:
            ext = candidate
    return f"videos/{video_id}.{ext}"


@api.post("/videos/upload-url", response_model=UploadUrlResp)
async def create_upload_url(body: UploadUrlReq, user: dict = Depends(require_subscriber)):
    if not body.no_ai_confirmed:
        raise HTTPException(status_code=400, detail="You must confirm the WeClips content policy")
    if s3 is None:
        raise HTTPException(status_code=500, detail="Cloud storage not configured")

    video_id = str(uuid.uuid4())
    object_key = _r2_key_for(video_id, body.mime_type)

    try:
        url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": R2_BUCKET,
                "Key": object_key,
                "ContentType": body.mime_type or "video/mp4",
            },
            ExpiresIn=R2_PRESIGN_UPLOAD_TTL,
        )
    except Exception as e:
        logger.exception("R2 presign upload failed")
        raise HTTPException(status_code=500, detail=f"Storage error: {e}")

    await videos_col.insert_one(
        {
            "_id": video_id,
            "title": body.title.strip(),
            "description": body.description.strip(),
            "mime_type": body.mime_type or "video/mp4",
            "storage": "r2",
            "r2_key": object_key,
            "file_size": 0,
            "upload_complete": False,
            "creator_id": user["_id"],
            "creator_name": user["display_name"],
            "creator_username": user.get("username"),
            "views": 0,
            "likes": 0,
            "liked_by": [],
            "created_at": now_utc(),
        }
    )
    return UploadUrlResp(
        video_id=video_id,
        upload_url=url,
        object_key=object_key,
        headers={"Content-Type": body.mime_type or "video/mp4"},
        expires_in=R2_PRESIGN_UPLOAD_TTL,
    )


@api.post("/videos/{video_id}/complete", response_model=VideoPublic)
async def complete_upload(video_id: str, user: dict = Depends(require_subscriber)):
    v = await videos_col.find_one({"_id": video_id})
    if not v or v.get("creator_id") != user["_id"]:
        raise HTTPException(status_code=404, detail="Video not found")
    if v.get("upload_complete"):
        return video_to_public(v)
    if s3 is None or v.get("storage") != "r2":
        raise HTTPException(status_code=400, detail="Not an R2-backed upload")

    # Verify file actually exists in R2 and capture its size
    try:
        head = s3.head_object(Bucket=R2_BUCKET, Key=v["r2_key"])
    except Exception:
        raise HTTPException(status_code=400, detail="Upload not found in storage. Please retry.")
    size = int(head.get("ContentLength", 0))
    if size <= 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if size > MAX_VIDEO_SIZE_BYTES:
        # Too large — delete from R2 + Mongo and refuse
        try:
            s3.delete_object(Bucket=R2_BUCKET, Key=v["r2_key"])
        except Exception:
            pass
        await videos_col.delete_one({"_id": video_id})
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({size // (1024*1024)} MB). Max {MAX_VIDEO_SIZE_BYTES // (1024*1024)} MB per upload. Try lowering resolution.",
        )

    await videos_col.update_one(
        {"_id": video_id},
        {"$set": {"upload_complete": True, "file_size": size}},
    )
    v["upload_complete"] = True
    v["file_size"] = size
    return video_to_public(v)


@api.post("/videos", response_model=VideoPublic)
async def upload_video(
    title: str = Form(..., min_length=1, max_length=120),
    description: str = Form("", max_length=2000),
    mime_type: str = Form("video/mp4"),
    no_ai_confirmed: bool = Form(...),
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    if not no_ai_confirmed:
        raise HTTPException(status_code=400, detail="You must confirm the WeClips content policy")
    if not user.get("is_subscribed", False):
        raise HTTPException(status_code=402, detail="Active subscription required to upload")

    video_id = str(uuid.uuid4())
    # Pick a sensible extension from the uploaded filename or mime type
    ext = ""
    fn = (file.filename or "").strip()
    if "." in fn:
        ext = "." + fn.rsplit(".", 1)[-1].lower()[:5]
    elif mime_type.startswith("video/"):
        ext = "." + mime_type.split("/", 1)[1].lower()[:5]
    file_path = UPLOAD_DIR / f"{video_id}{ext}"

    bytes_written = 0
    try:
        with open(file_path, "wb") as out:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                out.write(chunk)
                bytes_written += len(chunk)
    except Exception as e:
        # Clean up partial file
        try:
            file_path.unlink()
        except Exception:
            pass
        logger.exception("Upload write failed")
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

    if bytes_written == 0:
        try:
            file_path.unlink()
        except Exception:
            pass
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    doc = {
        "_id": video_id,
        "title": title.strip(),
        "description": description.strip(),
        "mime_type": mime_type or "video/mp4",
        "file_path": str(file_path),
        "file_size": bytes_written,
        "creator_id": user["_id"],
        "creator_name": user["display_name"],
        "creator_username": user.get("username"),
        "views": 0,
        "likes": 0,
        "liked_by": [],
        "created_at": now_utc(),
    }
    await videos_col.insert_one(doc)
    return video_to_public(doc)


@api.get("/videos", response_model=List[VideoPublic])
async def list_videos(q: Optional[str] = None, limit: int = 50):
    query: dict = {"$or": [{"upload_complete": True}, {"upload_complete": {"$exists": False}}]}
    if q:
        text_filter = {
            "$or": [
                {"title": {"$regex": q, "$options": "i"}},
                {"description": {"$regex": q, "$options": "i"}},
                {"creator_name": {"$regex": q, "$options": "i"}},
            ]
        }
        query = {"$and": [query, text_filter]}
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
async def get_video(video_id: str, user: dict = Depends(require_subscriber)):
    v = await videos_col.find_one(
        {"_id": video_id}, {"content_base64": 0, "thumbnail_base64": 0, "liked_by": 0}
    )
    if not v:
        raise HTTPException(status_code=404, detail="Not found")
    # Count unique views — same user refreshing doesn't bump the count
    viewed_by = v.get("viewed_by", []) or []
    if user["_id"] not in viewed_by:
        await videos_col.update_one(
            {"_id": video_id},
            {"$addToSet": {"viewed_by": user["_id"]}, "$inc": {"views": 1}},
        )
        v["views"] = int(v.get("views", 0)) + 1
    return video_to_public(v)


@api.get("/videos/{video_id}/stream-url")
async def get_stream_url(video_id: str, user: dict = Depends(require_subscriber)):
    v = await videos_col.find_one(
        {"_id": video_id},
        {"storage": 1, "r2_key": 1, "file_path": 1, "content_base64": 1, "mime_type": 1},
    )
    if not v:
        raise HTTPException(status_code=404, detail="Not found")

    # New R2-backed videos
    if v.get("storage") == "r2" and v.get("r2_key") and s3 is not None:
        try:
            url = s3.generate_presigned_url(
                ClientMethod="get_object",
                Params={"Bucket": R2_BUCKET, "Key": v["r2_key"]},
                ExpiresIn=R2_PRESIGN_STREAM_TTL,
            )
            return {"stream_url": url, "expires_in": R2_PRESIGN_STREAM_TTL}
        except Exception as e:
            logger.exception("R2 presign GET failed")
            raise HTTPException(status_code=500, detail=f"Storage error: {e}")

    # Legacy disk- or base64-backed videos: route through our own stream endpoint with token
    # (the client will append the JWT as ?token=)
    return {"stream_url": f"/api/videos/{video_id}/stream", "expires_in": 0, "legacy": True}


@api.get("/videos/{video_id}/stream")
async def stream_video(
    video_id: str,
    request: Request,
    user: dict = Depends(require_subscriber_flexible),
):
    v = await videos_col.find_one(
        {"_id": video_id},
        {"file_path": 1, "mime_type": 1, "file_size": 1, "content_base64": 1},
    )
    if not v:
        raise HTTPException(status_code=404, detail="Not found")
    media_type = v.get("mime_type", "video/mp4")

    fp = v.get("file_path")
    if fp and os.path.isfile(fp):
        file_size = os.path.getsize(fp)
        range_header = request.headers.get("range")

        if not range_header:
            # No Range: stream the whole file
            def iter_full():
                with open(fp, "rb") as f:
                    while True:
                        chunk = f.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        yield chunk
            return StreamingResponse(
                iter_full(),
                media_type=media_type,
                headers={
                    "Content-Length": str(file_size),
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "public, max-age=3600",
                },
            )

        # Parse "bytes=START-END"
        try:
            units, _, range_str = range_header.partition("=")
            if units.strip() != "bytes":
                raise ValueError("only bytes ranges supported")
            start_str, _, end_str = range_str.partition("-")
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
            if end >= file_size:
                end = file_size - 1
            if start < 0 or start > end:
                raise ValueError("invalid range")
        except Exception:
            raise HTTPException(status_code=416, detail="Invalid Range header")

        chunk_len = end - start + 1

        def iter_range():
            with open(fp, "rb") as f:
                f.seek(start)
                remaining = chunk_len
                while remaining > 0:
                    read = f.read(min(CHUNK_SIZE, remaining))
                    if not read:
                        break
                    yield read
                    remaining -= len(read)

        return StreamingResponse(
            iter_range(),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(chunk_len),
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=3600",
            },
        )

    # Legacy fallback: tiny base64 videos (no Range support)
    if v.get("content_base64"):
        try:
            data = base64.b64decode(v["content_base64"])
        except Exception:
            raise HTTPException(status_code=500, detail="Corrupt video")
        return Response(content=data, media_type=media_type)

    raise HTTPException(status_code=404, detail="Video file missing")


@api.get("/videos/{video_id}/thumbnail")
async def get_thumbnail(video_id: str):
    v = await videos_col.find_one({"_id": video_id}, {"thumbnail_base64": 1})
    if not v or not v.get("thumbnail_base64"):
        raise HTTPException(status_code=404, detail="No thumbnail")
    try:
        data = base64.b64decode(v["thumbnail_base64"])
    except Exception:
        raise HTTPException(status_code=500, detail="Corrupt thumbnail")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@api.put("/videos/{video_id}/thumbnail")
async def set_thumbnail(
    video_id: str,
    body: SetThumbnailReq,
    user: dict = Depends(get_current_user),
):
    v = await videos_col.find_one({"_id": video_id}, {"creator_id": 1})
    if not v:
        raise HTTPException(status_code=404, detail="Not found")
    if v.get("creator_id") != user["_id"]:
        raise HTTPException(status_code=403, detail="Only the creator can change the thumbnail")

    # Accept "data:image/jpeg;base64,..." or raw base64
    raw = body.thumbnail_base64
    if "," in raw and raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    # Sanity-check + cap size (~512KB encoded = ~384KB image)
    if len(raw) > 800_000:
        raise HTTPException(status_code=413, detail="Thumbnail too large (max ~512KB)")
    try:
        base64.b64decode(raw, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    await videos_col.update_one(
        {"_id": video_id}, {"$set": {"thumbnail_base64": raw}}
    )
    return {"ok": True, "has_thumbnail": True}


@api.post("/videos/{video_id}/like")
async def like_video(video_id: str, user: dict = Depends(require_subscriber)):
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
async def list_comments(video_id: str, user: dict = Depends(require_subscriber)):
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
async def add_comment(video_id: str, body: CommentReq, user: dict = Depends(require_subscriber)):
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


@api.delete("/videos/{video_id}/comments/{comment_id}")
async def delete_comment(
    video_id: str,
    comment_id: str,
    user: dict = Depends(require_subscriber),
):
    c = await comments_col.find_one({"_id": comment_id, "video_id": video_id})
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    # Allow if the user authored the comment OR owns the video (creator moderation)
    video = await videos_col.find_one({"_id": video_id}, {"creator_id": 1})
    is_author = c["user_id"] == user["_id"]
    is_owner = bool(video) and video.get("creator_id") == user["_id"]
    if not (is_author or is_owner):
        raise HTTPException(status_code=403, detail="Not allowed to delete this comment")
    await comments_col.delete_one({"_id": comment_id})
    return {"deleted": True, "id": comment_id}


@api.patch("/videos/{video_id}", response_model=VideoPublic)
async def update_video(
    video_id: str,
    body: UpdateVideoReq,
    user: dict = Depends(get_current_user),
):
    v = await videos_col.find_one({"_id": video_id})
    if not v:
        raise HTTPException(status_code=404, detail="Video not found")
    if v.get("creator_id") != user["_id"]:
        raise HTTPException(status_code=403, detail="Only the creator can edit this video")

    updates: dict = {}
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        updates["title"] = t
    if body.description is not None:
        updates["description"] = body.description.strip()

    if updates:
        await videos_col.update_one({"_id": video_id}, {"$set": updates})
        v.update(updates)
    return video_to_public(v)


@api.delete("/videos/{video_id}")
async def delete_video(video_id: str, user: dict = Depends(get_current_user)):
    v = await videos_col.find_one({"_id": video_id})
    if not v:
        raise HTTPException(status_code=404, detail="Video not found")
    if v.get("creator_id") != user["_id"]:
        raise HTTPException(status_code=403, detail="Only the creator can delete this video")
    # Remove R2 object (if any)
    if v.get("storage") == "r2" and v.get("r2_key") and s3 is not None:
        try:
            s3.delete_object(Bucket=R2_BUCKET, Key=v["r2_key"])
        except Exception:
            pass
    elif v.get("file_path") and os.path.isfile(v["file_path"]):
        try:
            os.remove(v["file_path"])
        except Exception:
            pass
    await comments_col.delete_many({"video_id": video_id})
    await videos_col.delete_one({"_id": video_id})
    return {"deleted": True, "id": video_id}


# --- Account deletion with 30-day grace period (Apple guideline 5.1.1(v)) ---
DELETION_GRACE_DAYS = int(os.environ.get("DELETION_GRACE_DAYS", "30"))


async def _hard_delete_user_data(user_id: str) -> None:
    """Actually wipe a user's data. Called after the grace period expires."""
    async for v in videos_col.find({"creator_id": user_id}, {"r2_key": 1, "storage": 1, "file_path": 1}):
        if v.get("storage") == "r2" and v.get("r2_key") and s3 is not None:
            try:
                s3.delete_object(Bucket=R2_BUCKET, Key=v["r2_key"])
            except Exception:
                pass
        elif v.get("file_path") and os.path.isfile(v["file_path"]):
            try:
                os.remove(v["file_path"])
            except Exception:
                pass
    await videos_col.delete_many({"creator_id": user_id})
    await comments_col.delete_many({"user_id": user_id})
    await password_resets_col.delete_many({"user_id": user_id})
    await blocks_col.delete_many({"$or": [{"blocker_id": user_id}, {"blocked_id": user_id}]})
    await reports_col.delete_many({"reporter_id": user_id})
    await users_col.delete_one({"_id": user_id})


@api.delete("/auth/me")
async def delete_account(user: dict = Depends(get_current_user)):
    """Soft-delete: marks the account with `deleted_at`. The user can restore it
    within 30 days. After that, a background sweep (or the next login attempt
    that touches this user) hard-deletes everything."""
    await users_col.update_one(
        {"_id": user["_id"]},
        {"$set": {"deleted_at": now_utc()}},
    )
    return {
        "deleted": True,
        "soft_delete": True,
        "grace_days": DELETION_GRACE_DAYS,
        "permanent_after": now_utc() + timedelta(days=DELETION_GRACE_DAYS),
    }


@api.post("/auth/restore")
async def restore_account(user: dict = Depends(get_current_user)):
    """Cancels a pending deletion if still within the grace period."""
    if not user.get("deleted_at"):
        return {"restored": False, "reason": "Account is not pending deletion"}
    await users_col.update_one(
        {"_id": user["_id"]},
        {"$unset": {"deleted_at": ""}},
    )
    return {"restored": True}


# --- Report content (Apple App Store guideline 1.2 — required) ---
class ReportReq(BaseModel):
    target_type: str = Field(pattern="^(video|comment|user)$")
    target_id: str
    reason: str = Field(min_length=1, max_length=500)


@api.post("/reports")
async def report_content(body: ReportReq, user: dict = Depends(get_current_user)):
    await reports_col.insert_one(
        {
            "_id": str(uuid.uuid4()),
            "reporter_id": user["_id"],
            "target_type": body.target_type,
            "target_id": body.target_id,
            "reason": body.reason.strip(),
            "status": "open",
            "created_at": now_utc(),
        }
    )
    return {"status": "ok"}


# --- Block / unblock user (Apple App Store guideline 1.2 — required) ---
@api.post("/users/{target_user_id}/block")
async def block_user(target_user_id: str, user: dict = Depends(get_current_user)):
    if target_user_id == user["_id"]:
        raise HTTPException(status_code=400, detail="Cannot block yourself")
    await blocks_col.update_one(
        {"blocker_id": user["_id"], "blocked_id": target_user_id},
        {"$setOnInsert": {"_id": str(uuid.uuid4()), "created_at": now_utc()}},
        upsert=True,
    )
    return {"blocked": True}


@api.delete("/users/{target_user_id}/block")
async def unblock_user(target_user_id: str, user: dict = Depends(get_current_user)):
    await blocks_col.delete_one({"blocker_id": user["_id"], "blocked_id": target_user_id})
    return {"blocked": False}


@api.get("/users/me/blocks")
async def list_blocks(user: dict = Depends(get_current_user)):
    cursor = blocks_col.find({"blocker_id": user["_id"]}, {"blocked_id": 1})
    ids = []
    async for b in cursor:
        ids.append(b["blocked_id"])
    return {"blocked_user_ids": ids}


# --- Config endpoint (legal pages read this) ---
@api.get("/config")
async def get_config():
    return {
        "app_name": "WeClips",
        "support_email": SUPPORT_EMAIL,
        "max_video_duration_sec": MAX_VIDEO_DURATION_SEC,
        "max_video_size_bytes": MAX_VIDEO_SIZE_BYTES,
    }


# --- Follow / unfollow ---
@api.post("/users/{target_user_id}/follow")
async def follow_user(target_user_id: str, user: dict = Depends(get_current_user)):
    if target_user_id == user["_id"]:
        raise HTTPException(status_code=400, detail="Cannot follow yourself")
    target = await users_col.find_one({"_id": target_user_id}, {"_id": 1})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    await follows_col.update_one(
        {"follower_id": user["_id"], "followee_id": target_user_id},
        {"$setOnInsert": {"_id": str(uuid.uuid4()), "created_at": now_utc()}},
        upsert=True,
    )
    followers = await follows_col.count_documents({"followee_id": target_user_id})
    return {"following": True, "followers": followers}


@api.delete("/users/{target_user_id}/follow")
async def unfollow_user(target_user_id: str, user: dict = Depends(get_current_user)):
    await follows_col.delete_one({"follower_id": user["_id"], "followee_id": target_user_id})
    followers = await follows_col.count_documents({"followee_id": target_user_id})
    return {"following": False, "followers": followers}


@api.get("/users/{target_user_id}/follow-status")
async def follow_status(target_user_id: str, user: dict = Depends(get_current_user)):
    is_following = bool(
        await follows_col.find_one(
            {"follower_id": user["_id"], "followee_id": target_user_id}, {"_id": 1}
        )
    )
    followers = await follows_col.count_documents({"followee_id": target_user_id})
    following = await follows_col.count_documents({"follower_id": target_user_id})
    return {"following": is_following, "followers": followers, "following_count": following}


# --- Mount ---
app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    # Unique index for usernames (sparse so legacy users without one are OK)
    try:
        await users_col.create_index("username", unique=True, sparse=True)
    except Exception as e:
        logger.warning("Username index creation failed: %s", e)
    # Backfill: assign auto-generated usernames to existing users that lack one
    try:
        cursor = users_col.find(
            {"$or": [{"username": {"$exists": False}}, {"username": None}]},
            {"_id": 1, "display_name": 1, "email": 1},
        )
        async for u in cursor:
            base = _slug_from_display(u.get("display_name") or (u.get("email", "user").split("@")[0]))
            new_username = await _generate_unique_username(base)
            try:
                await users_col.update_one(
                    {"_id": u["_id"]}, {"$set": {"username": new_username}}
                )
            except Exception:
                pass
    except Exception as e:
        logger.warning("Username backfill failed: %s", e)

    # Backfill creator_username on existing videos
    try:
        async for v in videos_col.find(
            {"$or": [{"creator_username": {"$exists": False}}, {"creator_username": None}]},
            {"_id": 1, "creator_id": 1},
        ):
            cid = v.get("creator_id")
            if not cid:
                continue
            u = await users_col.find_one({"_id": cid}, {"username": 1})
            if u and u.get("username"):
                await videos_col.update_one(
                    {"_id": v["_id"]}, {"$set": {"creator_username": u["username"]}}
                )
    except Exception as e:
        logger.warning("Video creator_username backfill failed: %s", e)


@app.on_event("shutdown")
async def shutdown():
    client.close()
