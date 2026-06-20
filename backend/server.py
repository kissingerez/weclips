import os
import math
import re
import uuid
import base64
import hashlib
import hmac
import secrets
import logging
import asyncio
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import httpx
import boto3
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Header, Request, UploadFile, File, Form
from fastapi.responses import Response, FileResponse, StreamingResponse, HTMLResponse
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
APP_PUBLIC_URL = os.environ.get("APP_PUBLIC_URL", "https://weclips.app")
SUBSCRIPTION_PRICE_LABEL = os.environ.get("SUBSCRIPTION_PRICE_LABEL", "$0.99")
# Lifecycle emails (welcome / trial reminder / membership) send from this sender
# so the welcome@ Gravatar shows. Domain weclips.app is authenticated in SendGrid.
LIFECYCLE_SENDER_EMAIL = os.environ.get("LIFECYCLE_SENDER_EMAIL", "welcome@weclips.app")
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY", "")
SENDGRID_SENDER_EMAIL = os.environ.get("SENDGRID_SENDER_EMAIL", "")
PASSWORD_RESET_TTL_MIN = int(os.environ.get("PASSWORD_RESET_TTL_MIN", "15"))
# Email verification (6-digit OTP before login)
EMAIL_VERIFICATION_TTL_MIN = int(os.environ.get("EMAIL_VERIFICATION_TTL_MIN", "15"))
EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC = int(os.environ.get("EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC", "60"))
EMAIL_VERIFICATION_MAX_ATTEMPTS = int(os.environ.get("EMAIL_VERIFICATION_MAX_ATTEMPTS", "5"))

# Upload limits (cost-saving: 180-minute videos only)
MAX_VIDEO_DURATION_SEC = int(os.environ.get("MAX_VIDEO_DURATION_SEC", "10800"))
MAX_VIDEO_SIZE_BYTES = int(os.environ.get("MAX_VIDEO_SIZE_BYTES", str(25 * 1024 * 1024 * 1024)))  # 25 GB hard cap
# Multipart upload part size (R2 caps a single PUT at 5 GiB, so files larger
# than ~4 GiB are uploaded in chunks of this size).
R2_MULTIPART_PART_SIZE = int(os.environ.get("R2_MULTIPART_PART_SIZE", str(128 * 1024 * 1024)))  # 128 MiB

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
# Free teaser length (seconds) guests / non-subscribers can watch before the paywall.
VIDEO_PREVIEW_SECONDS = int(os.environ.get("VIDEO_PREVIEW_SECONDS", "15"))

# TEMPORARY: Android in-app purchases cannot be exercised during Google Play's
# 14-day closed-testing review, which would otherwise leave the app unusable for
# testers. While this flag is on, Android clients get full access WITHOUT writing
# any subscription to the database — flip ANDROID_FREE_ACCESS to "false" (or remove)
# once Android billing is live to instantly restore the paywall. iOS/web unaffected.
ANDROID_FREE_ACCESS = os.environ.get("ANDROID_FREE_ACCESS", "true").lower() == "true"

# --- Emergent managed push notifications (SuprSend relay) ---
# EMERGENT_PUSH_KEY is injected by the deployment pipeline at build time; locally
# it stays "placeholder" (pushes no-op until deployed). Only the backend ever
# talks to the relay — the device token is registered upstream and resolved by
# user id, so we never store tokens ourselves.
EMERGENT_PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
PUSH_BASE_URL = "https://integrations.emergentagent.com"
_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL,
    headers={"X-Push-Key": EMERGENT_PUSH_KEY},
    timeout=10.0,
)

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
email_verifications_col = db["email_verifications"]
sendgrid_events_col = db["sendgrid_events"]
reports_col = db["reports"]
blocks_col = db["blocks"]
follows_col = db["follows"]
notifications_col = db["notifications"]

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
    bio: Optional[str] = None
    has_avatar: bool = False
    followers_hidden: bool = False
    followers: int = 0
    following: int = 0
    is_subscribed: bool
    is_founder: bool = False
    email_public: bool = False
    subscription_status: str
    created_at: datetime
    push_enabled: bool = True
    deletion_pending: bool = False
    deletion_expires_at: Optional[datetime] = None
    # --- Moderation status (visible to the user themselves so the app can
    # show the banner / lock screen). Founder-only state is exposed via
    # the admin endpoints.
    warnings_count: int = 0
    is_banned: bool = False
    banned_until: Optional[datetime] = None
    ban_reason: Optional[str] = None
    ban_type: Optional[str] = None  # "temporary" | "permanent"


class UserSearchResult(BaseModel):
    id: str
    display_name: str
    username: Optional[str] = None
    bio: Optional[str] = None
    has_avatar: bool = False
    followers_hidden: bool = False
    followers: int = 0
    following: int = 0
    # Founder-only moderation fields. Populated by `get_user_public` and
    # `_users_to_results` only when the *viewer* is a founder. Kept on the
    # generic UserSearchResult so the same model serves search + profile.
    is_banned: bool = False
    ban_type: Optional[str] = None
    banned_until: Optional[datetime] = None
    ban_reason: Optional[str] = None
    warnings_count: int = 0
    is_founder: bool = False


class UpdateMeReq(BaseModel):
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    username: Optional[str] = Field(default=None, min_length=3, max_length=20)
    bio: Optional[str] = Field(default=None, max_length=300)
    email: Optional[EmailStr] = None
    followers_hidden: Optional[bool] = None
    email_public: Optional[bool] = None
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
    thumbnail_updated_at: Optional[datetime] = None
    duration_sec: Optional[float] = None
    created_at: datetime


class CommentReq(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class CommentPublic(BaseModel):
    id: str
    video_id: str
    user_id: str
    user_name: str
    text: str
    likes: int = 0
    liked: bool = False
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


# bcrypt hashing/verification is CPU-bound (~250ms each). Running it directly in
# the asyncio event loop serializes all concurrent auth requests and stalls the
# worker, which surfaces as Cloudflare 520/524 ("origin overloaded") under load.
# Always offload to a worker thread so the event loop stays responsive.
async def hash_password_async(p: str) -> str:
    return await asyncio.to_thread(hash_password, p)


async def verify_password_async(p: str, h: str) -> bool:
    return await asyncio.to_thread(verify_password, p, h)


def create_access_token(sub: str) -> str:
    expire = now_utc() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": sub, "exp": expire}, JWT_SECRET, algorithm=JWT_ALG)


async def get_current_user(
    request: Request,
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

    # Auto-lift expired temporary bans so the user regains access naturally.
    bs = _ban_state(user)
    if user.get("is_banned") and not bs["is_banned"]:
        await users_col.update_one(
            {"_id": user_id},
            {
                "$set": {"is_banned": False},
                "$unset": {"banned_until": "", "ban_reason": "", "ban_type": ""},
            },
        )
        user["is_banned"] = False
        user.pop("banned_until", None)
        user.pop("ban_reason", None)
        user.pop("ban_type", None)
        bs = _ban_state(user)

    if bs["is_banned"]:
        # Allow the client to load profile so it can render the lock screen.
        path = request.url.path
        if not (path.endswith("/auth/me") or "/auth/me" in path):
            until = bs["banned_until"].isoformat() if bs["banned_until"] else None
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "account_banned",
                    "ban_type": bs["ban_type"],
                    "banned_until": until,
                    "reason": bs["ban_reason"],
                },
            )
    return user


async def get_current_user_optional(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> Optional[dict]:
    """Returns the authenticated user when a valid bearer token is provided,
    otherwise None. Never raises — useful for endpoints that work both
    signed-in and signed-out (e.g. public feed)."""
    if creds is None:
        return None
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
        if not user_id:
            return None
    except JWTError:
        return None
    return await users_col.find_one({"_id": user_id}, {"password_hash": 0})


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


def _subscription_active(user: dict) -> bool:
    """True only if the user is marked subscribed AND the subscription has not
    lapsed. Real RevenueCat subscribers always carry a future expiry (the
    purchase sync + renewal webhook keep it current, including Apple billing
    grace). Any grant without a future expiry is treated as expired, so nobody
    keeps premium forever."""
    if not user.get("is_subscribed", False):
        return False
    exp = user.get("subscription_expires_at")
    if not exp:
        return False
    if isinstance(exp, str):
        try:
            exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        except Exception:
            return False
    if not isinstance(exp, datetime):
        return False
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return exp > now_utc()


def _platform_bypass(request: Request) -> bool:
    """TEMPORARY Android access bypass for Google Play closed testing. Returns
    True only when ANDROID_FREE_ACCESS is on AND the request comes from an Android
    client (X-Client-Platform header). Writes nothing to the DB; flip the env flag
    off to remove. iOS and web are never affected."""
    if not ANDROID_FREE_ACCESS:
        return False
    return request.headers.get("x-client-platform", "").lower() == "android"


async def require_subscriber(
    request: Request, user: dict = Depends(get_current_user)
) -> dict:
    if not _subscription_active(user) and not _platform_bypass(request):
        raise HTTPException(status_code=402, detail="Active subscription required")
    return user


async def require_founder(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_founder", False):
        raise HTTPException(status_code=403, detail="Founder access required")
    return user


async def require_subscriber_flexible(
    request: Request, user: dict = Depends(get_current_user_flexible),
) -> dict:
    if not _subscription_active(user) and not _platform_bypass(request):
        raise HTTPException(status_code=402, detail="Active subscription required")
    return user


def _ban_state(u: dict) -> dict:
    """Returns the current effective ban state for a user. Auto-expires
    temporary bans once `banned_until` has passed."""
    banned_until = u.get("banned_until")
    if banned_until and banned_until.tzinfo is None:
        banned_until = banned_until.replace(tzinfo=timezone.utc)
    is_banned = bool(u.get("is_banned", False))
    if is_banned and banned_until and banned_until < now_utc():
        is_banned = False
        banned_until = None
    return {
        "is_banned": is_banned,
        "banned_until": banned_until,
        "ban_reason": u.get("ban_reason") if is_banned else None,
        "ban_type": u.get("ban_type") if is_banned else None,
    }


def user_to_public(u: dict, *, followers: int = 0, following: int = 0) -> UserPublic:
    deleted_at = u.get("deleted_at")
    deletion_pending = bool(deleted_at)
    deletion_expires_at = None
    if deleted_at:
        if deleted_at.tzinfo is None:
            deleted_at = deleted_at.replace(tzinfo=timezone.utc)
        deletion_expires_at = deleted_at + timedelta(days=int(os.environ.get("DELETION_GRACE_DAYS", "30")))
    bs = _ban_state(u)
    return UserPublic(
        id=u["_id"],
        email=u["email"],
        display_name=u["display_name"],
        username=u.get("username"),
        bio=u.get("bio"),
        has_avatar=bool(u.get("avatar_base64")),
        followers_hidden=bool(u.get("followers_hidden", False)),
        followers=followers,
        following=following,
        is_subscribed=_subscription_active(u),
        is_founder=bool(u.get("is_founder", False)),
        email_public=bool(u.get("email_public", False)),
        subscription_status=u.get("subscription_status", "none"),
        created_at=u["created_at"],
        push_enabled=bool(u.get("push_enabled", True)),
        deletion_pending=deletion_pending,
        deletion_expires_at=deletion_expires_at,
        warnings_count=int(u.get("warnings_count", 0)),
        is_banned=bs["is_banned"],
        banned_until=bs["banned_until"],
        ban_reason=bs["ban_reason"],
        ban_type=bs["ban_type"],
    )


def video_to_public(v: dict) -> VideoPublic:
    # Be tolerant of projections that strip thumbnail_base64 — many list
    # endpoints exclude it for size. They may instead include a computed
    # `has_thumbnail` field via aggregation, or we infer from the raw blob
    # when present.
    if "has_thumbnail" in v:
        has_thumb = bool(v.get("has_thumbnail"))
    else:
        has_thumb = bool(v.get("thumbnail_base64"))
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
        has_thumbnail=has_thumb,
        thumbnail_updated_at=v.get("thumbnail_updated_at"),
        duration_sec=(float(v["duration_sec"]) if v.get("duration_sec") is not None else None),
        created_at=v["created_at"],
    )


# --- Routes: Auth ---
@api.get("/")
async def root():
    return {"app": "WeClips", "status": "ok"}


@api.post("/auth/signup")
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
        "password_hash": await hash_password_async(body.password),
        "display_name": body.display_name.strip(),
        "username": username,
        "is_subscribed": False,
        "subscription_status": "none",
        "subscription_expires_at": None,
        "rc_last_event": None,
        "rc_environment": None,
        "email_verified": False,
        "created_at": now_utc(),
    }
    await users_col.insert_one(doc)
    dev = await _create_and_send_verification(user_id, email)
    return {"status": "verification_required", "email": email, **dev}


# --- Username availability + search ---
@api.get("/users/username-available")
async def username_available(u: str):
    norm = _normalize_username(u)
    if not USERNAME_RE.match(norm):
        return {"available": False, "reason": "invalid"}
    exists = await users_col.find_one({"username": norm}, {"_id": 1})
    return {"available": not exists, "username": norm}


async def _batch_follower_counts(user_ids: List[str]) -> dict:
    """Return {user_id: follower_count} for the given ids in a single query.
    Avoids the N+1 pattern of calling count_documents per user."""
    if not user_ids:
        return {}
    pipeline = [
        {"$match": {"followee_id": {"$in": user_ids}}},
        {"$group": {"_id": "$followee_id", "n": {"$sum": 1}}},
    ]
    counts: dict = {}
    async for row in follows_col.aggregate(pipeline):
        counts[row["_id"]] = int(row["n"])
    return counts


@api.get("/users/search", response_model=List[UserSearchResult])
async def search_users(
    q: str,
    limit: int = 20,
    user: Optional[dict] = Depends(get_current_user_optional),
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
        {"_id": 1, "display_name": 1, "username": 1, "avatar_base64": 1, "bio": 1, "followers_hidden": 1},
    ).limit(min(max(limit, 1), 50))
    rows: List[dict] = []
    async for u in cursor:
        if user and u["_id"] == user["_id"]:
            continue
        rows.append(u)
    # Batch follower lookup — single $group aggregation instead of N queries.
    visible_ids = [u["_id"] for u in rows if not bool(u.get("followers_hidden", False))]
    counts = await _batch_follower_counts(visible_ids)
    results: List[UserSearchResult] = []
    for u in rows:
        hidden = bool(u.get("followers_hidden", False))
        followers = 0 if hidden else int(counts.get(u["_id"], 0))
        results.append(
            UserSearchResult(
                id=u["_id"],
                display_name=u.get("display_name") or "User",
                username=u.get("username"),
                bio=u.get("bio"),
                has_avatar=bool(u.get("avatar_base64")),
                followers_hidden=hidden,
                followers=followers,
            )
        )
    return results


