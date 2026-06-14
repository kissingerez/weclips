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
