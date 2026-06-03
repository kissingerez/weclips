# Slate — Ad-free Video App (YouTube alternative)

## Vision
Premium, ad-free video platform with strict "no AI-generated content" policy. $0.99/month subscription unlocks uploading via Apple App Store / Google Play in-app purchases (RevenueCat). Anyone can browse / watch.

## Tech Stack
- **Frontend:** Expo SDK 54, expo-router, expo-video, expo-image-picker, expo-secure-store, react-native-purchases (RevenueCat).
- **Backend:** FastAPI, Motor (async MongoDB), passlib/bcrypt + python-jose for JWT, httpx for RevenueCat REST API verification.
- **Subscriptions:** Apple/Google IAP via RevenueCat (you keep ~70-85% of $0.99/month).
- **DB:** MongoDB collections: users, videos, comments, rc_events.

## Core Features (MVP)
- Email/password auth (JWT). Routes: `/auth/signup`, `/auth/login`, `/auth/me`.
- Video CRUD: list, search (`/videos?q=`), get, upload (subscription-gated, base64 in MongoDB), stream, thumbnail, like/unlike, comments.
- **Subscription (RevenueCat IAP):** Client uses `react-native-purchases` to present native paywall, complete purchase via App Store/Google Play. After purchase, client calls `/api/subscription/sync` for optimistic backend update. Authoritative state arrives via `/api/webhooks/revenuecat` (INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION, etc.).
- Preview/Expo Go fallback: `/api/subscription/dev-activate` activates a 30-day test subscription so the rest of the app can be tested without a real device build. Disabled automatically once `REVENUECAT_REST_API_KEY` is set.
- No-AI confirmation required on every upload (hard gate).

## RevenueCat Setup Required (before App Store / Play Store launch)
1. Sign up free at revenuecat.com; create a project for Slate.
2. In App Store Connect: create monthly auto-renewable subscription at Tier 1 ($0.99), product id e.g. `slate_premium_monthly`. In Google Play Console: matching subscription.
3. In RevenueCat: create Entitlement `premium`, attach iOS + Android products, group into Offering `default` with `monthly` package.
4. Copy iOS & Android **public SDK keys** → set as `EXPO_PUBLIC_REVENUECAT_IOS_KEY` and `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` in frontend/.env.
5. (Optional but recommended) Copy **secret REST API key** → set as `REVENUECAT_REST_API_KEY` in backend/.env for authoritative `/subscription/sync` verification.
6. In RevenueCat → Integrations → Webhooks: add `https://<your-domain>/api/webhooks/revenuecat` with Authorization header `Bearer <same value as REVENUECAT_WEBHOOK_SECRET in backend/.env>`.

## Constraints
- Video stored as base64 in MongoDB (~60MB cap). Suitable for short clips/MVP.
- AI-generated content explicitly banned via signed user attestation on upload.
- IAP cannot be tested in Expo Go or the web preview — only in dev/prod builds on real devices. The preview uses `/api/subscription/dev-activate` as a stand-in.

## Next iterations
- Move video to object storage (S3 / GCS) and use HLS streaming.
- Channel pages, follow-channel, watch history, "Watch Later".
- Promo offers via RevenueCat targeting/A-B experiments.
- Content moderation pipeline for the no-AI policy (flagging, takedowns).