@api.get("/users/{target_user_id}", response_model=UserSearchResult)
async def get_user_public(target_user_id: str, user: Optional[dict] = Depends(get_current_user_optional)):
    proj = {
        "display_name": 1,
        "username": 1,
        "avatar_base64": 1,
        "bio": 1,
        "followers_hidden": 1,
        "is_founder": 1,
        "is_banned": 1,
        "ban_type": 1,
        "banned_until": 1,
        "ban_reason": 1,
        "warnings_count": 1,
    }
    u = await users_col.find_one({"_id": target_user_id}, proj)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    hidden = bool(u.get("followers_hidden", False))
    # Owner sees their own count even if hidden.
    is_owner = bool(user) and (target_user_id == user["_id"])
    followers = (
        await follows_col.count_documents({"followee_id": target_user_id})
        if (is_owner or not hidden)
        else 0
    )
    following = (
        await follows_col.count_documents({"follower_id": target_user_id})
        if (is_owner or not hidden)
        else 0
    )
    result = UserSearchResult(
        id=u["_id"],
        display_name=u.get("display_name") or "User",
        username=u.get("username"),
        bio=u.get("bio"),
        has_avatar=bool(u.get("avatar_base64")),
        followers_hidden=hidden,
        followers=followers,
        following=following,
        is_founder=bool(u.get("is_founder", False)),
    )
    # Only expose moderation state to other founders.
    if user and user.get("is_founder"):
        bs = _ban_state(u)
        result.is_banned = bs["is_banned"]
        result.ban_type = bs["ban_type"]
        result.banned_until = bs["banned_until"]
        result.ban_reason = bs["ban_reason"]
        result.warnings_count = int(u.get("warnings_count", 0))
    return result


@api.get("/users/{target_user_id}/followers", response_model=List[UserSearchResult])
async def get_user_followers(target_user_id: str, user: dict = Depends(get_current_user)):
    t = await users_col.find_one(
        {"_id": target_user_id}, {"followers_hidden": 1}
    )
    if not t:
        raise HTTPException(status_code=404, detail="User not found")
    is_owner = target_user_id == user["_id"]
    if not is_owner and bool(t.get("followers_hidden", False)):
        raise HTTPException(status_code=403, detail="This user's followers are hidden")
    cursor = follows_col.find({"followee_id": target_user_id}).sort("created_at", -1).limit(500)
    ids: List[str] = []
    async for f in cursor:
        ids.append(f["follower_id"])
    return await _users_to_results(ids, user["_id"])


@api.get("/users/{target_user_id}/following", response_model=List[UserSearchResult])
async def get_user_following(target_user_id: str, user: dict = Depends(get_current_user)):
    t = await users_col.find_one(
        {"_id": target_user_id}, {"followers_hidden": 1}
    )
    if not t:
        raise HTTPException(status_code=404, detail="User not found")
    is_owner = target_user_id == user["_id"]
    if not is_owner and bool(t.get("followers_hidden", False)):
        raise HTTPException(status_code=403, detail="This user's following list is hidden")
    cursor = follows_col.find({"follower_id": target_user_id}).sort("created_at", -1).limit(500)
    ids: List[str] = []
    async for f in cursor:
        ids.append(f["followee_id"])
    return await _users_to_results(ids, user["_id"])


async def _users_to_results(user_ids: List[str], viewer_id: str) -> List[UserSearchResult]:
    if not user_ids:
        return []
    out: List[UserSearchResult] = []
    cursor = users_col.find(
        {"_id": {"$in": user_ids}},
        {"_id": 1, "display_name": 1, "username": 1, "avatar_base64": 1, "bio": 1, "followers_hidden": 1},
    )
    # Preserve roughly the follow chronology
    order = {uid: idx for idx, uid in enumerate(user_ids)}
    rows = []
    async for u in cursor:
        rows.append(u)
    rows.sort(key=lambda u: order.get(u["_id"], 0))
    # Batch follower lookup — only fetch counts for users whose followers are
    # visible to this viewer (owner can always see their own count).
    countable_ids = [
        u["_id"]
        for u in rows
        if (not bool(u.get("followers_hidden", False))) or viewer_id == u["_id"]
    ]
    counts = await _batch_follower_counts(countable_ids)
    for u in rows:
        hidden = bool(u.get("followers_hidden", False))
        followers = (
            int(counts.get(u["_id"], 0))
            if (not hidden or viewer_id == u["_id"])
            else 0
        )
        out.append(
            UserSearchResult(
                id=u["_id"],
                display_name=u.get("display_name") or "User",
                username=u.get("username"),
                bio=u.get("bio"),
                has_avatar=bool(u.get("avatar_base64")),
                followers_hidden=hidden,
                followers=followers,
            )
        )
    return out


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


@api.get("/users/{target_user_id}/videos", response_model=List[VideoPublic])
async def get_user_videos(target_user_id: str, user: Optional[dict] = Depends(get_current_user_optional)):
    cursor = (
        videos_col.find(
            {
                "creator_id": target_user_id,
                "$or": [
                    {"upload_complete": True},
                    {"upload_complete": {"$exists": False}},
                ],
            }
        )
        .sort("created_at", -1)
        .limit(100)
    )
    out: List[VideoPublic] = []
    async for v in cursor:
        out.append(video_to_public(v))
    return out


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
    if not user or not await verify_password_async(body.password, user.get("password_hash") or ""):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    # Email verification gate. Existing users (no field — grandfathered) and
    # verified users pass. Only explicitly-unverified accounts are blocked; we
    # auto-send a fresh code (respecting the resend cooldown) and tell the
    # client to route to the verification screen.
    if user.get("email_verified") is False:
        rec = await email_verifications_col.find_one(
            {"user_id": user["_id"]}, {"last_sent_at": 1}
        )
        can_send = True
        if rec and rec.get("last_sent_at"):
            last = rec["last_sent_at"]
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if (now_utc() - last).total_seconds() < EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC:
                can_send = False
        if can_send:
            await _create_and_send_verification(user["_id"], email)
        raise HTTPException(status_code=403, detail="EMAIL_NOT_VERIFIED")
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
    fol = await follows_col.count_documents({"followee_id": user["_id"]})
    fwn = await follows_col.count_documents({"follower_id": user["_id"]})
    return user_to_public(user, followers=fol, following=fwn)


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

    # Bio
    if body.bio is not None:
        updates["bio"] = body.bio.strip()

    # Followers visibility toggle
    if body.followers_hidden is not None:
        updates["followers_hidden"] = bool(body.followers_hidden)

    # Email visibility toggle
    if body.email_public is not None:
        updates["email_public"] = bool(body.email_public)

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
        if not full or not await verify_password_async(body.current_password, full.get("password_hash", "")):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        updates["password_hash"] = await hash_password_async(body.new_password)

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
    final = refreshed or user
    fol = await follows_col.count_documents({"followee_id": user["_id"]})
    fwn = await follows_col.count_documents({"follower_id": user["_id"]})
    return user_to_public(final, followers=fol, following=fwn)


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
        ok = 200 <= resp.status_code < 300
        msg_id = resp.headers.get("X-Message-Id") if getattr(resp, "headers", None) else None
        if ok:
            logger.info(
                f"SendGrid reset email accepted: to={to_email} from={SENDGRID_SENDER_EMAIL} "
                f"status={resp.status_code} msg_id={msg_id}"
            )
        else:
            logger.error(
                f"SendGrid reset email REJECTED: to={to_email} from={SENDGRID_SENDER_EMAIL} "
                f"status={resp.status_code} body={getattr(resp, 'body', b'')!r}"
            )
        return ok
    except Exception as e:
        logger.exception(f"SendGrid send failed: {e}")
        return False


async def _send_email_nonblocking(fn, *args) -> bool:
    """Run a blocking SendGrid send off the event loop with a hard timeout.

    The SendGrid SDK is synchronous; calling it directly inside an async handler
    blocks the whole asyncio event loop, which under slow/unreachable SendGrid
    conditions stalls ALL requests and surfaces as Cloudflare 520/524 errors on
    the origin. Offloading to a worker thread (bounded by a timeout) keeps the
    loop responsive and guarantees the request returns promptly.
    """
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn, *args), timeout=15)
    except Exception as e:
        logger.warning(f"Email send skipped (timeout/error): {e}")
        return False


def _send_welcome_email(to_email: str, first_name: str, charge_date: str) -> bool:
    """Trial-start welcome email. Logo is baked in via the public /api/assets/logo.png
    URL so it renders in all clients (no inline/CID image)."""
    if not SENDGRID_API_KEY or not SENDGRID_SENDER_EMAIL:
        logger.warning("SendGrid not configured — skipping welcome email")
        return False
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail

        banner = f"{APP_PUBLIC_URL}/api/assets/banner.png"
        price = SUBSCRIPTION_PRICE_LABEL
        html = f"""
        <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0F172A;">
          <div style="margin-bottom:24px;">
            <img src="{banner}" alt="WeClips — Ad-free, Christian, and calm" width="560" style="width:100%;max-width:560px;height:auto;display:block;margin:0 auto;border-radius:12px;" />
          </div>
          <h1 style="font-size:24px;margin:0 0 12px;">Welcome, {first_name} 👋</h1>
          <p style="color:#334155;line-height:1.6;font-size:16px;margin:0 0 20px;">
            Your <b>7-day free trial</b> is live. You can now watch every clip ad-free,
            follow creators, and upload your own. Your first {price} charge will be on <b>{charge_date}</b>.
          </p>
          <p style="margin:0 0 28px;">
            <a href="{APP_PUBLIC_URL}" style="background:#89CFF0;color:#0A1929;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;display:inline-block;">
              Open WeClips &rarr;
            </a>
          </p>
          <h2 style="font-size:18px;margin:0 0 12px;">A few things to try first</h2>
          <ul style="color:#334155;line-height:1.7;font-size:15px;padding-left:20px;margin:0 0 28px;">
            <li>Tap any clip on the Discover page &mdash; they all stream ad-free now.</li>
            <li>Hit the <b>Upload</b> tab and share your first clip (up to 25 GB).</li>
            <li>Use the search bar at the top of Discover to find creators by handle.</li>
          </ul>
          <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;" />
          <p style="color:#64748B;font-size:14px;line-height:1.6;margin:0;">
            Need a hand? Just reply to this email or write to
            <a href="mailto:{SENDGRID_SENDER_EMAIL}" style="color:#2563EB;">{SENDGRID_SENDER_EMAIL}</a>.
            You can cancel anytime from <b>Settings &rarr; Membership &rarr; Manage subscription</b>
            &mdash; no charge if you cancel before day 7.
          </p>
        </div>
        """
        msg = Mail(
            from_email=LIFECYCLE_SENDER_EMAIL,
            to_emails=to_email,
            subject="Welcome to WeClips — your 7-day free trial is live",
            html_content=html,
        )
        resp = SendGridAPIClient(SENDGRID_API_KEY).send(msg)
        ok = 200 <= resp.status_code < 300
        if ok:
            logger.info(f"SendGrid welcome email accepted: to={to_email} status={resp.status_code}")
        else:
            logger.error(
                f"SendGrid welcome email REJECTED: to={to_email} status={resp.status_code} "
                f"body={getattr(resp, 'body', b'')!r}"
            )
        return ok
    except Exception as e:
        logger.exception(f"SendGrid welcome send failed: {e}")
        return False


async def _maybe_send_welcome_email(app_user_id: str) -> None:
    """Send the trial-start welcome email exactly once per user (race-safe via an
    atomic flag flip). Called when RevenueCat reports the first purchase/trial."""
    try:
        doc = await users_col.find_one_and_update(
            {"_id": app_user_id, "welcome_email_sent": {"$ne": True}},
            {"$set": {"welcome_email_sent": True}},
        )
        if not doc or not doc.get("email"):
            return
        first = (doc.get("display_name") or "there").strip().split(" ")[0] or "there"
        exp = doc.get("subscription_expires_at")
        charge_date = f"{exp:%B} {exp.day}, {exp.year}" if isinstance(exp, datetime) else "in 7 days"
        await _send_email_nonblocking(_send_welcome_email, doc["email"], first, charge_date)
    except Exception as e:
        logger.warning(f"welcome email skipped: {e}")


def _send_trial_ending_email(to_email: str, first_name: str, charge_date: str, price: str) -> bool:
    """Day-6 reminder that the free trial converts to a paid subscription tomorrow."""
    if not SENDGRID_API_KEY or not SENDGRID_SENDER_EMAIL:
        logger.warning("SendGrid not configured — skipping trial-ending email")
        return False
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail

        banner = f"{APP_PUBLIC_URL}/api/assets/banner.png"
        html = f"""
        <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0F172A;">
          <div style="margin-bottom:24px;">
            <img src="{banner}" alt="WeClips — Ad-free, Christian, and calm" width="560" style="width:100%;max-width:560px;height:auto;display:block;margin:0 auto;border-radius:12px;" />
          </div>
          <h1 style="font-size:24px;margin:0 0 12px;">Your free trial ends tomorrow, {first_name}</h1>
          <p style="color:#334155;line-height:1.6;font-size:16px;margin:0 0 20px;">
            Heads up — your WeClips free trial wraps up soon. To keep everything ad-free,
            no action is needed: your first <b>{price}</b> charge will be on <b>{charge_date}</b>,
            then it's just {price}/month.
          </p>
          <p style="color:#334155;line-height:1.6;font-size:16px;margin:0 0 28px;">
            Not for you? You can cancel before then and won't be charged a cent.
          </p>
          <p style="margin:0 0 28px;">
            <a href="{APP_PUBLIC_URL}" style="background:#89CFF0;color:#0A1929;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;display:inline-block;">
              Open WeClips &rarr;
            </a>
          </p>
          <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;" />
          <p style="color:#64748B;font-size:14px;line-height:1.6;margin:0;">
            Manage or cancel anytime from <b>Settings &rarr; Membership &rarr; Manage subscription</b>.
            Questions? Just reply or write to
            <a href="mailto:{SENDGRID_SENDER_EMAIL}" style="color:#2563EB;">{SENDGRID_SENDER_EMAIL}</a>.
          </p>
        </div>
        """
        msg = Mail(
            from_email=LIFECYCLE_SENDER_EMAIL,
            to_emails=to_email,
            subject="Your WeClips free trial ends tomorrow",
            html_content=html,
        )
        resp = SendGridAPIClient(SENDGRID_API_KEY).send(msg)
        ok = 200 <= resp.status_code < 300
        if ok:
            logger.info(f"SendGrid trial-ending email accepted: to={to_email} status={resp.status_code}")
        else:
            logger.error(
                f"SendGrid trial-ending email REJECTED: to={to_email} status={resp.status_code} "
                f"body={getattr(resp, 'body', b'')!r}"
            )
        return ok
    except Exception as e:
        logger.exception(f"SendGrid trial-ending send failed: {e}")
        return False


