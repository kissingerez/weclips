# WeClips Changelog

## 2026-02 — Eager upload (progress on select) + publish loading bar
User ask: picking a video should START the upload immediately with a progress bar; Publish should have its own separate loading bar.

Implemented:
- Backend: presign `/videos/upload-url` no longer requires title/policy (title default "", policy check removed) so the file can be STAGED on select. `/videos/{id}/complete` now accepts `title`/`description`/`no_ai_confirmed` and enforces them at publish (this is when the video goes live). Verified: empty-title presign → 200; complete enforces title+policy → 400 when missing.
- Frontend (app/(tabs)/upload.tsx):
  - On video pick → `stageUpload()` runs immediately: presign + stream the file to R2 (native `createUploadTask` from disk / web `xhrPut`) with a live progress bar (`staging` + `uploadPct`). Shows "Uploading your video… X%".
  - When done → "Video uploaded — add a title and publish" indicator; on error → tap-to-retry.
  - Publish → `onPublish()` calls `/complete` with title/desc/policy (or multipart for >5 GiB) and shows its OWN "Publishing…" loading bar. Submit button disabled while staging/publishing.
  - MULTIPART_THRESHOLD raised 4→5 GiB (R2 single-PUT cap) so eager streaming covers normal long videos; >5 GiB still uses publish-time multipart.
  - Earlier fix retained: native streams from disk (no whole-file-in-memory) — root cause of "network failed" on large videos.

