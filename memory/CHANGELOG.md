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