# How far ahead of the trial end we send the day-6 reminder (hours).
TRIAL_REMINDER_WINDOW_HOURS = int(os.environ.get("TRIAL_REMINDER_WINDOW_HOURS", "30"))


async def _run_trial_reminders() -> None:
    """Email + push users whose TRIAL (not a paid renewal) ends within the next
    window. `trial_ends_at` is only set during the trial and cleared on renewal/
    expiry, so paid monthly renewals are never reminded. One reminder per trial."""
    try:
        now = now_utc()
        horizon = now + timedelta(hours=TRIAL_REMINDER_WINDOW_HOURS)
        cursor = users_col.find(
            {
                "trial_ends_at": {"$ne": None, "$gte": now, "$lte": horizon},
                "trial_reminder_sent": {"$ne": True},
            },
            {"_id": 1},
        )
        ids = [u["_id"] async for u in cursor]
        for uid in ids:
            claimed = await users_col.find_one_and_update(
                {"_id": uid, "trial_reminder_sent": {"$ne": True}},
                {"$set": {"trial_reminder_sent": True}},
            )
            if not claimed:
                continue
            first = (claimed.get("display_name") or "there").strip().split(" ")[0] or "there"
            exp = claimed.get("trial_ends_at")
            charge_date = f"{exp:%B} {exp.day}, {exp.year}" if isinstance(exp, datetime) else "soon"
            if claimed.get("email"):
                await _send_email_nonblocking(
                    _send_trial_ending_email, claimed["email"], first, charge_date, SUBSCRIPTION_PRICE_LABEL
                )
            await _notify_push(
                [uid],
                "Your free trial ends tomorrow",
                f"Keep WeClips ad-free — your first {SUBSCRIPTION_PRICE_LABEL} charge is on {charge_date}. Cancel anytime in Settings.",
                action_url="/settings",
            )
        if ids:
            logger.info(f"trial reminders processed: {len(ids)} candidate(s)")
    except Exception as e:
        logger.warning(f"trial reminder run failed: {e}")


async def _trial_reminder_loop() -> None:
    """Background sweep every 6h. Idempotent per user, so multiple replicas are safe."""
    await asyncio.sleep(60)  # let startup work settle
    while True:
        await _run_trial_reminders()
        await asyncio.sleep(6 * 3600)


def _send_subscription_active_email(to_email: str, first_name: str, price: str) -> bool:
    """One-time 'your trial converted — welcome to membership' thank-you, sent when
    the first real charge succeeds after a free trial."""
    if not SENDGRID_API_KEY or not SENDGRID_SENDER_EMAIL:
        logger.warning("SendGrid not configured — skipping membership email")
        return False
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail

        banner = f"{APP_PUBLIC_URL}/api/assets/banner.png"
        html = f"""
        <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0F172A;">
          <div style="margin-bottom:24px;">
            <img src="{banner}" alt="WeClips — Ad-free, Christian, and calm" width="560" style="width:100%;max-width:560px;height:auto;display:block;margin:0 auto;border-radius:12px;" />
          </div>
          <h1 style="font-size:24px;margin:0 0 12px;">You're a WeClips member, {first_name} 🎉</h1>
          <p style="color:#334155;line-height:1.6;font-size:16px;margin:0 0 20px;">
            Your free trial just became a full membership and your {price} payment went through.
            Thank you for supporting an ad-free, calm space — it genuinely means a lot.
          </p>
          <p style="color:#334155;line-height:1.6;font-size:16px;margin:0 0 28px;">
            You're all set: keep watching ad-free, follow your favorite creators, and upload your own clips.
          </p>
          <p style="margin:0 0 28px;">
            <a href="{APP_PUBLIC_URL}" style="background:#89CFF0;color:#0A1929;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;display:inline-block;">
              Open WeClips &rarr;
            </a>
          </p>
          <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;" />
          <p style="color:#64748B;font-size:14px;line-height:1.6;margin:0;">
            Manage or cancel anytime from <b>Settings &rarr; Membership &rarr; Manage subscription</b>.
            Questions? Just reply or write to
            <a href="mailto:{SENDGRID_SENDER_EMAIL}" style="color:#2563EB;">{SENDGRID_SENDER_EMAIL}</a>.
          </p>
        </div>
        """
        msg = Mail(
            from_email=LIFECYCLE_SENDER_EMAIL,
            to_emails=to_email,
            subject="You're a WeClips member 🎉",
            html_content=html,
        )
        resp = SendGridAPIClient(SENDGRID_API_KEY).send(msg)
        ok = 200 <= resp.status_code < 300
        if ok:
            logger.info(f"SendGrid membership email accepted: to={to_email} status={resp.status_code}")
        else:
            logger.error(
                f"SendGrid membership email REJECTED: to={to_email} status={resp.status_code} "
                f"body={getattr(resp, 'body', b'')!r}"
            )
        return ok
    except Exception as e:
        logger.exception(f"SendGrid membership send failed: {e}")
        return False


async def _maybe_send_conversion_email(app_user_id: str) -> None:
    """If the user was in a trial (trial_ends_at set), atomically clear it and send
    the membership thank-you exactly once. No-op for direct (no-trial) renewals and
    for repeat monthly renewals."""
    try:
        converted = await users_col.find_one_and_update(
            {"_id": app_user_id, "trial_ends_at": {"$ne": None}},
            {"$set": {"trial_ends_at": None}},
        )
        if not converted or not converted.get("email"):
            return
        first = (converted.get("display_name") or "there").strip().split(" ")[0] or "there"
        await _send_email_nonblocking(
            _send_subscription_active_email, converted["email"], first, SUBSCRIPTION_PRICE_LABEL
        )
    except Exception as e:
        logger.warning(f"membership email skipped: {e}")



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

    sent = await _send_email_nonblocking(_send_password_reset_email, email, reset_url)
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
    new_hash = await hash_password_async(body.new_password)
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


# --- Email verification (6-digit OTP before login) ---
class VerifyEmailReq(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)


class ResendVerificationReq(BaseModel):
    email: EmailStr


def _generate_otp() -> str:
    return f"{secrets.randbelow(1000000):06d}"


def _send_verification_email(to_email: str, code: str) -> bool:
    """Send the 6-digit code via SendGrid. Returns True on success."""
    if not SENDGRID_API_KEY or not SENDGRID_SENDER_EMAIL:
        logger.warning("SendGrid not configured — skipping verification email")
        return False
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import Mail
        html = f"""
        <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="color:#0F172A;">Verify your WeClips email</h2>
          <p style="color:#475569;line-height:1.5;">
            Enter this code in the app to finish creating your account.
            It expires in {EMAIL_VERIFICATION_TTL_MIN} minutes.
          </p>
          <p style="margin:24px 0;">
            <span style="display:inline-block;background:#F1F5F9;color:#0A1929;padding:14px 24px;border-radius:8px;font-size:30px;font-weight:800;letter-spacing:8px;">
              {code}
            </span>
          </p>
          <p style="color:#64748B;font-size:13px;">
            If you didn't create a WeClips account, you can safely ignore this email.
          </p>
        </div>
        """
        msg = Mail(
            from_email=SENDGRID_SENDER_EMAIL,
            to_emails=to_email,
            subject=f"{code} is your WeClips verification code",
            html_content=html,
        )
        resp = SendGridAPIClient(SENDGRID_API_KEY).send(msg)
        ok = 200 <= resp.status_code < 300
        msg_id = resp.headers.get("X-Message-Id") if getattr(resp, "headers", None) else None
        if ok:
            logger.info(
                f"SendGrid verification email accepted: to={to_email} from={SENDGRID_SENDER_EMAIL} "
                f"status={resp.status_code} msg_id={msg_id}"
            )
        else:
            logger.error(
                f"SendGrid verification email REJECTED: to={to_email} from={SENDGRID_SENDER_EMAIL} "
                f"status={resp.status_code} body={getattr(resp, 'body', b'')!r}"
            )
        return ok
    except Exception as e:
        logger.exception(f"SendGrid verification send failed: {e}")
        return False


async def _create_and_send_verification(user_id: str, email: str) -> dict:
    """Generate a fresh OTP, persist it hashed with expiry, and email it.
    Returns {"dev_code": ...} only when no email service is configured so the
    flow still works in preview. Resets attempts + last_sent_at each time."""
    code = _generate_otp()
    now = now_utc()
    await email_verifications_col.update_one(
        {"user_id": user_id},
        {
            "$set": {
                "user_id": user_id,
                "email": email,
                "code_hash": _hash_token(code),
                "expires_at": now + timedelta(minutes=EMAIL_VERIFICATION_TTL_MIN),
                "attempts": 0,
                "last_sent_at": now,
            },
            "$setOnInsert": {"_id": str(uuid.uuid4()), "created_at": now},
        },
        upsert=True,
    )
    sent = await _send_email_nonblocking(_send_verification_email, email, code)
    out: dict = {}
    if not sent:
        out["dev_code"] = code
        logger.info(f"EMAIL VERIFICATION (dev) for {email}: {code}")
    return out


@api.post("/auth/verify-email", response_model=TokenResp)
async def verify_email(body: VerifyEmailReq):
    email = body.email.lower()
    user = await users_col.find_one({"email": email}, {"_id": 1, "email_verified": 1})
    if not user:
        raise HTTPException(status_code=400, detail="Invalid email or code")
    # Idempotent: already-verified accounts just get a token.
    if user.get("email_verified"):
        return TokenResp(access_token=create_access_token(user["_id"]))

    record = await email_verifications_col.find_one({"user_id": user["_id"]})
    if not record:
        raise HTTPException(status_code=400, detail="No code found. Request a new one.")
    expires_at = record.get("expires_at")
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if not expires_at or expires_at < now_utc():
        raise HTTPException(status_code=400, detail="This code has expired. Request a new one.")
    if record.get("attempts", 0) >= EMAIL_VERIFICATION_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts. Request a new code.")
    if not hmac.compare_digest(record.get("code_hash", ""), _hash_token(body.code.strip())):
        await email_verifications_col.update_one(
            {"_id": record["_id"]}, {"$inc": {"attempts": 1}}
        )
        raise HTTPException(status_code=400, detail="Incorrect code. Please try again.")

    await users_col.update_one({"_id": user["_id"]}, {"$set": {"email_verified": True}})
    await email_verifications_col.delete_one({"_id": record["_id"]})
    return TokenResp(access_token=create_access_token(user["_id"]))


@api.post("/auth/resend-verification")
async def resend_verification(body: ResendVerificationReq):
    email = body.email.lower()
    user = await users_col.find_one(
        {"email": email}, {"_id": 1, "email": 1, "email_verified": 1}
    )
    resp: dict = {"status": "ok"}
    # Never leak which emails exist / are already verified.
    if not user or user.get("email_verified"):
        return resp
    record = await email_verifications_col.find_one(
        {"user_id": user["_id"]}, {"last_sent_at": 1}
    )
    if record and record.get("last_sent_at"):
        last = record["last_sent_at"]
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        wait = EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC - (now_utc() - last).total_seconds()
        if wait > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Please wait {int(wait) + 1}s before requesting another code.",
            )
    dev = await _create_and_send_verification(user["_id"], email)
    resp.update(dev)
    return resp


# --- Routes: Subscription (RevenueCat-backed) ---
@api.get("/subscription/status")
async def subscription_status(user: dict = Depends(get_current_user)):
    return {
        "is_subscribed": _subscription_active(user),
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


# --- Routes: SendGrid Event Webhook (delivery visibility) ---
# Captures async delivery events (delivered/bounce/dropped/deferred/spamreport/...)
# so failures (e.g. Yahoo/Gmail rejecting a free-Gmail From-address for DMARC)
# are visible instead of silently disappearing. Configure in SendGrid:
#   Settings -> Mail Settings / Event Webhook -> POST URL =
#   https://<backend>/api/webhooks/sendgrid  (enable Delivered, Bounced, Dropped,
#   Deferred, Spam Reports).
SENDGRID_PROBLEM_EVENTS = {"bounce", "dropped", "deferred", "spamreport", "blocked"}


@api.post("/webhooks/sendgrid")
async def sendgrid_event_webhook(request: Request):
    try:
        events = await request.json()
    except Exception:
        events = []
    if isinstance(events, dict):
        events = [events]
    if not isinstance(events, list):
        events = []
    now = now_utc()
    docs = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        etype = ev.get("event")
        email = ev.get("email")
        reason = ev.get("reason") or ev.get("response") or ev.get("status")
        if etype in SENDGRID_PROBLEM_EVENTS:
            logger.warning(
                f"SendGrid delivery problem: event={etype} to={email} reason={reason!r}"
            )
        else:
            logger.info(f"SendGrid event: {etype} to={email}")
        docs.append(
            {
                "_id": str(uuid.uuid4()),
                "event": etype,
                "email": email,
                "reason": reason,
                "sg_message_id": ev.get("sg_message_id"),
                "sg_event_id": ev.get("sg_event_id"),
                "timestamp": ev.get("timestamp"),
                "received_at": now.isoformat(),
            }
        )
    if docs:
        try:
            await sendgrid_events_col.insert_many(docs)
            # Keep only the most recent ~2000 events.
            count = await sendgrid_events_col.count_documents({})
            if count > 2000:
                old = (
                    await sendgrid_events_col.find({}, {"_id": 1})
                    .sort("received_at", 1)
                    .limit(count - 2000)
                    .to_list(length=count - 2000)
                )
                if old:
                    await sendgrid_events_col.delete_many(
                        {"_id": {"$in": [d["_id"] for d in old]}}
                    )
        except Exception:
            logger.exception("Failed to store SendGrid events")
    return {"status": "ok", "received": len(docs)}


@api.get("/admin/email-events")
async def admin_email_events(limit: int = 100, user: dict = Depends(require_founder)):
    """Founder-only: recent SendGrid delivery events, newest first."""
    limit = max(1, min(limit, 500))
    rows = (
        await sendgrid_events_col.find({}, {"_id": 0})
        .sort("received_at", -1)
        .limit(limit)
        .to_list(length=limit)
    )
    problems = [r for r in rows if r.get("event") in SENDGRID_PROBLEM_EVENTS]
    return {"count": len(rows), "problem_count": len(problems), "events": rows}


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
        # Track the trial window so the day-6 reminder only targets trials, never
        # paid renewals. Set on trial start; cleared on conversion (see below).
        if event_type == "INITIAL_PURCHASE" and update.get("subscription_expires_at"):
            update["trial_ends_at"] = update["subscription_expires_at"]
    elif event_type in INACTIVE_EVENTS:
        update["is_subscribed"] = False
        update["subscription_status"] = "expired" if event_type == "EXPIRATION" else "billing_issue"
        update["trial_ends_at"] = None
    elif event_type == "CANCELLATION":
        # Keep is_subscribed=true until EXPIRATION
        update["subscription_status"] = "cancelled"
    else:
        return {"status": "ignored", "event": event_type}

    await users_col.update_one({"_id": app_user_id}, {"$set": update}, upsert=False)

    # Trial starts -> one-time welcome email (idempotent; won't touch existing members).
    if event_type == "INITIAL_PURCHASE":
        await _maybe_send_welcome_email(app_user_id)
    # First charge after a trial -> one-time "you're a member" thank-you (also clears
    # trial_ends_at). No-op for direct purchases and repeat monthly renewals.
    elif event_type in ("RENEWAL", "PRODUCT_CHANGE"):
        await _maybe_send_conversion_email(app_user_id)

    return {"status": "ok", "event": event_type}


# --- Routes: Videos ---
class UploadUrlReq(BaseModel):
    title: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=2000)
    mime_type: str = Field(default="video/mp4")
    no_ai_confirmed: bool = False


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


