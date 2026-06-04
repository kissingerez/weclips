import os
import uuid
import base64
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
    await videos_col.update_one({"_id": video_id}, {"$inc": {"views": 1}})
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
    return Response(content=data, media_type="image/jpeg")


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
