# WeClips — Ad-free Christian-friendly Video App

## Vision
Premium, ad-free video platform with strict policy:
- No AI-generated content
- One audio track per video (no overlapping music)
- No excessive sound effects
- Christian-friendly or neutral only (no demonic content; anime/cartoons OK if not anti-Christian)

Anyone can browse the catalog when authenticated, but **watching requires an active $0.99/month subscription** billed via Apple/Google IAP (RevenueCat).

## Tech Stack
- **Frontend:** Expo SDK 54, expo-router, expo-video, expo-image-picker, expo-secure-store, react-native-purchases (RevenueCat).
- **Backend:** FastAPI, Motor (async MongoDB), passlib/bcrypt + python-jose for JWT, httpx for RevenueCat REST, boto3 for Cloudflare R2.
- **Cloud storage:** Cloudflare R2 (S3-compatible, $0 egress) via presigned PUT/GET URLs. Bucket: `weclips-videos`.
- **Subscriptions:** Apple/Google IAP via RevenueCat. `is_subscribed` synced via webhook + post-purchase `/api/subscription/sync`.

## Architecture (current)
1. **Upload flow (R2-backed, direct from device):**
   - `POST /api/videos/upload-url` (auth + sub required) → returns presigned PUT URL (15-min TTL)
   - Client PUTs the file directly to `https://<account>.r2.cloudflarestorage.com/...` — bypasses our API entirely, no body-size limits
   - `POST /api/videos/{id}/complete` → backend HEADs the R2 object to verify upload and sets `upload_complete=true`
2. **Stream flow:**
   - `GET /api/videos/{id}/stream-url` (auth + sub required) → returns presigned R2 GET URL (1-hour TTL) with native HTTP Range support
   - expo-video plays the URL; AVPlayer/ExoPlayer handle seeking via Range requests directly against R2
3. **Subscription gate:**
   - Browsing the list (`GET /api/videos`) is open to logged-in users
   - Watching anything (`GET /api/videos/{id}`, `/stream-url`, `/stream`, comments, likes) requires `is_subscribed=true` (returns 402 otherwise)
4. **Legacy:** Disk-based and base64 videos still play via the gated `/api/videos/{id}/stream` endpoint (token via Authorization header OR `?token=`).

## RevenueCat Setup Required (before App/Play Store launch)
1. Sign up free at revenuecat.com.
2. Create monthly subscription product in App Store Connect & Google Play Console at Tier 1 ($0.99). Attach both to a `premium` entitlement, group into a `default` offering with a `monthly` package.
3. Set `EXPO_PUBLIC_REVENUECAT_IOS_KEY` and `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` in `/app/frontend/.env`.
4. (Recommended) Set `REVENUECAT_REST_API_KEY` in `/app/backend/.env` for authoritative `/subscription/sync` verification.
5. In RevenueCat → Integrations → Webhooks: `https://<domain>/api/webhooks/revenuecat` with header `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`.

## R2 setup (DONE)
- Bucket: `weclips-videos`
- Credentials and endpoint configured in `/app/backend/.env`
- Verified: ListBuckets denied (token is bucket-scoped — correct), HeadBucket succeeds, presigned PUT + GET + Range request all return 200/206.

## Social features
- **Usernames (`@handle`)**: unique, 3-20 chars, lowercase letters/numbers/underscores. Set at signup (or auto-generated from display name). Backfilled for existing users at backend startup.
- **User search**: `GET /api/users/search?q=<term>` (auth required) — partial match on username or display name. Used by the Search tab's "Users" mode toggle.
- **Username availability**: `GET /api/users/username-available?u=<candidate>`.
- **Follow/unfollow**: `POST/DELETE /api/users/{id}/follow`, `GET /api/users/{id}/follow-status`. Surfaced on the video player and user search results.
- **Edit account**: `PATCH /api/auth/me` updates display name, username, email and password (`current_password` required). Cascades display_name/username changes to all existing videos by that creator. UI: `/edit-profile` accessible from the Profile tab.
- **Profile picture**: `PUT /api/auth/me/avatar` (base64, ~400KB cap), `DELETE /api/auth/me/avatar`, `GET /api/users/{id}/avatar` (public, 1h cache). `has_avatar` boolean returned by `/auth/me`, `/users/search`, `/users/{id}`. Shared `Avatar` component (cache-bustable via `version`). Set/changed/removed from the Edit account screen, displayed on Profile + Search users + (TODO: video player).
- **Edit video**: `PATCH /api/videos/{id}` (creator-only) updates title/description; thumbnail update reuses existing `PUT /api/videos/{id}/thumbnail`. UI at `/video/edit/[id]` accessed via per-row "Edit" button on the Profile tab (alongside "Delete").
- **Public profile**: `/user/[id]` screen shows avatar, display name, @handle, bio, follower count, Follow/Unfollow toggle, and the creator's full video list. Reached by tapping a user row in the Search tab (Users mode). Backed by `GET /api/users/{id}` and new `GET /api/users/{id}/videos`.
- **Bio**: stored on `users.bio` (max 300 chars). Editable from `/edit-profile` (multi-line input); shown on own profile, public profile, and is part of `UserPublic`/`UserSearchResult`.
- **Toast**: shared `<Toast>` component (bottom-anchored, animates in/out, auto-dismisses in ~2.4s). Used on the Edit Video screen for both thumbnail saves and metadata saves.
- **Thumbnails**: At upload time, **3 frames are auto-extracted** from the picked video (Start / Middle / End) using `expo-video-thumbnails` client-side. For **already-uploaded videos**, the Edit Video screen ("Auto-generate from video") calls `GET /api/videos/{id}/thumbnail-options` which runs `ffmpeg`/`ffprobe` (Lanczos rescaling up to 1280px wide, `-q:v 2` high-quality JPEG, `pix_fmt yuvj420p`) against an R2 presigned URL. Tapping a candidate calls `PUT /api/videos/{id}/thumbnail` which writes `thumbnail_updated_at` so `VideoCard` cache-busts the `?v=...` query, ensuring everyone sees the new thumbnail instantly. Custom 16:9 upload still supported. Served by `GET /api/videos/{id}/thumbnail` (1-hour cache, cache-busted by `?v=`).
- **Comments, likes, view counts, block, report, soft-delete (30-day grace)**: implemented.
- **Email verification (6-digit OTP)**: New signups are created `email_verified=false` and must enter a 6-digit code emailed via SendGrid before they can log in. `POST /api/auth/signup` returns `{status:"verification_required", email}` (no token); `POST /api/auth/verify-email` `{email, code}` returns the JWT; `POST /api/auth/resend-verification` has a 60s cooldown. Login of an unverified account returns 403 `EMAIL_NOT_VERIFIED` and auto-sends a fresh code; the app routes to `/(auth)/verify`. Codes are sha256-hashed in `email_verifications` (15-min expiry, max 5 attempts). Existing users (incl. Apple demo + founder) are grandfathered via a startup backfill (`email_verified` missing → true).