# --- Multipart upload (for large files; R2 caps a single PUT at 5 GiB) ---
class MultipartCreateReq(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    mime_type: str = Field(default="video/mp4")
    no_ai_confirmed: bool
    total_size: int = Field(gt=0)


class MultipartPart(BaseModel):
    part_number: int
    url: str


class MultipartCreateResp(BaseModel):
    video_id: str
    upload_id: str
    object_key: str
    part_size: int
    parts: List[MultipartPart]
    expires_in: int


class MultipartCompleteReq(BaseModel):
    upload_id: str
    client_duration_sec: Optional[float] = None


@api.post("/videos/multipart/create", response_model=MultipartCreateResp)
async def create_multipart_upload(
    body: MultipartCreateReq, user: dict = Depends(require_subscriber)
):
    if not body.no_ai_confirmed:
        raise HTTPException(status_code=400, detail="You must confirm the WeClips content policy")
    if s3 is None:
        raise HTTPException(status_code=500, detail="Cloud storage not configured")
    if body.total_size > MAX_VIDEO_SIZE_BYTES:
        max_gb = MAX_VIDEO_SIZE_BYTES // (1024 * 1024 * 1024)
        raise HTTPException(
            status_code=413, detail=f"File too large. Max {max_gb} GB per upload."
        )

    video_id = str(uuid.uuid4())
    object_key = _r2_key_for(video_id, body.mime_type)
    content_type = body.mime_type or "video/mp4"

    try:
        mp = s3.create_multipart_upload(
            Bucket=R2_BUCKET, Key=object_key, ContentType=content_type
        )
        upload_id = mp["UploadId"]
    except Exception as e:
        logger.exception("R2 create_multipart_upload failed")
        raise HTTPException(status_code=500, detail=f"Storage error: {e}")

    part_size = R2_MULTIPART_PART_SIZE
    part_count = max(1, math.ceil(body.total_size / part_size))
    parts: List[MultipartPart] = []
    try:
        for n in range(1, part_count + 1):
            purl = s3.generate_presigned_url(
                ClientMethod="upload_part",
                Params={
                    "Bucket": R2_BUCKET,
                    "Key": object_key,
                    "UploadId": upload_id,
                    "PartNumber": n,
                },
                ExpiresIn=R2_PRESIGN_UPLOAD_TTL,
            )
            parts.append(MultipartPart(part_number=n, url=purl))
    except Exception as e:
        logger.exception("R2 presign upload_part failed")
        try:
            s3.abort_multipart_upload(Bucket=R2_BUCKET, Key=object_key, UploadId=upload_id)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Storage error: {e}")

    await videos_col.insert_one(
        {
            "_id": video_id,
            "title": body.title.strip(),
            "description": body.description.strip(),
            "mime_type": content_type,
            "storage": "r2",
            "r2_key": object_key,
            "r2_upload_id": upload_id,
            "multipart": True,
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
    return MultipartCreateResp(
        video_id=video_id,
        upload_id=upload_id,
        object_key=object_key,
        part_size=part_size,
        parts=parts,
        expires_in=R2_PRESIGN_UPLOAD_TTL,
    )


@api.post("/videos/{video_id}/multipart/complete", response_model=VideoPublic)
async def complete_multipart_upload(
    video_id: str, body: MultipartCompleteReq, user: dict = Depends(require_subscriber)
):
    v = await videos_col.find_one({"_id": video_id})
    if not v or v.get("creator_id") != user["_id"]:
        raise HTTPException(status_code=404, detail="Video not found")
    if v.get("upload_complete"):
        return video_to_public(v)
    if s3 is None or not v.get("r2_key") or not v.get("r2_upload_id"):
        raise HTTPException(status_code=400, detail="Not a multipart upload")
    upload_id = body.upload_id or v["r2_upload_id"]

    # Gather uploaded parts server-side via ListParts. This avoids requiring the
    # client to read each part's ETag (which would need R2 CORS to expose it).
    parts: list = []
    marker = 0
    try:
        while True:
            resp = s3.list_parts(
                Bucket=R2_BUCKET, Key=v["r2_key"], UploadId=upload_id, PartNumberMarker=marker
            )
            for p in resp.get("Parts", []):
                parts.append({"ETag": p["ETag"], "PartNumber": p["PartNumber"]})
            if resp.get("IsTruncated"):
                marker = resp.get("NextPartNumberMarker", 0)
            else:
                break
    except Exception:
        logger.exception("R2 list_parts failed")
        raise HTTPException(status_code=400, detail="Could not verify uploaded parts. Please retry.")

    if not parts:
        raise HTTPException(status_code=400, detail="No uploaded parts found. Please retry the upload.")
    parts.sort(key=lambda p: p["PartNumber"])

    try:
        s3.complete_multipart_upload(
            Bucket=R2_BUCKET,
            Key=v["r2_key"],
            UploadId=upload_id,
            MultipartUpload={"Parts": parts},
        )
    except Exception as e:
        logger.exception("R2 complete_multipart_upload failed")
        raise HTTPException(status_code=400, detail=f"Could not finalize upload: {e}")

    # Verify the final object + size
    try:
        head = s3.head_object(Bucket=R2_BUCKET, Key=v["r2_key"])
    except Exception:
        raise HTTPException(status_code=400, detail="Upload not found in storage. Please retry.")
    size = int(head.get("ContentLength", 0))
    if size <= 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if size > MAX_VIDEO_SIZE_BYTES:
        try:
            s3.delete_object(Bucket=R2_BUCKET, Key=v["r2_key"])
        except Exception:
            pass
        await videos_col.delete_one({"_id": video_id})
        max_gb = MAX_VIDEO_SIZE_BYTES // (1024 * 1024 * 1024)
        raise HTTPException(status_code=413, detail=f"File too large. Max {max_gb} GB per upload.")

    duration_sec: Optional[float] = None
    try:
        probe_url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": R2_BUCKET, "Key": v["r2_key"]}, ExpiresIn=300
        )
        duration_sec = await _ffprobe_duration(probe_url)
    except Exception as exc:
        logger.warning("ffprobe duration check failed: %s", exc)
    if (not duration_sec) and body.client_duration_sec and body.client_duration_sec > 0:
        duration_sec = float(body.client_duration_sec)
    if duration_sec and duration_sec > MAX_VIDEO_DURATION_SEC + 1:
        try:
            s3.delete_object(Bucket=R2_BUCKET, Key=v["r2_key"])
        except Exception:
            pass
        await videos_col.delete_one({"_id": video_id})
        max_min = MAX_VIDEO_DURATION_SEC // 60
        raise HTTPException(
            status_code=413,
            detail=f"Video is too long ({int(duration_sec)}s). Maximum is {max_min} minute(s).",
        )

    update: dict = {"upload_complete": True, "file_size": size}
    if duration_sec:
        update["duration_sec"] = round(duration_sec, 2)
    await videos_col.update_one({"_id": video_id}, {"$set": update})
    v.update(update)
    await _notify_new_video_to_followers(user, video_id, v.get("title"))
    return video_to_public(v)


@api.post("/videos/{video_id}/multipart/abort")
async def abort_multipart_upload(video_id: str, user: dict = Depends(require_subscriber)):
    v = await videos_col.find_one({"_id": video_id})
    if not v or v.get("creator_id") != user["_id"]:
        raise HTTPException(status_code=404, detail="Video not found")
    if s3 is not None and v.get("r2_key") and v.get("r2_upload_id"):
        try:
            s3.abort_multipart_upload(
                Bucket=R2_BUCKET, Key=v["r2_key"], UploadId=v["r2_upload_id"]
            )
        except Exception:
            pass
    await videos_col.delete_one({"_id": video_id})
    return {"status": "ok"}


class CompleteUploadReq(BaseModel):
    client_duration_sec: Optional[float] = None
    title: Optional[str] = None
    description: Optional[str] = None
    no_ai_confirmed: Optional[bool] = None


@api.post("/videos/{video_id}/complete", response_model=VideoPublic)
async def complete_upload(
    video_id: str,
    body: Optional[CompleteUploadReq] = None,
    user: dict = Depends(require_subscriber),
):
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
            detail=f"File too large ({size // (1024*1024)} MB). Max {MAX_VIDEO_SIZE_BYTES // (1024*1024*1024)} GB per upload. Try lowering resolution.",
        )

    # Server-side duration enforcement (clients can be bypassed). We probe via
    # a presigned URL so we never have to download the whole file — ffprobe
    # only needs the moov atom. If probing fails, we accept the upload to
    # avoid false negatives on exotic encodes.
    duration_sec: Optional[float] = None
    try:
        probe_url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": R2_BUCKET, "Key": v["r2_key"]},
            ExpiresIn=300,
        )
        duration_sec = await _ffprobe_duration(probe_url)
    except Exception as exc:
        logger.warning("ffprobe duration check failed: %s", exc)

    if duration_sec and duration_sec > MAX_VIDEO_DURATION_SEC + 1:
        try:
            s3.delete_object(Bucket=R2_BUCKET, Key=v["r2_key"])
        except Exception:
            pass
        await videos_col.delete_one({"_id": video_id})
        max_min = MAX_VIDEO_DURATION_SEC // 60
        raise HTTPException(
            status_code=413,
            detail=f"Video is too long ({int(duration_sec)}s). Maximum is {max_min} minute(s).",
        )

    update: dict = {"upload_complete": True, "file_size": size}
    # Eager-upload flow: title/description/policy arrive at publish time (the
    # file was staged on select). Enforce them here since this is when the
    # video goes live.
    if body and body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title is required")
        if body.no_ai_confirmed is not True:
            raise HTTPException(status_code=400, detail="You must confirm the WeClips content policy")
        update["title"] = t[:120]
        if body.description is not None:
            update["description"] = body.description.strip()[:2000]
    # Prefer the server-probed duration; fall back to the client-measured value
    # (expo-image-picker asset duration) when ffprobe isn't available so the
    # duration chip still renders.
    final_dur = duration_sec
    if (not final_dur) and body and body.client_duration_sec and body.client_duration_sec > 0:
        final_dur = float(body.client_duration_sec)
    if final_dur:
        update["duration_sec"] = round(final_dur, 2)
    await videos_col.update_one({"_id": video_id}, {"$set": update})
    v.update(update)
    await _notify_new_video_to_followers(user, video_id, v.get("title"))
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
    if not _subscription_active(user):
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
async def list_videos(
    q: Optional[str] = None,
    limit: int = 50,
    user: Optional[dict] = Depends(get_current_user_optional),
):
    query: dict = {"$or": [{"upload_complete": True}, {"upload_complete": {"$exists": False}}]}
    # Filter out users this viewer has blocked, AND users who have blocked this viewer
    if user:
        excluded: set = set()
        async for b in blocks_col.find({"blocker_id": user["_id"]}, {"blocked_id": 1}):
            excluded.add(b["blocked_id"])
        async for b in blocks_col.find({"blocked_id": user["_id"]}, {"blocker_id": 1}):
            excluded.add(b["blocker_id"])
        if excluded:
            query = {"$and": [query, {"creator_id": {"$nin": list(excluded)}}]}
    if q:
        text_filter = {
            "$or": [
                {"title": {"$regex": q, "$options": "i"}},
                {"description": {"$regex": q, "$options": "i"}},
                {"creator_name": {"$regex": q, "$options": "i"}},
            ]
        }
        query = {"$and": [query, text_filter]} if "$and" not in query else {**query, "$and": query["$and"] + [text_filter]}
    cursor = videos_col.find(
        query, {"content_base64": 0, "thumbnail_base64": 0, "liked_by": 0}
    ).sort("created_at", -1).limit(min(limit, 100))
    items = []
    async for v in cursor:
        items.append(video_to_public(v))
    return items


@api.get("/videos/following", response_model=List[VideoPublic])
async def list_following_videos(
    limit: int = 50,
    user: dict = Depends(get_current_user),
):
    """Feed of videos only from creators the current user follows (matches web)."""
    followee_ids: List[str] = []
    async for f in follows_col.find({"follower_id": user["_id"]}, {"followee_id": 1}):
        followee_ids.append(f["followee_id"])
    if not followee_ids:
        return []

    # Exclude blocked users (either direction), same as the discover feed.
    excluded: set = set()
    async for b in blocks_col.find({"blocker_id": user["_id"]}, {"blocked_id": 1}):
        excluded.add(b["blocked_id"])
    async for b in blocks_col.find({"blocked_id": user["_id"]}, {"blocker_id": 1}):
        excluded.add(b["blocker_id"])
    creator_ids = [cid for cid in followee_ids if cid not in excluded]
    if not creator_ids:
        return []

    query = {
        "$and": [
            {"$or": [{"upload_complete": True}, {"upload_complete": {"$exists": False}}]},
            {"creator_id": {"$in": creator_ids}},
        ]
    }
    cursor = (
        videos_col.find(query, {"content_base64": 0, "thumbnail_base64": 0, "liked_by": 0})
        .sort("created_at", -1)
        .limit(min(limit, 100))
    )
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
async def get_video(video_id: str, user: Optional[dict] = Depends(get_current_user_optional)):
    v = await videos_col.find_one(
        {"_id": video_id}, {"content_base64": 0, "thumbnail_base64": 0, "liked_by": 0}
    )
    if not v:
        raise HTTPException(status_code=404, detail="Not found")
    # Count unique views — same user refreshing doesn't bump the count
    viewed_by = v.get("viewed_by", []) or []
    if user and user["_id"] not in viewed_by:
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


