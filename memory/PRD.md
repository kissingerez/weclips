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

## Constraints / Next iterations
- IAP cannot be tested in Expo Go/web preview — requires a real device build (Emergent Publish flow).
- Add a multipart-upload path for very large videos (>5 GB) — currently single-PUT covers up to 5 GB.
- Add a CORS rule on the R2 bucket if web uploads from a non-preview domain need to work cross-origin.
- Content moderation (LLM check or human review) for the Christian-friendly/no-AI/audio-policy attestations.
