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

## Constraints / Next iterations
- IAP cannot be tested in Expo Go/web preview — requires a real device build (Emergent Publish flow).
- Add a multipart-upload path for very large videos (>5 GB) — currently single-PUT covers up to 5 GB.
- Add a CORS rule on the R2 bucket if web uploads from a non-preview domain need to work cross-origin.
- Content moderation (LLM check or human review) for the Christian-friendly/no-AI/audio-policy attestations.