@api.get("/videos/{video_id}/preview-url")
async def get_preview_url(
    video_id: str, user: Optional[dict] = Depends(get_current_user_optional)
):
    """Free teaser stream for guests and non-subscribers (Apple 5.1.1 — let
    people sample before they buy). Subscribers should use /stream-url for the
    full video; this endpoint always returns the first `preview_seconds` worth,
    enforced client-side by pausing the player."""
    v = await videos_col.find_one(
        {"_id": video_id},
        {"storage": 1, "r2_key": 1, "file_path": 1, "content_base64": 1, "mime_type": 1},
    )
    if not v:
        raise HTTPException(status_code=404, detail="Not found")

    if v.get("storage") == "r2" and v.get("r2_key") and s3 is not None:
        try:
            url = s3.generate_presigned_url(
                ClientMethod="get_object",
                Params={"Bucket": R2_BUCKET, "Key": v["r2_key"]},
                ExpiresIn=R2_PRESIGN_STREAM_TTL,
            )
            return {
                "stream_url": url,
                "preview_seconds": VIDEO_PREVIEW_SECONDS,
                "expires_in": R2_PRESIGN_STREAM_TTL,
            }
        except Exception as e:
            logger.exception("R2 presign GET failed")
            raise HTTPException(status_code=500, detail=f"Storage error: {e}")

    # Legacy videos can't be previewed without a token; surface as unavailable.
    raise HTTPException(status_code=404, detail="Preview unavailable")


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


async def _video_source_for_processing(v: dict) -> Optional[str]:
    """Return a URL/path the server can hand to ffmpeg.
    Prefers a short-lived R2 presigned GET URL; falls back to legacy disk path."""
    if v.get("storage") == "r2" and v.get("r2_key") and s3 is not None:
        try:
            return s3.generate_presigned_url(
                ClientMethod="get_object",
                Params={"Bucket": R2_BUCKET, "Key": v["r2_key"]},
                ExpiresIn=300,
            )
        except Exception:
            return None
    fp = v.get("file_path")
    if fp and Path(fp).exists():
        return str(fp)
    return None


async def _ffprobe_duration(source: str) -> Optional[float]:
    """Run ffprobe to get duration in seconds. Returns None on failure."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            source,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
        return float(out.decode().strip()) if out else None
    except Exception:
        return None


async def _backfill_video_durations():
    """One-time background pass: compute duration_sec for legacy videos that
    were uploaded before we probed it. Runs ffprobe against an R2 presigned
    URL (or the legacy disk file / base64 blob) and patches the document so
    VideoCard can render the duration chip on old videos too."""
    try:
        cursor = videos_col.find(
            {"$or": [{"duration_sec": {"$exists": False}}, {"duration_sec": None}]},
            {
                "_id": 1,
                "storage": 1,
                "r2_key": 1,
                "file_path": 1,
                "content_base64": 1,
                "mime_type": 1,
            },
        )
        patched = 0
        async for v in cursor:
            tmp = None
            try:
                src = await _video_source_for_processing(v)
                if not src and v.get("content_base64"):
                    fd, tmp = tempfile.mkstemp(suffix=".mp4")
                    with os.fdopen(fd, "wb") as fh:
                        fh.write(base64.b64decode(v["content_base64"]))
                    src = tmp
                if not src:
                    continue
                dur = await _ffprobe_duration(src)
                if dur and dur > 0:
                    await videos_col.update_one(
                        {"_id": v["_id"]}, {"$set": {"duration_sec": round(dur, 2)}}
                    )
                    patched += 1
            except Exception:
                continue
            finally:
                if tmp:
                    try:
                        os.unlink(tmp)
                    except Exception:
                        pass
        if patched:
            logger.info("Duration backfill: patched %d legacy video(s)", patched)
    except Exception as e:
        logger.warning("Duration backfill failed: %s", e)


async def _ffmpeg_extract_frame(source: str, at_sec: float, out_path: str) -> bool:
    """Extract a single JPEG frame at the given time. Returns True on success."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y",
            "-ss", f"{max(0.0, at_sec):.2f}",
            "-i", source,
            "-frames:v", "1",
            # Scale to up to 1280px wide, keep aspect, ensure even dimensions
            "-vf", "scale='min(1280,iw)':-2:flags=lanczos",
            # Lower q:v = higher quality (2 is near-visually-lossless for JPEG)
            "-q:v", "2",
            "-pix_fmt", "yuvj420p",
            "-f", "image2",
            out_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=30)
        return Path(out_path).exists() and Path(out_path).stat().st_size > 200
    except Exception:
        return False


@api.get("/videos/{video_id}/thumbnail-options")
async def get_thumbnail_options(
    video_id: str,
    user: dict = Depends(get_current_user),
):
    """Server-side extraction of 3 thumbnail candidates (Start/Middle/End)
    from an already-uploaded video. Creator only."""
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise HTTPException(status_code=503, detail="ffmpeg not available on server")
    v = await videos_col.find_one({"_id": video_id})
    if not v:
        raise HTTPException(status_code=404, detail="Video not found")
    if v.get("creator_id") != user["_id"]:
        raise HTTPException(status_code=403, detail="Only the creator can generate thumbnails")

    src = await _video_source_for_processing(v)
    if not src:
        raise HTTPException(status_code=404, detail="Video file not accessible")

    duration = await _ffprobe_duration(src)
    # Fall back if we can't probe (e.g. signed URL hides metadata)
    if not duration or duration <= 0:
        duration = 6.0

    targets = [
        ("Start", min(1.0, duration * 0.10)),
        ("Middle", duration * 0.50),
        ("End", max(1.0, duration * 0.85)),
    ]

    results: List[dict] = []
    with tempfile.TemporaryDirectory(prefix="weclips_thumbs_") as tmpdir:
        for idx, (label, at_sec) in enumerate(targets):
            out_path = os.path.join(tmpdir, f"frame_{idx}.jpg")
            ok = await _ffmpeg_extract_frame(src, at_sec, out_path)
            if not ok:
                continue
            try:
                with open(out_path, "rb") as f:
                    raw = f.read()
                if len(raw) > 800_000:
                    # safety cap (~800KB encoded JPEG)
                    continue
                results.append(
                    {
                        "label": label,
                        "at_sec": round(at_sec, 2),
                        "base64": base64.b64encode(raw).decode("ascii"),
                    }
                )
            except Exception:
                continue

    if not results:
        raise HTTPException(status_code=500, detail="Could not extract any frames")
    return {"options": results, "duration_sec": round(duration, 2)}


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
        {"_id": video_id},
        {
            "$set": {
                "thumbnail_base64": raw,
                "thumbnail_updated_at": now_utc(),
                "has_thumbnail": True,
            }
        },
    )
    return {"ok": True, "has_thumbnail": True}


@api.post("/videos/{video_id}/like")
async def like_video(video_id: str, user: dict = Depends(require_subscriber)):
    v = await videos_col.find_one(
        {"_id": video_id}, {"liked_by": 1, "likes": 1, "creator_id": 1, "title": 1}
    )
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
    # Notify creator. Collapse repeat likes by upserting one row per (actor, video).
    try:
        await notifications_col.update_one(
            {
                "recipient_id": v.get("creator_id"),
                "type": "like",
                "actor_id": user["_id"],
                "video_id": video_id,
            },
            {
                "$set": {
                    "_id": str(uuid.uuid4()),
                    "recipient_id": v.get("creator_id"),
                    "type": "like",
                    "actor_id": user["_id"],
                    "actor_name": user.get("display_name") or "Someone",
                    "actor_username": user.get("username"),
                    "actor_has_avatar": bool(user.get("avatar_base64")),
                    "video_id": video_id,
                    "video_title": v.get("title"),
                    "read": False,
                    "created_at": now_utc(),
                }
            },
            upsert=True,
        )
    except Exception as e:
        logger.warning("like notification failed: %s", e)
    await _notify_push(
        [v.get("creator_id")],
        "New like",
        f'{user.get("display_name") or "Someone"} liked your video',
        action_url=f"/video/{video_id}",
    )
    return {"liked": True, "likes": int(v.get("likes", 0)) + 1}


@api.get("/videos/{video_id}/comments", response_model=List[CommentPublic])
async def list_comments(video_id: str, user: dict = Depends(require_subscriber)):
    cursor = comments_col.find({"video_id": video_id}).sort("created_at", -1).limit(200)
    out = []
    async for c in cursor:
        liked_by = c.get("liked_by", []) or []
        out.append(
            CommentPublic(
                id=c["_id"],
                video_id=c["video_id"],
                user_id=c["user_id"],
                user_name=c["user_name"],
                text=c["text"],
                likes=int(c.get("likes", 0)),
                liked=user["_id"] in liked_by,
                created_at=c["created_at"],
            )
        )
    return out


@api.post("/videos/{video_id}/comments/{comment_id}/like")
async def like_comment(
    video_id: str,
    comment_id: str,
    user: dict = Depends(require_subscriber),
):
    c = await comments_col.find_one(
        {"_id": comment_id, "video_id": video_id},
        {"liked_by": 1, "likes": 1, "user_id": 1},
    )
    if not c:
        raise HTTPException(status_code=404, detail="Comment not found")
    liked_by = c.get("liked_by", []) or []
    if user["_id"] in liked_by:
        await comments_col.update_one(
            {"_id": comment_id},
            {"$pull": {"liked_by": user["_id"]}, "$inc": {"likes": -1}},
        )
        return {"liked": False, "likes": max(0, int(c.get("likes", 0)) - 1)}
    await comments_col.update_one(
        {"_id": comment_id},
        {"$addToSet": {"liked_by": user["_id"]}, "$inc": {"likes": 1}},
    )
    return {"liked": True, "likes": int(c.get("likes", 0)) + 1}


@api.post("/videos/{video_id}/comments", response_model=CommentPublic)
async def add_comment(video_id: str, body: CommentReq, user: dict = Depends(require_subscriber)):
    v = await videos_col.find_one({"_id": video_id}, {"_id": 1, "creator_id": 1, "title": 1})
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
    # Notify the video's creator
    try:
        await _create_notification(
            recipient_id=v.get("creator_id"),
            actor=user,
            type_="comment",
            video_id=video_id,
            video_title=v.get("title"),
            text=body.text.strip()[:200],
        )
    except Exception as e:
        logger.warning("comment notification failed: %s", e)
    await _notify_push(
        [v.get("creator_id")],
        "New comment",
        f'{user.get("display_name") or "Someone"}: {body.text.strip()[:80]}',
        action_url=f"/video/{video_id}",
    )
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
    is_founder = bool(user.get("is_founder"))
    if not (is_author or is_owner or is_founder):
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
    is_owner = v.get("creator_id") == user["_id"]
    is_founder = bool(user.get("is_founder"))
    if not (is_owner or is_founder):
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


class SimpleReportReq(BaseModel):
    reason: str = Field(min_length=2, max_length=500)


@api.post("/videos/{video_id}/report")
async def report_video(
    video_id: str, body: SimpleReportReq, user: dict = Depends(get_current_user)
):
    v = await videos_col.find_one({"_id": video_id}, {"_id": 1, "title": 1, "creator_id": 1})
    if not v:
        raise HTTPException(status_code=404, detail="Video not found")
    report_id = str(uuid.uuid4())
    await reports_col.insert_one(
        {
            "_id": report_id,
            "reporter_id": user["_id"],
            "target_type": "video",
            "target_id": video_id,
            "reason": body.reason.strip(),
            "status": "open",
            "created_at": now_utc(),
        }
    )
    await _notify_founders_of_report(
        actor=user,
        target_type="video",
        target_id=video_id,
        target_label=v.get("title"),
        reason=body.reason.strip(),
        report_id=report_id,
    )
    return {"status": "ok"}