Verified: backend curl, babel parse, upload screen renders for logged-in user.
⚠️ Eager upload + native streaming must be confirmed on a real device/TestFlight build (web preview can't run the native module or pick a gallery video). Requires a production redeploy + native build.

## 2026-02 — Cancel upload, profile parity, background pill, guest preview
- Cancel upload button (testID upload-cancel-button) wired to abort eager R2 upload (web xhr.abort / native task.cancelAsync) and clear selection.
- Public creator profile (/user/[id]) matched to web: square avatar + "Followers · Following · Clips" stat line. Backend GET /users/{id} now returns `following` count.
- Global background-upload pill (src/lib/uploadProgress.tsx, mounted in _layout.tsx): shows "Uploading X% / Uploaded — tap to publish" on all screens except Upload; routes back to finish publishing.
- Guest video preview: new GET /videos/{id}/preview-url (guest-accessible) + 15s client-side cutoff with "Free preview" badge and paywall overlay; subscribers still get full /stream-url.
- Tests: backend 29/29 (added test_preview_and_profile.py). Frontend verified (iteration_5). DEPLOY + native build needed for end users.

## 2026-02 — Straight-line upload bar + deployment fix
- DEPLOYMENT FIX: removed .env/.env.*/*.env from /app/.gitignore so production deploy can configure R2/Mongo/JWT (root cause of uploads failing in deployment). Requires redeploy.
- Upload progress UI: replaced thumbnail-overlay card with a clean full-width straight-line bar on the Upload page (label + % + inline cancel). Removed old uploadCard* styles.

## 2026-02 — Upload speed + ETA readout
- Added upload speed (EMA-smoothed bytes/s) and time-remaining ("2.4 MB/s · 12s left", testID upload-progress-meta) under the straight-line upload bar.
- xhrPut (web) and createUploadTask (native) progress callbacks now forward loaded/total bytes; handleUploadProgress samples ~0.6s apart. Stats reset on start/cancel/finish.

## 2026-02 — Upload reassurance: keep-open hint + haptic + success toast
- Added subtle "Keep the app open while your video uploads." hint under the bar while staging (testID upload-keep-open-hint).
- On eager-upload completion: success haptic (expo-haptics, wrapped in try/catch; no-op on web) + bottom toast "Upload complete — add a title to publish" (testID upload-success-toast). Fires once per upload via completedRef, resets on cancel/publish.

## 2026-02 — Move search from bottom tab into Discover
- Removed the Search tab from the bottom bar (href:null in (tabs)/_layout.tsx; route still reachable).
- Added a search bar at the top of Discover (home.tsx), above the first video (testID home-search-input). Submitting routes to /search with the query.
- Search screen (search.tsx) now reads a `q` param and auto-runs the search; onSearch accepts an override term.

## 2026-02 — Wire up RevenueCat subscriptions (iOS)
- Code was already complete & matches RC v10 best practices (configure with appUserID=user.id, getOfferings, purchasePackage, restorePurchases, entitlements.active["premium"]; backend /subscription/sync REST verify + /webhooks/revenuecat).
- Wired keys: frontend EXPO_PUBLIC_REVENUECAT_IOS_KEY (appl_...) + EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID=premium; backend REVENUECAT_REST_API_KEY (sk_...) + generated REVENUECAT_WEBHOOK_SECRET.
- Verified: REST key authorized against RevenueCat (HTTP 201); webhook returns 401 without/with wrong auth and 200 with correct Bearer secret.
- Android deferred (EXPO_PUBLIC_REVENUECAT_ANDROID_KEY not set yet). Entitlement="premium", monthly package="$rc_monthly".
- Webhook URL (preview/sandbox): https://weclips-preview.preview.emergentagent.com/api/webhooks/revenuecat ; (prod after deploy): https://weclips.app/api/webhooks/revenuecat ; Authorization header value: "Bearer <REVENUECAT_WEBHOOK_SECRET>".
- PENDING (user/dashboard): App Store Connect $0.99/mo product, RC store connections + product import, entitlement "premium", offering with $rc_monthly, add webhook in RC dashboard. Real purchases testable only on TestFlight build with sandbox Apple ID. Must Deploy so prod env gets keys + set prod webhook URL.

## 2026-02 — Paywall simplified + real subscriptions + cancel/restore
- Paywall (app/paywall.tsx) rewritten: smaller (44px price), 3 bullets, less text, pill CTA, short legal. Removed the "Activate 30-day test subscription" button and previewActivate/dev path from UI — real Subscribe + Restore only.
- Backend dev-activate now returns 403 "disabled in live mode" automatically (real RC keys present), so no test purchases in production.
- Settings (app/settings.tsx): new MEMBERSHIP section — subscribed users see "Manage subscription / Cancel or change your plan" (opens native manage-subscriptions / store URL via iap.manageSubscriptions); non-subscribers see "Become a member" → paywall. Both states show "Restore purchases" (iap.rcRestore + /subscription/sync + refresh + alert).
- iap.ts: added rcRestore() and manageSubscriptions() (Purchases.showManageSubscriptions w/ store-URL fallback).
- Verified on preview: paywall renders w/o test button (restore present); Settings shows Manage subscription for subscribed appletest and Become a member when not subscribed. tsc clean. NOTE: real purchase/restore/manage only function on a device build.

## 2026-02 — Paywall legal links (Apple 3.1.2)
- Added "Terms of Use · Privacy Policy" links under the Subscribe button on app/paywall.tsx (route to /legal?section=terms / privacy). Verified rendering (testIDs paywall-terms-link / paywall-privacy-link).

## 2026-02 — Email delivery diagnosis + logging
- ROOT CAUSE (no verification codes to Yahoo/Gmail): SENDGRID_SENDER_EMAIL is kissingerez@gmail.com. SendGrid accepts (202) but Yahoo/Gmail reject/drop mail "From" a free @gmail address sent via SendGrid (DMARC/SPF/DKIM fail). Fix = authenticate domain weclips.app in SendGrid + change sender to support@weclips.app. BLOCKED on user doing SendGrid Domain Authentication (DNS CNAMEs).
- Added delivery logging: _send_password_reset_email / _send_verification_email now log SendGrid status + msg_id on success and status + body on reject.
- Added SendGrid Event Webhook: POST /api/webhooks/sendgrid (logs+stores delivered/bounce/dropped/deferred/spamreport, caps 2000) and founder-only GET /api/admin/email-events (newest first, problem_count). Tests: tests/test_email_events.py (3) pass.
- SendGrid Event Webhook URL to configure: https://weclips.app/api/webhooks/sendgrid (prod) / preview URL for testing.

## 2026-02 — FIX email delivery: sender -> support@weclips.app
- weclips.app domain authentication is Verified in SendGrid (em8499.weclips.app). Switched SENDGRID_SENDER_EMAIL from kissingerez@gmail.com -> support@weclips.app. Verified SendGrid accepts From support@weclips.app (202) and signup flow logs from=support@weclips.app status=202.
- This resolves Yahoo/Gmail dropping codes (now DKIM/SPF/DMARC-aligned via authenticated domain).
- User already created SendGrid Event Webhook -> https://weclips.app/api/webhooks/sendgrid (Enabled; Bounced/Dropped/Delivered/Spam) — activates after Deploy.
- Requires Deploy for production (weclips.app) to use the new sender.

## 2026-02 — Deployment fix (recurring) + rotated ASC key validated
- .gitignore had re-acquired .env/.env.*/*.env (lines 86-88) — REMOVED again; git check-ignore confirms backend/.env + frontend/.env are tracked. deployment_agent now: PASS (no blockers; secrets in .env, URLs/ports via env, CORS ok, supervisor ok).
- NOTE: the .env .gitignore block reappeared once between sessions; if a future deploy fails on missing env, re-check /app/.gitignore for .env lines.
- Rotated App Store Connect API key validated: Key ID 43795BGQ82 + Issuer edddc4ee-f818-4767-a7c6-faaffc385f85 -> Apple API 200, app WeClips (bundle app.emergent.adfreevideo12afd3895b). Old key K4W86982D9 user revoked. Key goes in RevenueCat dashboard (not backend).

## 2026-02 — No free-forever premium (test-sub cleanup + expiry backstop)
- Q: would test-subscription users keep premium forever after launch? YES (bug): require_subscriber checked only the is_subscribed boolean, ignored subscription_expires_at, and the app never re-synced with RevenueCat on launch — so dev/test grants never expired.
- Added _subscription_active(user): subscribed AND a FUTURE subscription_expires_at (handles datetime/ISO/naive). Applied to require_subscriber, require_subscriber_flexible, the upload gate, user_to_public.is_subscribed, and /subscription/status. No grant without a future expiry = access. Real RC subs keep a future expiry via purchase sync + renewal/grace webhook, so they're unaffected.
- One-time cleanup: reset ALL 26 test subscriptions (incl. founders, per owner's instruction "no one gets free, not even me") -> is_subscribed=false, status=none, expires=null. is_subscribed=true count now 0.
- dev-activate already 403 in live mode -> no new freebies. Tests: test_subscription_expiry.py (6) + updated test_preview_and_profile.py (now asserts non-subscriber stream is 402). 12 passed. Verified live: appletest now 402 on stream-url, guest preview-url still 200.

## 2026-02 — RevenueCat per-account identity (logIn/logOut) + pinned iOS bundle id
- Problem: useRevenueCat.ts called Purchases.configure({ apiKey, appUserID: user.id }) on every user change. Configure must run once; identity must use logIn/logOut. Risk: cross-account subscription sharing on shared devices.
- iap.ts: added rcConfigureOnce() (module-level guard, anonymous configure), rcLogin(userId) -> Purchases.logIn, rcLogout() -> Purchases.logOut. All safe no-ops on web / Expo Go.
- useRevenueCat.ts: configure once on mount; call rcLogin(user.id) whenever a user becomes available.
- auth.tsx: logout() now calls rcLogout() before clearing token so the next account can't inherit the prior user's subscription.
- app.json: pinned ios.bundleIdentifier = app.emergent.adfreevideo12afd3895b so it can't drift from RevenueCat.
- Lint clean; web smoke test boots (native-only paths no-op on web). Reminder: RevenueCat Restore Behavior should be "Transfer to new App User ID" in the dashboard.

## 2026-02 — Android (Play Store) groundwork + Google review account + delete-account page
- app.json: pinned android.package = app.emergent.adfreevideo12afd3895b (matches iOS bundle id) for RevenueCat/Play consistency. Code already Android-ready (rcConfigureOnce picks EXPO_PUBLIC_REVENUECAT_ANDROID_KEY via Platform.OS). Awaiting user's goog_ SDK key + Play product/service-account setup.
- Created Google Play review demo account: googletest@weclips.app / GoogleReview2026! (@googlereview), email_verified, active sub until 2027-06-08 (bounded, complies with no-free-forever). Script: backend/scripts/create_google_review_account.py. Verified live: login -> JWT, /auth/me is_subscribed=true. Saved to test_credentials.md.
- Added public account-deletion page (Apple 5.1.1(v) + Google Play Data deletion req): _DELETE_ACCOUNT_BODY with routes /api/legal/delete-account and /delete-account. Verified /api/legal/delete-account returns the page (200). NOTE: in this env, non-/api short paths are served by the frontend SPA, so the STORE-FACING URL must be https://weclips.app/api/legal/delete-account (same applies to /api/legal/privacy + /api/legal/terms for reliability).

## 2026-02 — Push notifications (iOS + Android) via Emergent managed relay
- Backend (server.py): added Emergent push relay client (PUSH_BASE_URL + X-Push-Key from EMERGENT_PUSH_KEY env, "placeholder" until deploy). Helpers: send_push(), _notify_push() (best-effort, filters users with push_enabled=False), _notify_new_video_to_followers(). Endpoints: POST /api/register-push (auth; relays native device token to relay keyed by user id), POST /api/notifications/push-preference {enabled}. UserPublic + /auth/me now expose push_enabled (default true).
- Push hooks added (best-effort, never block primary request): like -> creator, comment -> creator, follow -> followee, new report -> founders (action_url /admin/reports), new video -> all followers (also creates in-app new_video notifications). Each carries action_url deep link (/video/{id}, /user/{id}, /admin/reports).
- Frontend: expo-notifications + expo-device installed; app.json expo-notifications plugin added. src/lib/push.ts (handler + ensureAndroidChannel + registerForPush via getDevicePushTokenAsync, no-op on web/simulator), src/lib/usePush.ts (register on login + notification-tap deep links, web-guarded), wired in app/_layout.tsx AuthGate. Settings screen: NOTIFICATIONS section with push toggle (testID settings-push-toggle) calling push-preference + re-registering. notifications.tsx renders new_video type.
- Bug fixes during testing: usePush web guard for getLastNotificationResponseAsync; settings pushOn re-syncs after auth hydration; FIXED pre-existing follow-notification upsert crash (immutable _id moved to $setOnInsert) so in-app follow notifications now persist.
- Tested: backend 10/10 (test_push_notifications.py). register-push returns 500 with placeholder key (EXPECTED; resolves at deploy when EMERGENT_PUSH_KEY injected). Native push delivery requires a device build (TestFlight/Play closed testing) — cannot be verified in web preview.
- DEPLOY/BUILD NOTE: Android needs google-services.json (Firebase) added (app.json android.googleServicesFile) before push works on Android; iOS APNs handled by the build pipeline. EMERGENT_PUSH_KEY is auto-injected at deploy.

## 2026-02 — Web paywall gated ("coming soon")
- paywall.tsx: on Platform.OS === "web", replaced Subscribe/Restore actions with a notice "Payments through this website coming soon! Please subscribe on your mobile device and then come back." + a "Got it" (close) button (testID paywall-web-coming-soon / paywall-web-close-button). Mobile (iOS/Android) keeps the full RevenueCat subscribe + restore flow unchanged. Verified on web via screenshot.

## 2026-02 — TEMPORARY Android paywall bypass (Google Play closed-testing)
- Why: Google won't allow IAP purchases during the 14-day closed-testing review, leaving Android testers unable to subscribe and the app unusable.
- Backend: env ANDROID_FREE_ACCESS (default "true"). _platform_bypass(request) grants access when flag on AND request header X-Client-Platform == "android". require_subscriber + require_subscriber_flexible honor it. NO DB writes — flip ANDROID_FREE_ACCESS=false to instantly restore the paywall. iOS/web untouched.
- Frontend: api.ts sends X-Client-Platform: Platform.OS on every request. New src/lib/access.ts -> hasPremiumAccess(user) = is_subscribed OR (Android && ANDROID_FREE_ACCESS=true). Gates updated to use it: VideoCard (locked), video/[id] (stream vs preview), upload.tsx (3 spots). profile/settings keep real is_subscribed for status display.
- Verified (curl, non-sub user): no header -> 402; X-Client-Platform: android -> 200; ios -> 402. Lint clean.
- TO REVERT when Android billing is live: set ANDROID_FREE_ACCESS=false in backend/.env AND ANDROID_FREE_ACCESS=false in src/lib/access.ts, then redeploy + rebuild.
- Test artifact: backend/scripts/create_nonsub_test_user.py (nosubtest@weclips.app / NoSub2026!, non-subscribed, verified).

## 2026-02 — 7-day free trial (auto-renewing) paywall support
- The trial itself is configured in the STORES (App Store Connect introductory offer + Google Play base-plan free-trial offer); RevenueCat reads it and purchasePackage() applies it automatically. No backend change (trial shows as an active entitlement; period_type=TRIAL on the webhook; existing is_subscribed/expiry just works).
- paywall.tsx: reads monthly package product.introPrice; when price===0 & periodNumberOfUnits>0 -> trialLabel (e.g. "7-day"). iOS uses checkTrialOrIntroductoryPriceEligibility (status!==1 => eligible); Android/web default eligible. Shows a trial badge ("{n}-{unit} free trial, then {price}"), button "Start {n}-{unit} free trial", success "Your free trial is active!", and legal "Free for {n}, then {price}. Auto-renews — cancel anytime before the trial ends." Falls back to normal Subscribe copy when no trial.
- Native-only (offerings resolve on a device build); web shows the existing "coming soon" branch. Verified web paywall renders without crash.
- USER STORE SETUP REQUIRED: App Store Connect -> Subscription -> Introductory Offer -> Free Trial 7 days. Google Play -> Subscription base plan -> Add offer -> Free trial 7 days, eligibility "New customer". Map products to entitlement "premium".

## 2026-02 — Public email logo endpoint (for SendGrid welcome template)
- The "Welcome / 7-day free trial" email is NOT in the app codebase — it's a SendGrid Dynamic Template/Automation managed in the SendGrid dashboard. The broken logo + "WeClips · Ad-free · No AI · No chaos." footer line are edited there, not in code.
- Added backend/assets/logo.png (copied from frontend icon.png, 512x512) and route GET /api/assets/logo.png (FileResponse image/png, 1-day cache) so there's a stable public HTTPS logo URL for the email template: https://weclips.app/api/assets/logo.png (live in preview; production after redeploy).
- USER ACTION (SendGrid dashboard): set the welcome template's logo image src to that URL (width ~120, alt "WeClips"); delete the footer text module "WeClips · Ad-free · No AI · No chaos.".

## 2026-02 — Welcome email moved into app code (sent on trial start)
- Replaced reliance on the external SendGrid template. New backend _send_welcome_email() builds the HTML (logo baked via https://weclips.app/api/assets/logo.png, "Welcome, {first}", 7-day trial copy, first-charge date, "Open WeClips" button, "A few things to try first" list, support + cancel line). NO "WeClips · Ad-free · No AI · No chaos." footer (removed per user).
- _maybe_send_welcome_email(app_user_id): race-safe one-time send via atomic welcome_email_sent flag (find_one_and_update). Trigger: RevenueCat webhook event_type == "INITIAL_PURCHASE" (= trial starts). Fires once; existing members never get back-filled. Uses subscription_expires_at as the first-charge date ("%B %d, %Y").
- Config: SUBSCRIPTION_PRICE_LABEL (default "$0.99"), APP_PUBLIC_URL for links/logo.
- Verified live: posted INITIAL_PURCHASE webhook -> 200, flag set, SendGrid accepted (202), exp=June 26 2026. Logo route /api/assets/logo.png returns 200 image/png (prod after redeploy).
- USER: you can now DELETE the old SendGrid welcome template/automation so it doesn't double-send.