## Constraints / Next iterations
- IAP cannot be tested in Expo Go/web preview — requires a real device build (Emergent Publish flow).
- Add a multipart-upload path for very large videos (>5 GB) — currently single-PUT covers up to 5 GB.
- Add a CORS rule on the R2 bucket if web uploads from a non-preview domain need to work cross-origin.
- Content moderation (LLM check or human review) for the Christian-friendly/no-AI/audio-policy attestations.

---

## Session Update — 2026-02 (Web UI Parity)

**Goal:** Make the mobile app match the web version (weclips.app) without deleting any features.

**Implemented & tested (8/8 backend pytest + full frontend flows, no regressions):**
- 🔴 FIXED critical crash: Home/Discover feed rendered blank white. Root cause = `applyGlobalFont` global font monkey-patch produced a style array on host `<span>` on web → `Failed to set an indexed property [0] on CSSStyleDeclaration`. Fix: web-safe (CSS injection on web via `document.head`, native monkey-patch only on native). File: `src/lib/applyGlobalFont.ts`.
- Added circular creator avatars to video cards (web parity), image from `GET /api/users/{id}/avatar` with initials fallback. File: `src/components/VideoCard.tsx`.
- Bottom nav now: **Discover** (compass, was Home) · **Following** (NEW) · Upload · Search · Profile. File: `app/(tabs)/_layout.tsx`. Nothing removed.
- NEW backend endpoint `GET /api/videos/following` → videos only from followed creators (respects blocks, requires auth). Defined before `/videos/{video_id}` for correct routing. File: `backend/server.py`.
- NEW Following screen with empty state + "Discover creators" CTA. File: `app/(tabs)/following.tsx`.
- Test file: `backend/tests/test_following_feed.py`.

**Backlog / P2:**
- Resumable/retry-per-chunk recovery for dropped 25GB multipart uploads.
- Minor: extra paddingBottom on tab bar for tight safe-area on some devices (cosmetic).

## Session Update — 2026-02 (Profile web parity)
- Reworked mobile Profile tab to match weclips.app profile: larger avatar, name + @username, inline stat line **Followers · Following · Clips** (added Clips count), bio, "Edit profile" button, and renamed section "Your videos" → **Clips**. Files: `app/(tabs)/profile.tsx`.
- Moved all account/legal items off the Profile into a NEW **Settings** screen (`app/settings.tsx`), opened via a gear icon (top-right of Profile). Settings contains: Founder Reports, Blocked accounts, Community Guidelines, Privacy, Terms, About & Contact, Log out, Delete account, deletion-restore banner. Nothing deleted — only relocated.
- VideoCard thumbnails: rounded 14px corners + 16px inset (web parity), applied across Discover/Following/Profile.
- Verified flows (self-test): gear→Settings, Settings→Privacy(/legal), Profile→Edit(/edit-profile), Settings→Log out(/login). All pass.

## Session Update — 2026-02 (Auth hardening / reset-link domain / login 520)
- **Reset-link domain:** Password-reset (and OTP) emails built `reset_url` from `APP_PUBLIC_URL`, which was the OLD domain `https://ad-free-video-12.emergent.host`. Updated `backend/.env` → `https://weclips.app` and code default fallback (server.py L46) → `https://weclips.app`. Reset links now: `https://weclips.app/reset?token=...`.
- **Login Cloudflare 520 root cause:** the login/signup/forgot handlers called the SYNC SendGrid SDK (`SendGridAPIClient.send()`) inline inside async handlers, blocking the asyncio event loop; under slow/unreachable SendGrid this stalls ALL requests → Cloudflare 520/524. Added `_send_email_nonblocking()` (asyncio.to_thread + 15s timeout) and routed verification + reset emails through it.
- **Defensive login:** `user["password_hash"]` → `user.get("password_hash") or ""` so a doc missing the field returns 401 instead of an unhandled 500.
- Verified: JWT_SECRET_KEY/Mongo OK in preview (no startup crash, feeds 200). Tests: `backend/tests/test_auth_hardening.py` (5/5 pass) + curl (login 200, wrong-pw 401, forgot 200).
- ⚠️ ACTION REQUIRED: Production deployment uses its OWN env vars — the live `APP_PUBLIC_URL` must be set to `https://weclips.app` in the deployment (or redeploy) for live reset emails to change.