@api.post("/users/{target_user_id}/report")
async def report_user(
    target_user_id: str,
    body: SimpleReportReq,
    user: dict = Depends(get_current_user),
):
    if target_user_id == user["_id"]:
        raise HTTPException(status_code=400, detail="Cannot report yourself")
    target = await users_col.find_one(
        {"_id": target_user_id}, {"_id": 1, "display_name": 1, "username": 1}
    )
    label = None
    if target:
        label = target.get("display_name") or target.get("username")
    report_id = str(uuid.uuid4())
    await reports_col.insert_one(
        {
            "_id": report_id,
            "reporter_id": user["_id"],
            "target_type": "user",
            "target_id": target_user_id,
            "reason": body.reason.strip(),
            "status": "open",
            "created_at": now_utc(),
        }
    )
    await _notify_founders_of_report(
        actor=user,
        target_type="user",
        target_id=target_user_id,
        target_label=label,
        reason=body.reason.strip(),
        report_id=report_id,
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


@api.get("/users/me/blocks/list", response_model=List[UserSearchResult])
async def list_blocks_detailed(user: dict = Depends(get_current_user)):
    cursor = blocks_col.find({"blocker_id": user["_id"]}).sort("created_at", -1)
    ids: List[str] = []
    async for b in cursor:
        ids.append(b["blocked_id"])
    if not ids:
        return []
    out: List[UserSearchResult] = []
    async for u in users_col.find(
        {"_id": {"$in": ids}},
        {"_id": 1, "display_name": 1, "username": 1, "avatar_base64": 1, "bio": 1, "followers_hidden": 1},
    ):
        hidden = bool(u.get("followers_hidden", False))
        followers = 0 if hidden else await follows_col.count_documents({"followee_id": u["_id"]})
        out.append(
            UserSearchResult(
                id=u["_id"],
                display_name=u.get("display_name") or "User",
                username=u.get("username"),
                bio=u.get("bio"),
                has_avatar=bool(u.get("avatar_base64")),
                followers_hidden=hidden,
                followers=followers,
            )
        )
    return out


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
    # Notify the followed user (idempotent for follow type)
    try:
        await _create_notification(
            recipient_id=target_user_id, actor=user, type_="follow"
        )
    except Exception as e:
        logger.warning("follow notification failed: %s", e)
    await _notify_push(
        [target_user_id],
        "New follower",
        f'{user.get("display_name") or "Someone"} started following you',
        action_url=f"/user/{user['_id']}",
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


class NotificationPublic(BaseModel):
    id: str
    type: str  # 'follow' | 'comment' | 'like' | 'report'
    actor_id: str
    actor_name: str
    actor_username: Optional[str] = None
    actor_has_avatar: bool = False
    video_id: Optional[str] = None
    video_title: Optional[str] = None
    text: Optional[str] = None
    report_id: Optional[str] = None
    report_target_type: Optional[str] = None
    read: bool = False
    created_at: datetime


async def _create_notification(
    *,
    recipient_id: str,
    actor: dict,
    type_: str,
    video_id: Optional[str] = None,
    video_title: Optional[str] = None,
    text: Optional[str] = None,
):
    """Insert a notification doc. Silently ignores self-actions and duplicate
    follow events (so re-following doesn't spam the bell)."""
    if recipient_id == actor["_id"]:
        return
    doc = {
        "_id": str(uuid.uuid4()),
        "recipient_id": recipient_id,
        "type": type_,
        "actor_id": actor["_id"],
        "actor_name": actor.get("display_name") or "Someone",
        "actor_username": actor.get("username"),
        "actor_has_avatar": bool(actor.get("avatar_base64")),
        "video_id": video_id,
        "video_title": video_title,
        "text": text,
        "read": False,
        "created_at": now_utc(),
    }
    # For follow events, collapse re-follows by upserting a single row. `_id`
    # must live in $setOnInsert only — Mongo rejects modifying it on update.
    if type_ == "follow":
        set_fields = {k: val for k, val in doc.items() if k != "_id"}
        await notifications_col.update_one(
            {"recipient_id": recipient_id, "type": "follow", "actor_id": actor["_id"]},
            {"$set": set_fields, "$setOnInsert": {"_id": doc["_id"]}},
            upsert=True,
        )
    else:
        await notifications_col.insert_one(doc)


@api.get("/notifications", response_model=List[NotificationPublic])
async def list_notifications(user: dict = Depends(get_current_user), limit: int = 50):
    cursor = (
        notifications_col.find({"recipient_id": user["_id"]})
        .sort("created_at", -1)
        .limit(min(max(limit, 1), 100))
    )
    out: List[NotificationPublic] = []
    async for n in cursor:
        out.append(
            NotificationPublic(
                id=n["_id"],
                type=n["type"],
                actor_id=n["actor_id"],
                actor_name=n.get("actor_name") or "Someone",
                actor_username=n.get("actor_username"),
                actor_has_avatar=bool(n.get("actor_has_avatar")),
                video_id=n.get("video_id"),
                video_title=n.get("video_title"),
                text=n.get("text"),
                report_id=n.get("report_id"),
                report_target_type=n.get("report_target_type"),
                read=bool(n.get("read")),
                created_at=n["created_at"],
            )
        )
    return out


@api.get("/notifications/unread-count")
async def unread_count(user: dict = Depends(get_current_user)):
    c = await notifications_col.count_documents(
        {"recipient_id": user["_id"], "read": False}
    )
    return {"count": c}


@api.post("/notifications/mark-read")
async def mark_read(user: dict = Depends(get_current_user)):
    result = await notifications_col.update_many(
        {"recipient_id": user["_id"], "read": False}, {"$set": {"read": True}}
    )
    return {"modified": result.modified_count}


# ---------------------------------------------------------------------------
# Push notifications (Emergent managed relay)
# ---------------------------------------------------------------------------
class RegisterPushReq(BaseModel):
    platform: str  # "ios" | "android"
    device_token: str


class PushPreferenceReq(BaseModel):
    enabled: bool


async def send_push(recipients: List[str], data: dict) -> None:
    """Relay a push to the Emergent managed push service. `recipients` are app
    user IDs (tokens are resolved upstream). Backend-only — never expose."""
    if not recipients:
        return
    for i in range(0, len(recipients), 100):
        chunk = recipients[i : i + 100]
        resp = await _push_client.post(
            "/api/v1/push/trigger", json={"recipients": chunk, "data": data}
        )
        resp.raise_for_status()


async def _notify_push(recipient_ids, title, message, action_url=None):
    """Best-effort push to users who haven't disabled notifications. Swallows
    every error so push delivery never blocks the primary request."""
    try:
        ids = [r for r in dict.fromkeys(recipient_ids) if r]
        if not ids:
            return
        disabled = set()
        async for u in users_col.find(
            {"_id": {"$in": ids}, "push_enabled": False}, {"_id": 1}
        ):
            disabled.add(u["_id"])
        ids = [r for r in ids if r not in disabled]
        if not ids:
            return
        data = {"title": title, "message": message}
        if action_url:
            data["action_url"] = action_url
        await send_push(ids, data)
    except Exception as e:
        logger.warning("push notification failed (non-blocking): %s", e)


async def _notify_new_video_to_followers(creator: dict, video_id: str, title: Optional[str]):
    """In-app + push notify a creator's followers that a new video is live."""
    creator_name = creator.get("display_name") or "Someone"
    vid_title = (title or "a new video").strip()[:120]
    follower_ids: List[str] = []
    cursor = follows_col.find({"followee_id": creator["_id"]}, {"follower_id": 1}).limit(2000)
    async for f in cursor:
        fid = f.get("follower_id")
        if fid and fid != creator["_id"]:
            follower_ids.append(fid)
    if not follower_ids:
        return
    docs = [
        {
            "_id": str(uuid.uuid4()),
            "recipient_id": fid,
            "type": "new_video",
            "actor_id": creator["_id"],
            "actor_name": creator_name,
            "actor_username": creator.get("username"),
            "actor_has_avatar": bool(creator.get("avatar_base64")),
            "video_id": video_id,
            "video_title": vid_title,
            "text": None,
            "read": False,
            "created_at": now_utc(),
        }
        for fid in follower_ids
    ]
    try:
        await notifications_col.insert_many(docs, ordered=False)
    except Exception as e:
        logger.warning("new_video in-app notify failed: %s", e)
    await _notify_push(
        follower_ids,
        f"{creator_name} posted",
        vid_title,
        action_url=f"/video/{video_id}",
    )


@api.post("/register-push", status_code=201)
async def register_push(body: RegisterPushReq, user: dict = Depends(get_current_user)):
    """Register this device's native push token with the managed relay, keyed to
    the authenticated user so future pushes resolve to all their devices."""
    payload = {
        "user_id": user["_id"],
        "platform": body.platform,
        "device_token": body.device_token,
    }
    try:
        resp = await _push_client.post("/api/v1/push/users/register", json=payload)
        if resp.status_code in (401, 403):
            raise HTTPException(status_code=500, detail="Push key missing or invalid")
        resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("register-push relay failed: %s", e)
        raise HTTPException(status_code=502, detail="Push provider unavailable")
    return {"status": "registered"}


@api.post("/notifications/push-preference")
async def set_push_preference(
    body: PushPreferenceReq, user: dict = Depends(get_current_user)
):
    await users_col.update_one(
        {"_id": user["_id"]}, {"$set": {"push_enabled": bool(body.enabled)}}
    )
    return {"push_enabled": bool(body.enabled)}


# ---------------------------------------------------------------------------
# Founder moderation — report queue
# ---------------------------------------------------------------------------
async def _notify_founders_of_report(
    *,
    actor: dict,
    target_type: str,
    target_id: str,
    target_label: Optional[str],
    reason: str,
    report_id: str,
):
    """Send an in-app notification to every founder when a report is filed."""
    actor_name = actor.get("display_name") or "Someone"
    label = target_label or ("a video" if target_type == "video" else "a user")
    short_reason = (reason or "").strip()
    if len(short_reason) > 160:
        short_reason = short_reason[:157] + "…"
    text = f'Reported {target_type} "{label}": {short_reason}'

    founders = users_col.find({"is_founder": True}, {"_id": 1})
    founder_ids: List[str] = []
    async for f in founders:
        if f["_id"] == actor["_id"]:
            continue
        founder_ids.append(f["_id"])
        await notifications_col.insert_one(
            {
                "_id": str(uuid.uuid4()),
                "recipient_id": f["_id"],
                "type": "report",
                "actor_id": actor["_id"],
                "actor_name": actor_name,
                "actor_username": actor.get("username"),
                "actor_has_avatar": bool(actor.get("avatar_base64")),
                "video_id": target_id if target_type == "video" else None,
                "video_title": target_label if target_type == "video" else None,
                "text": text,
                "report_id": report_id,
                "report_target_type": target_type,
                "report_target_id": target_id,
                "read": False,
                "created_at": now_utc(),
            }
        )
    await _notify_push(
        founder_ids,
        "New report to review",
        text,
        action_url="/admin/reports",
    )


class AdminReport(BaseModel):
    id: str
    target_type: str
    target_id: str
    reason: str
    status: str
    created_at: datetime
    reporter_id: str
    reporter_name: Optional[str] = None
    reporter_username: Optional[str] = None
    # Enriched target info
    video_title: Optional[str] = None
    video_thumbnail_url: Optional[str] = None
    video_creator_id: Optional[str] = None
    video_creator_name: Optional[str] = None
    user_display_name: Optional[str] = None
    user_username: Optional[str] = None
    target_missing: bool = False
    # Moderation state of the user being moderated (uploader for video reports,
    # the user themselves for user reports). Useful for spotting repeat offenders.
    target_user_id: Optional[str] = None
    target_warnings_count: int = 0
    target_is_banned: bool = False
    target_ban_type: Optional[str] = None
    target_banned_until: Optional[datetime] = None


@api.get("/admin/reports", response_model=List[AdminReport])
async def list_reports(
    status: str = "open",
    limit: int = 100,
    user: dict = Depends(require_founder),
):
    if status not in ("open", "resolved", "dismissed", "all"):
        raise HTTPException(status_code=400, detail="Invalid status filter")
    q: dict = {} if status == "all" else {"status": status}
    cursor = reports_col.find(q).sort("created_at", -1).limit(min(max(limit, 1), 500))
    rows: List[dict] = [r async for r in cursor]

    reporter_ids = list({r["reporter_id"] for r in rows})
    video_ids = list({r["target_id"] for r in rows if r["target_type"] == "video"})
    user_ids = list({r["target_id"] for r in rows if r["target_type"] == "user"})

    reporters_map: dict = {}
    if reporter_ids:
        async for u in users_col.find(
            {"_id": {"$in": reporter_ids}},
            {"_id": 1, "display_name": 1, "username": 1},
        ):
            reporters_map[u["_id"]] = u

    videos_map: dict = {}
    if video_ids:
        async for v in videos_col.find(
            {"_id": {"$in": video_ids}},
            {
                "_id": 1,
                "title": 1,
                "has_thumbnail": 1,
                "thumbnail_updated_at": 1,
                "creator_id": 1,
                "creator_name": 1,
            },
        ):
            videos_map[v["_id"]] = v

    # Resolve every "target user" (uploader for video reports + target for user reports)
    target_user_ids = set(user_ids)
    for v in videos_map.values():
        if v.get("creator_id"):
            target_user_ids.add(v["creator_id"])
    target_users_map: dict = {}
    if target_user_ids:
        async for tu in users_col.find(
            {"_id": {"$in": list(target_user_ids)}},
            {
                "_id": 1,
                "display_name": 1,
                "username": 1,
                "is_banned": 1,
                "ban_type": 1,
                "banned_until": 1,
                "warnings_count": 1,
            },
        ):
            target_users_map[tu["_id"]] = tu

    users_map: dict = {k: v for k, v in target_users_map.items() if k in user_ids}

    out: List[AdminReport] = []
    for r in rows:
        rep = reporters_map.get(r["reporter_id"])
        item = AdminReport(
            id=r["_id"],
            target_type=r["target_type"],
            target_id=r["target_id"],
            reason=r.get("reason", ""),
            status=r.get("status", "open"),
            created_at=r["created_at"],
            reporter_id=r["reporter_id"],
            reporter_name=(rep.get("display_name") if rep else None),
            reporter_username=(rep.get("username") if rep else None),
        )
        moderated_user: Optional[dict] = None
        if r["target_type"] == "video":
            v = videos_map.get(r["target_id"])
            if v:
                item.video_title = v.get("title")
                item.video_creator_id = v.get("creator_id")
                item.video_creator_name = v.get("creator_name")
                if v.get("has_thumbnail"):
                    ts = v.get("thumbnail_updated_at")
                    suffix = f"?v={ts.isoformat()}" if ts else ""
                    item.video_thumbnail_url = f"/videos/{v['_id']}/thumbnail{suffix}"
                if v.get("creator_id"):
                    moderated_user = target_users_map.get(v["creator_id"])
            else:
                item.target_missing = True
        else:  # user
            tu = users_map.get(r["target_id"])
            if tu:
                item.user_display_name = tu.get("display_name")
                item.user_username = tu.get("username")
                moderated_user = tu
            else:
                item.target_missing = True
        if moderated_user:
            bs = _ban_state(moderated_user)
            item.target_user_id = moderated_user["_id"]
            item.target_warnings_count = int(moderated_user.get("warnings_count", 0))
            item.target_is_banned = bs["is_banned"]
            item.target_ban_type = bs["ban_type"]
            item.target_banned_until = bs["banned_until"]
        out.append(item)
    return out


@api.get("/admin/reports/summary")
async def admin_reports_summary(user: dict = Depends(require_founder)):
    open_count = await reports_col.count_documents({"status": "open"})
    return {"open": open_count}


@api.post("/admin/reports/{report_id}/dismiss")
async def dismiss_report(report_id: str, user: dict = Depends(require_founder)):
    r = await reports_col.find_one({"_id": report_id})
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    await reports_col.update_one(
        {"_id": report_id},
        {
            "$set": {
                "status": "dismissed",
                "resolved_by": user["_id"],
                "resolved_at": now_utc(),
                "resolution": "dismissed",
            }
        },
    )
    return {"status": "ok"}


@api.post("/admin/reports/{report_id}/delete-content")
async def admin_delete_reported_content(
    report_id: str, user: dict = Depends(require_founder)
):
    r = await reports_col.find_one({"_id": report_id})
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    target_type = r["target_type"]
    target_id = r["target_id"]

    if target_type == "video":
        v = await videos_col.find_one({"_id": target_id})
        if v:
            # Best-effort: remove the underlying R2 object too (mirrors the
            # behaviour of the standard delete endpoint).
            try:
                if v.get("r2_key"):
                    s3.delete_object(Bucket=R2_BUCKET, Key=v["r2_key"])
            except Exception as exc:
                logger.warning("R2 delete failed during admin moderation: %s", exc)
            await videos_col.delete_one({"_id": target_id})
            await comments_col.delete_many({"video_id": target_id})
    # For target_type == "user" we do NOT auto-delete the account here.
    # Founder still has the option to manually act after reviewing.

    # Resolve every open report that pointed at the same target.
    await reports_col.update_many(
        {"target_type": target_type, "target_id": target_id, "status": "open"},
        {
            "$set": {
                "status": "resolved",
                "resolved_by": user["_id"],
                "resolved_at": now_utc(),
                "resolution": "content_deleted" if target_type == "video" else "acknowledged",
            }
        },
    )
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Founder moderation — user actions (warn / suspend / ban / unban)
# ---------------------------------------------------------------------------
WARNING_BODY = (
    "We aim to create a fun environment at WeClips. Repeated violations to "
    "our policies may result in temporary or permanent deletion of your account."
)


async def _target_user_from_report(report: dict) -> Optional[dict]:
    """Resolve the user being moderated for a report row. Video reports
    target the uploader; user reports target the user directly."""
    if report["target_type"] == "user":
        return await users_col.find_one({"_id": report["target_id"]})
    if report["target_type"] == "video":
        v = await videos_col.find_one(
            {"_id": report["target_id"]}, {"creator_id": 1}
        )
        if v:
            return await users_col.find_one({"_id": v.get("creator_id")})
    return None


async def _notify_user_moderation(
    *, target_user_id: str, founder: dict, kind: str, text: str
):
    """Drop a notification into the target user's bell explaining the action."""
    if target_user_id == founder["_id"]:
        return
    await notifications_col.insert_one(
        {
            "_id": str(uuid.uuid4()),
            "recipient_id": target_user_id,
            "type": kind,  # 'warning' | 'suspended' | 'banned'
            "actor_id": founder["_id"],
            "actor_name": "WeClips Moderation",
            "actor_username": None,
            "actor_has_avatar": False,
            "video_id": None,
            "video_title": None,
            "text": text,
            "read": False,
            "created_at": now_utc(),
        }
    )


async def _resolve_reports_for_target(
    *, target_type: str, target_id: str, founder_id: str, resolution: str
):
    """Mark every open report against this target as resolved."""
    await reports_col.update_many(
        {"target_type": target_type, "target_id": target_id, "status": "open"},
        {
            "$set": {
                "status": "resolved",
                "resolved_by": founder_id,
                "resolved_at": now_utc(),
                "resolution": resolution,
            }
        },
    )


class ModerationActionReq(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=500)


class SuspendReq(BaseModel):
    days: int = Field(ge=1, le=365)
    reason: Optional[str] = Field(default=None, max_length=500)


@api.post("/admin/reports/{report_id}/warn")
async def admin_warn_user(
    report_id: str,
    body: ModerationActionReq,
    user: dict = Depends(require_founder),
):
    r = await reports_col.find_one({"_id": report_id})
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    target = await _target_user_from_report(r)
    if not target:
        raise HTTPException(status_code=404, detail="Target user not found")
    if target.get("is_founder"):
        raise HTTPException(status_code=400, detail="Cannot warn a founder")

    new_count = int(target.get("warnings_count", 0)) + 1
    await users_col.update_one(
        {"_id": target["_id"]},
        {
            "$set": {"last_warning_at": now_utc(), "warnings_count": new_count},
            "$push": {
                "warning_history": {
                    "at": now_utc(),
                    "by": user["_id"],
                    "report_id": r["_id"],
                    "reason": (body.reason or r.get("reason") or "").strip()[:500],
                }
            },
        },
    )

    reason = (body.reason or r.get("reason") or "").strip()
    msg = WARNING_BODY
    if reason:
        msg = f"Warning regarding: {reason}\n\n{WARNING_BODY}"
    await _notify_user_moderation(
        target_user_id=target["_id"],
        founder=user,
        kind="warning",
        text=msg,
    )
    await _resolve_reports_for_target(
        target_type=r["target_type"],
        target_id=r["target_id"],
        founder_id=user["_id"],
        resolution="warned",
    )
    return {"status": "ok", "warnings_count": new_count}


@api.post("/admin/reports/{report_id}/suspend")
async def admin_suspend_user(
    report_id: str,
    body: SuspendReq,
    user: dict = Depends(require_founder),
):
    r = await reports_col.find_one({"_id": report_id})
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    target = await _target_user_from_report(r)
    if not target:
        raise HTTPException(status_code=404, detail="Target user not found")
    if target["_id"] == user["_id"]:
        raise HTTPException(status_code=400, detail="Cannot moderate yourself")
    if target.get("is_founder"):
        raise HTTPException(status_code=400, detail="Cannot suspend a founder")

    until = now_utc() + timedelta(days=int(body.days))
    reason = (body.reason or r.get("reason") or "").strip()[:500]
    await users_col.update_one(
        {"_id": target["_id"]},
        {
            "$set": {
                "is_banned": True,
                "ban_type": "temporary",
                "banned_until": until,
                "ban_reason": reason or None,
                "banned_at": now_utc(),
                "banned_by": user["_id"],
            }
        },
    )
    msg = (
        f"Your account has been suspended for {body.days} day(s) until "
        f"{until.strftime('%b %d, %Y')}."
    )
    if reason:
        msg += f"\n\nReason: {reason}"
    msg += f"\n\n{WARNING_BODY}"
    await _notify_user_moderation(
        target_user_id=target["_id"],
        founder=user,
        kind="suspended",
        text=msg,
    )
    await _resolve_reports_for_target(
        target_type=r["target_type"],
        target_id=r["target_id"],
        founder_id=user["_id"],
        resolution=f"suspended_{body.days}d",
    )
    return {"status": "ok", "banned_until": until.isoformat()}


@api.post("/admin/reports/{report_id}/ban")
async def admin_ban_user(
    report_id: str,
    body: ModerationActionReq,
    user: dict = Depends(require_founder),
):
    r = await reports_col.find_one({"_id": report_id})
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    target = await _target_user_from_report(r)
    if not target:
        raise HTTPException(status_code=404, detail="Target user not found")
    if target["_id"] == user["_id"]:
        raise HTTPException(status_code=400, detail="Cannot moderate yourself")
    if target.get("is_founder"):
        raise HTTPException(status_code=400, detail="Cannot ban a founder")

    reason = (body.reason or r.get("reason") or "").strip()[:500]
    await users_col.update_one(
        {"_id": target["_id"]},
        {
            "$set": {
                "is_banned": True,
                "ban_type": "permanent",
                "banned_until": None,
                "ban_reason": reason or None,
                "banned_at": now_utc(),
                "banned_by": user["_id"],
            }
        },
    )
    msg = "Your WeClips account has been permanently banned."
    if reason:
        msg += f"\n\nReason: {reason}"
    msg += (
        "\n\nYou will no longer be able to use WeClips. If you believe this "
        "decision was made in error, contact support@weclips.app."
    )
    await _notify_user_moderation(
        target_user_id=target["_id"],
        founder=user,
        kind="banned",
        text=msg,
    )
    await _resolve_reports_for_target(
        target_type=r["target_type"],
        target_id=r["target_id"],
        founder_id=user["_id"],
        resolution="banned",
    )
    return {"status": "ok"}


@api.post("/admin/users/{target_user_id}/unban")
async def admin_unban_user(
    target_user_id: str, user: dict = Depends(require_founder)
):
    target = await users_col.find_one({"_id": target_user_id})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    await users_col.update_one(
        {"_id": target_user_id},
        {
            "$set": {"is_banned": False},
            "$unset": {
                "banned_until": "",
                "ban_reason": "",
                "ban_type": "",
                "banned_at": "",
                "banned_by": "",
            },
        },
    )
    await _notify_user_moderation(
        target_user_id=target_user_id,
        founder=user,
        kind="warning",
        text="Your WeClips account has been reinstated. Welcome back.",
    )
    return {"status": "ok"}


class BannedAccount(BaseModel):
    id: str
    display_name: str
    username: Optional[str] = None
    has_avatar: bool = False
    ban_type: Optional[str] = None
    banned_until: Optional[datetime] = None
    banned_at: Optional[datetime] = None
    ban_reason: Optional[str] = None
    warnings_count: int = 0


@api.get("/admin/banned-accounts", response_model=List[BannedAccount])
async def admin_banned_accounts(user: dict = Depends(require_founder)):
    """Lists every account that is currently banned (temporary or permanent)
    so the founder can lift bans without finding the originating report."""
    cursor = users_col.find(
        {"is_banned": True},
        {
            "_id": 1,
            "display_name": 1,
            "username": 1,
            "avatar_base64": 1,
            "is_banned": 1,
            "ban_type": 1,
            "banned_until": 1,
            "banned_at": 1,
            "ban_reason": 1,
            "warnings_count": 1,
        },
    ).sort("banned_at", -1).limit(500)
    out: List[BannedAccount] = []
    async for u in cursor:
        bs = _ban_state(u)
        if not bs["is_banned"]:
            # Auto-expired temp ban — lift it lazily.
            await users_col.update_one(
                {"_id": u["_id"]},
                {
                    "$set": {"is_banned": False},
                    "$unset": {"banned_until": "", "ban_reason": "", "ban_type": ""},
                },
            )
            continue
        out.append(
            BannedAccount(
                id=u["_id"],
                display_name=u.get("display_name") or "User",
                username=u.get("username"),
                has_avatar=bool(u.get("avatar_base64")),
                ban_type=bs["ban_type"],
                banned_until=bs["banned_until"],
                banned_at=u.get("banned_at"),
                ban_reason=bs["ban_reason"],
                warnings_count=int(u.get("warnings_count", 0)),
            )
        )
    return out
def _legal_page(title: str, body_html: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} · WeClips</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Comic Sans MS", "Comic Sans", sans-serif; background: #F4FAFF; color: #1A1A1A; line-height: 1.55; }}
  header {{ background: #9CD3F5; color: #0B2A45; padding: 32px 24px; text-align: center; }}
  header h1 {{ margin: 0; font-size: 32px; letter-spacing: -0.5px; }}
  header .tag {{ font-size: 12px; letter-spacing: 2px; text-transform: uppercase; opacity: 0.85; margin-top: 8px; }}
  main {{ max-width: 760px; margin: 0 auto; padding: 32px 24px 64px; }}
  main h2 {{ font-size: 20px; margin-top: 32px; margin-bottom: 8px; color: #0B2A45; }}
  main h3 {{ font-size: 16px; margin-top: 24px; margin-bottom: 4px; color: #0B2A45; }}
  main p, main li {{ font-size: 15px; }}
  main ul {{ padding-left: 22px; }}
  main a {{ color: #1B7FC7; }}
  .updated {{ color: #5A6470; font-size: 13px; margin-top: -4px; margin-bottom: 16px; }}
  footer {{ text-align: center; font-size: 12px; color: #5A6470; padding: 24px 16px 48px; }}
  footer a {{ color: #1B7FC7; margin: 0 8px; }}
</style>
</head>
<body>
<header>
  <h1>WeClips</h1>
  <div class="tag">AD-FREE · CHRISTIAN · CALM</div>
</header>
<main>
  <h1 style="font-size:24px;margin-bottom:4px;">{title}</h1>
  <p class="updated">Last updated: June 4, 2026</p>
  {body_html}
</main>
<footer>
  <a href="/api/legal/privacy">Privacy Policy</a> ·
  <a href="/api/legal/terms">Terms of Service</a> ·
  <a href="/api/legal/support">Support</a>
  <div style="margin-top:8px;">© 2026 WeClips</div>
</footer>
</body>
</html>
"""


_PRIVACY_BODY = """
<p>WeClips ("we", "us", or "our") respects your privacy. This policy explains what we collect, how we use it, and the choices you have. WeClips is a Christian-friendly, ad-free, member-supported short video sharing service.</p>

<h2>1. Information we collect</h2>
<h3>You give us</h3>
<ul>
  <li><b>Account info</b> — email address, password (hashed with bcrypt), display name, username, optional bio, optional profile picture.</li>
  <li><b>Content you upload</b> — videos, comments, likes, follows, reports.</li>
  <li><b>Subscription receipts</b> — purchase records from Apple/Google verified through RevenueCat. We never receive your credit card or full payment details.</li>
</ul>
<h3>Collected automatically</h3>
<ul>
  <li>Approximate IP address (for security and abuse prevention only — not stored long-term).</li>
  <li>Server access logs (URL, status code, timestamp) for diagnostics.</li>
  <li>In-app interaction events such as view counts and like counts on videos.</li>
</ul>

<h2>2. How we use it</h2>
<ul>
  <li>Provide the service: store and stream the videos you upload, deliver comments and follows.</li>
  <li>Authenticate you and protect your account.</li>
  <li>Send transactional email such as password reset links via SendGrid.</li>
  <li>Process subscriptions through Apple, Google, and RevenueCat.</li>
  <li>Enforce our Community Guidelines (no demonic, sexual, hateful, or AI-generated content).</li>
</ul>

<h2>3. Third-party processors we share data with</h2>
<ul>
  <li><b>Cloudflare R2</b> — stores your uploaded videos.</li>
  <li><b>MongoDB</b> — stores account, comment, follow, and metadata records.</li>
  <li><b>SendGrid</b> — sends password reset emails.</li>
  <li><b>RevenueCat / Apple / Google</b> — process subscription purchases.</li>
</ul>
<p>We do not sell or rent your data, and we do not run third-party advertising trackers.</p>

<h2>4. Children</h2>
<p>WeClips is not directed at children under 13. We do not knowingly collect data from children under 13. If we learn that a child under 13 has created an account, we will delete it.</p>

<h2>5. Your choices</h2>
<ul>
  <li><b>Edit or delete your data</b> — change display name, username, bio, email, password, or profile picture from the in-app <i>Edit account</i> screen.</li>
  <li><b>Hide your followers</b> — toggle in <i>Edit account</i>.</li>
  <li><b>Hide your email</b> — off by default; opt in from <i>Edit account</i>.</li>
  <li><b>Delete your account</b> — tap <i>Delete account</i> in <i>Profile</i>. You have a 30-day grace period to sign back in and restore. After 30 days everything is permanently erased.</li>
  <li><b>Block or report users / videos</b> — long-press a user or video to access these actions.</li>
</ul>

<h2>6. Data retention</h2>
<p>We keep your account data while your account is active. After you request deletion, your data is fully purged 30 days later. Backups are rotated and overwritten within 30 days.</p>

<h2>7. Security</h2>
<p>Passwords are stored as bcrypt hashes. All traffic uses HTTPS. Videos are uploaded directly to Cloudflare R2 over presigned URLs. Subscription receipts are validated server-side.</p>

<h2>8. Changes to this policy</h2>
<p>We will update this page whenever the practices change. For material changes we will notify you in-app or by email.</p>

<h2>9. Contact</h2>
<p>Questions or requests? Email <a href="mailto:support@weclips.app">support@weclips.app</a>.</p>
"""

_TERMS_BODY = """
<p>By using WeClips you agree to these Terms.</p>

<h2>1. Account</h2>
<p>You must be at least 13 years old. You are responsible for safeguarding your password and for all activity on your account.</p>

<h2>2. Community Guidelines</h2>
<p>WeClips is a Christian-friendly community. You agree <b>not</b> to upload, post, or share content that:</p>
<ul>
  <li>Is sexually explicit, demonic, or violent in a glorifying way.</li>
  <li>Promotes hate, harassment, or violence against any person or group.</li>
  <li>Is generated by AI in whole or part. All content must be authored by you and depict real people, places, or scenes.</li>
  <li>Infringes copyright, trademark, or other intellectual-property rights.</li>
  <li>Contains malware, scams, or unsolicited advertising.</li>
</ul>
<p>We may remove any content and suspend or delete accounts that violate these rules.</p>

<h2>3. Membership and billing</h2>
<p>WeClips is $1 (USD) per month and unlocks ad-free viewing and uploading. Subscriptions auto-renew through Apple or Google until canceled. Manage or cancel anytime in your device's subscription settings.</p>

<h2>4. Your content</h2>
<p>You keep ownership of the videos and other content you upload. By uploading you grant WeClips a worldwide, royalty-free license to store, transmit, and display that content for the purpose of operating the service.</p>

<h2>5. Termination</h2>
<p>You may delete your account at any time from the Profile screen. We may suspend or terminate an account that violates these Terms or our Community Guidelines.</p>

<h2>6. Disclaimers</h2>
<p>WeClips is provided "as is". We do our best to keep the service running but make no guarantees of uninterrupted availability.</p>

<h2>7. Limitation of liability</h2>
<p>To the maximum extent allowed by law, WeClips is not liable for indirect, incidental, or consequential damages arising from your use of the service.</p>

<h2>8. Governing law</h2>
<p>These Terms are governed by the laws of the United States and the state where the WeClips founder resides.</p>

<h2>9. Contact</h2>
<p>Questions? Email <a href="mailto:support@weclips.app">support@weclips.app</a>.</p>
"""

_SUPPORT_BODY = """
<p>Need help? We're a small team and read every message.</p>

<h2>Owner &amp; operator</h2>
<p>WeClips is owned and operated by <b>Nixon Kissinger Rodriguez, International</b>.</p>

<h2>Email support</h2>
<p><a href="mailto:support@weclips.app">support@weclips.app</a></p>

<h2>Common questions</h2>
<h3>How do I cancel my $1/month membership?</h3>
<p>iPhone: Open <b>Settings</b> → tap your name → <b>Subscriptions</b> → tap <b>WeClips</b> → <b>Cancel Subscription</b>. Android: Open <b>Google Play Store</b> → tap your profile → <b>Payments &amp; subscriptions</b> → <b>Subscriptions</b> → <b>WeClips</b> → <b>Cancel</b>.</p>
<h3>How do I delete my account?</h3>
<p>Open the app → <b>Profile</b> tab → scroll to the bottom → tap <b>Delete account</b>. You have 30 days to change your mind by signing back in and tapping <b>Restore</b>.</p>
<h3>How do I report a video or user?</h3>
<p>Tap the video → use the <b>Report</b> option. Or open the user's profile → tap <b>Report</b>. We review every report.</p>
<h3>I forgot my password.</h3>
<p>On the Sign-in screen tap <b>Reset password</b>, enter your email, and we'll send a reset link.</p>
<h3>Upload won't finish.</h3>
<p>Make sure you're on Wi-Fi and your video is under 2&nbsp;GB. If the issue persists, email us with the video name and approximate size.</p>

<h2>Bug reports</h2>
<p>Include your iPhone/Android model, the version of the app, your username, and a short description of what happened.</p>
"""

_DELETE_ACCOUNT_BODY = """
<p>This page explains how to delete your <b>WeClips</b> account and the data we
remove when you do. You can request deletion directly inside the app, or contact
us by email if you can't access the app.</p>

<h2>Delete from inside the app</h2>
<ol>
  <li>Open <b>WeClips</b> and sign in.</li>
  <li>Go to the <b>Profile</b> tab.</li>
  <li>Scroll to the bottom and tap <b>Delete account</b>.</li>
  <li>Confirm. Your account is immediately deactivated.</li>
</ol>

<h2>Can't access the app?</h2>
<p>Email <a href="mailto:support@weclips.app">support@weclips.app</a> from the
address on your account with the subject "Delete my account". We'll verify
ownership and process the deletion for you.</p>

<h2>30-day grace period</h2>
<p>Deletion is reversible for <b>30 days</b>: sign back in within that window and
tap <b>Restore</b> to cancel it. After 30 days the deletion becomes permanent and
cannot be undone.</p>

<h2>What gets deleted</h2>
<p>When deletion becomes permanent we erase your account and the personal data
tied to it, including:</p>
<ul>
  <li>Your profile (email, username, display name, bio, avatar).</li>
  <li>Your uploaded videos and their thumbnails.</li>
  <li>Your follows, likes, comments, and reports.</li>
</ul>
<p>Active subscriptions are billed by Apple App Store or Google Play, not by us —
deleting your account does not cancel a store subscription. Cancel it separately
in your device's subscription settings (see our <a href="/support">Support</a>
page). We may retain limited records required for legal, tax, or fraud-prevention
purposes; backups are rotated and overwritten within 30 days.</p>
"""


@app.get("/api/legal/privacy", response_class=HTMLResponse, include_in_schema=False)
async def legal_privacy_page():
    return HTMLResponse(_legal_page("Privacy Policy", _PRIVACY_BODY))


@app.get("/api/legal/terms", response_class=HTMLResponse, include_in_schema=False)
async def legal_terms_page():
    return HTMLResponse(_legal_page("Terms of Service", _TERMS_BODY))


@app.get("/api/legal/support", response_class=HTMLResponse, include_in_schema=False)
async def legal_support_page():
    return HTMLResponse(_legal_page("Support", _SUPPORT_BODY))


@app.get("/api/legal/delete-account", response_class=HTMLResponse, include_in_schema=False)
async def legal_delete_account_page():
    return HTMLResponse(_legal_page("Delete Your Account", _DELETE_ACCOUNT_BODY))


# Convenience short URLs without the /api prefix
@app.get("/privacy", response_class=HTMLResponse, include_in_schema=False)
async def legal_privacy_short():
    return HTMLResponse(_legal_page("Privacy Policy", _PRIVACY_BODY))


@app.get("/terms", response_class=HTMLResponse, include_in_schema=False)
async def legal_terms_short():
    return HTMLResponse(_legal_page("Terms of Service", _TERMS_BODY))


@app.get("/support", response_class=HTMLResponse, include_in_schema=False)
async def legal_support_short():
    return HTMLResponse(_legal_page("Support", _SUPPORT_BODY))


@app.get("/delete-account", response_class=HTMLResponse, include_in_schema=False)
async def legal_delete_account_short():
    return HTMLResponse(_legal_page("Delete Your Account", _DELETE_ACCOUNT_BODY))


@app.get("/api/assets/logo.png", include_in_schema=False)
async def brand_logo():
    """Public, email-safe WeClips logo (stable HTTPS URL for SendGrid templates)."""
    path = os.path.join(os.path.dirname(__file__), "assets", "logo.png")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/assets/banner.png", include_in_schema=False)
async def brand_banner():
    """Public, email-safe WeClips brand banner (triangle + wordmark + tagline)."""
    path = os.path.join(os.path.dirname(__file__), "assets", "banner.png")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/assets/bimi.svg", include_in_schema=False)
async def brand_bimi():
    """BIMI-spec (SVG Tiny PS) logo for the email sender avatar."""
    path = os.path.join(os.path.dirname(__file__), "assets", "bimi.svg")
    return FileResponse(
        path,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# Public OG-preview page for sharing a specific video. Renders an HTML page
# with Open Graph + Twitter Card meta tags so iMessage, WhatsApp, X, etc.
# show a thumbnail + title preview. Tapping the link in a browser falls
# through to a "View in app" / "Get the app" call to action.
@app.get("/v/{video_id}", response_class=HTMLResponse, include_in_schema=False)
async def share_video_page(video_id: str):
    v = await videos_col.find_one(
        {"_id": video_id},
        {
            "title": 1,
            "description": 1,
            "creator_name": 1,
            "creator_username": 1,
            "has_thumbnail": 1,
            "thumbnail_updated_at": 1,
        },
    )
    title = (v or {}).get("title", "WeClips") if v else "WeClips video"
    creator = (v or {}).get("creator_name", "a creator")
    handle = (v or {}).get("creator_username")
    descr = (v or {}).get("description") or f"Watch {title} on WeClips — ad-free, Christian-friendly videos."
    thumb_v = (v or {}).get("thumbnail_updated_at") or ""
    has_thumb = bool((v or {}).get("has_thumbnail"))
    base = os.environ.get("APP_PUBLIC_URL", "https://weclips.app").rstrip("/")
    page_url = f"{base}/v/{video_id}"
    thumb_url = f"{base}/api/videos/{video_id}/thumbnail?v={thumb_v}" if has_thumb else f"{base}/og-default.png"
    safe_title = (title or "WeClips").replace("<", "&lt;").replace(">", "&gt;")
    safe_descr = (descr or "").replace("<", "&lt;").replace(">", "&gt;")[:280]
    creator_label = f"@{handle}" if handle else creator
    html = f"""<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"UTF-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
<title>{safe_title} · WeClips</title>
<meta name=\"description\" content=\"{safe_descr}\">
<meta property=\"og:type\" content=\"video.other\">
<meta property=\"og:site_name\" content=\"WeClips\">
<meta property=\"og:title\" content=\"{safe_title}\">
<meta property=\"og:description\" content=\"{safe_descr}\">
<meta property=\"og:image\" content=\"{thumb_url}\">
<meta property=\"og:image:width\" content=\"1280\">
<meta property=\"og:image:height\" content=\"720\">
<meta property=\"og:url\" content=\"{page_url}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:title\" content=\"{safe_title}\">
<meta name=\"twitter:description\" content=\"{safe_descr}\">
<meta name=\"twitter:image\" content=\"{thumb_url}\">
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Comic Sans MS", sans-serif; background: #F4FAFF; color: #1A1A1A; }}
  header {{ background: #9CD3F5; color: #0B2A45; padding: 24px 16px; text-align: center; }}
  header h1 {{ margin: 0; font-size: 22px; }}
  header .tag {{ font-size: 11px; letter-spacing: 2px; opacity: 0.85; margin-top: 4px; }}
  main {{ max-width: 600px; margin: 0 auto; padding: 24px 16px; }}
  .card {{ background: white; border-radius: 18px; overflow: hidden; box-shadow: 0 8px 24px rgba(11,42,69,0.08); }}
  .thumb {{ width: 100%; aspect-ratio: 16/9; background: #DDE7EF; display: block; }}
  .body {{ padding: 16px 18px 24px; }}
  .title {{ font-size: 18px; font-weight: 800; margin: 0 0 6px; color: #0B2A45; }}
  .creator {{ font-size: 14px; color: #5A6470; margin: 0; }}
  .descr {{ font-size: 14px; line-height: 1.45; margin: 12px 0 20px; color: #1A1A1A; white-space: pre-wrap; }}
  .ctaRow {{ display: flex; gap: 8px; flex-direction: column; }}
  .cta {{ display: block; text-align: center; padding: 14px 16px; border-radius: 12px; font-weight: 800; text-decoration: none; }}
  .primary {{ background: #2196C9; color: white; }}
  .ghost {{ background: #F4FAFF; color: #0B2A45; border: 1px solid #C9DDEA; }}
  footer {{ text-align: center; font-size: 11px; color: #5A6470; padding: 16px; }}
</style>
</head>
<body>
<header>
  <h1>WeClips</h1>
  <div class=\"tag\">AD-FREE · CHRISTIAN · CALM</div>
</header>
<main>
  <div class=\"card\">
    <img class=\"thumb\" src=\"{thumb_url}\" alt=\"{safe_title}\"
         onerror=\"this.style.display='none'\">
    <div class=\"body\">
      <p class=\"title\">{safe_title}</p>
      <p class=\"creator\">By {creator_label}</p>
      <p class=\"descr\">{safe_descr}</p>
      <div class=\"ctaRow\">
        <a class=\"cta primary\" href=\"weclips://video/{video_id}\">Open in WeClips</a>
        <a class=\"cta ghost\" href=\"https://apps.apple.com/app/weclips/id000000000\">Get the app</a>
      </div>
    </div>
  </div>
</main>
<footer>© 2026 WeClips · <a href=\"/privacy\">Privacy</a> · <a href=\"/terms\">Terms</a></footer>
</body>
</html>
"""
    return HTMLResponse(html)


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

    # Grandfather existing users: mark any account missing email_verified as
    # verified so this change never locks out pre-existing users (incl. the
    # App Review demo + founder accounts). New signups are created as False.
    try:
        await users_col.update_many(
            {"email_verified": {"$exists": False}},
            {"$set": {"email_verified": True}},
        )
    except Exception as e:
        logger.warning("email_verified backfill failed: %s", e)

    # Backfill thumbnail_updated_at for videos that already have a thumbnail
    # but no timestamp (so VideoCard's ?v= cache-bust works for them too).
    try:
        await videos_col.update_many(
            {
                "thumbnail_base64": {"$exists": True, "$ne": None},
                "$or": [
                    {"thumbnail_updated_at": {"$exists": False}},
                    {"thumbnail_updated_at": None},
                ],
            },
            [{"$set": {"thumbnail_updated_at": "$created_at"}}],
        )
    except Exception as e:
        logger.warning("thumbnail_updated_at backfill failed: %s", e)

    # Backfill the explicit has_thumbnail boolean so list endpoints that strip
    # the heavy thumbnail_base64 blob still report has_thumbnail correctly.
    try:
        await videos_col.update_many(
            {"thumbnail_base64": {"$exists": True, "$ne": None}},
            {"$set": {"has_thumbnail": True}},
        )
        await videos_col.update_many(
            {
                "$or": [
                    {"thumbnail_base64": {"$exists": False}},
                    {"thumbnail_base64": None},
                ]
            },
            {"$set": {"has_thumbnail": False}},
        )
    except Exception as e:
        logger.warning("has_thumbnail backfill failed: %s", e)

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

    # Backfill duration_sec for legacy videos (runs in the background so it
    # never blocks startup — each video is probed via ffprobe over R2/disk).
    asyncio.create_task(_backfill_video_durations())

    # Day-6 trial-ending reminder sweep (email + push), idempotent per user.
    asyncio.create_task(_trial_reminder_loop())


@app.on_event("shutdown")
async def shutdown():
    client.close()
