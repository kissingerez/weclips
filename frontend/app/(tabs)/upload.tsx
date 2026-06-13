import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as VideoThumbnails from "expo-video-thumbnails";
import { createUploadTask, FileSystemUploadType } from "expo-file-system/legacy";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/lib/auth";
import { SignInWall } from "@/src/components/SignInWall";
import { API_BASE, api } from "@/src/lib/api";
import { tokenStorage } from "@/src/lib/tokenStorage";
import { colors, radius, spacing, text } from "@/src/theme";

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = (reader.result as string) || "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Files larger than this use chunked multipart upload (R2 single PUT caps at 5 GiB).
const MULTIPART_THRESHOLD = 5 * 1024 * 1024 * 1024; // 5 GiB

// PUT a blob with real upload-progress (web). fetch() can't report upload
// progress, so we use XMLHttpRequest which exposes upload.onprogress.
function xhrPut(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (pct: number) => void,
  onInit?: (xhr: XMLHttpRequest) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    Object.entries(headers || {}).forEach(([k, v]) => {
      try {
        xhr.setRequestHeader(k, v);
      } catch (_) {}
    });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Cloud upload failed (${xhr.status}).`));
    xhr.onerror = () => reject(new Error("Network error during upload. Please try again."));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Please try again."));
    xhr.onabort = () => reject(new Error("__CANCELLED__"));
    onInit?.(xhr);
    xhr.send(body);
  });
}

export default function Upload() {
  const { user, loading: authLoading, refresh } = useAuth();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [noAi, setNoAi] = useState(false);
  const [pickedUri, setPickedUri] = useState<string | null>(null);
  const [pickedName, setPickedName] = useState<string>("video.mp4");
  const [pickedMime, setPickedMime] = useState<string>("video/mp4");
  const [pickedSize, setPickedSize] = useState<number | null>(null);
  const [pickedDuration, setPickedDuration] = useState<number | null>(null);
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const [thumbBase64, setThumbBase64] = useState<string | null>(null);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbOptions, setThumbOptions] = useState<
    { uri: string; base64: string; label: string }[]
  >([]);
  const [staging, setStaging] = useState(false);
  const [stagedVideoId, setStagedVideoId] = useState<string | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const uploadCtrlRef = useRef<{ cancel: () => void } | null>(null);
  const cancelledRef = useRef(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const _extractFrame = async (videoUri: string, timeMs: number) => {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: Math.max(0, Math.round(timeMs)),
        quality: 0.9,
      });
      const resp = await fetch(uri);
      const blob = await resp.blob();
      const b64 = await blobToBase64(blob);
      return { uri, base64: b64 };
    } catch (e) {
      return null;
    }
  };

  // Generate 3 thumbnail options sampled from start / middle / near-end.
  // We fall back gracefully if a frame fails (e.g. unknown duration).
  const generateThumbnailOptions = async (videoUri: string, durationMs?: number) => {
    setThumbBusy(true);
    setThumbOptions([]);
    setThumbUri(null);
    setThumbBase64(null);
    try {
      // Heuristic duration if we don't have one
      const total = durationMs && durationMs > 0 ? durationMs : 6000;
      const targets = [
        { ms: Math.min(1000, total * 0.1), label: "Start" },
        { ms: Math.max(500, total * 0.5), label: "Middle" },
        { ms: Math.max(1000, total * 0.85), label: "End" },
      ];
      const results: { uri: string; base64: string; label: string }[] = [];
      for (const t of targets) {
        const frame = await _extractFrame(videoUri, t.ms);
        if (frame) results.push({ ...frame, label: t.label });
      }
      // Fallback: if everything failed, try frame 0 once
      if (results.length === 0) {
        const f = await _extractFrame(videoUri, 0);
        if (f) results.push({ ...f, label: "Frame" });
      }
      setThumbOptions(results);
      if (results.length > 0) {
        // Default to the first option (Start)
        setThumbUri(results[0].uri);
        setThumbBase64(results[0].base64);
      }
    } finally {
      setThumbBusy(false);
    }
  };

  const pickCustomThumb = async () => {
    setErr(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.7,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setThumbUri(asset.uri);
    if (asset.base64) {
      setThumbBase64(asset.base64);
    } else {
      try {
        const resp = await fetch(asset.uri);
        const blob = await resp.blob();
        const b64 = await blobToBase64(blob);
        setThumbBase64(b64);
      } catch {}
    }
  };

  const pickVideo = async () => {
    setErr(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      // Full 1080p capture so playback stays crisp on big phones / tablets.
      // Android: videoQuality 1 = "high" (uses device-native max). iOS: the
      // export preset is what controls the final encode, so we pin 1080p H.264.
      videoQuality: 1,
      videoExportPreset: ImagePicker.VideoExportPreset.H264_1920x1080,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const dur = (asset as any).duration as number | undefined; // milliseconds (RN) or seconds (web)
    let seconds: number | null = null;
    if (dur && dur > 0) {
      // expo-image-picker returns seconds on web, milliseconds on native — normalise to seconds
      seconds = dur > 1000 ? dur / 1000 : dur;
      if (seconds > 10800) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        setErr(
          `Videos must be 180 minutes or less. This clip is ${mins}m ${secs}s.`
        );
        return;
      }
    }
    setPickedDuration(seconds);
    setPickedUri(asset.uri);
    const inferredName =
      (asset as any).fileName ||
      asset.uri.split("/").pop()?.split("?")[0] ||
      "video.mp4";
    setPickedName(inferredName);
    setPickedMime(asset.mimeType || "video/mp4");
    setPickedSize((asset as any).fileSize ?? null);
    // Generate 3 thumbnail candidates from the video (best-effort)
    setThumbUri(null);
    setThumbBase64(null);
    setThumbOptions([]);
    const durMs = dur ? (dur > 1000 ? dur : dur * 1000) : undefined;
    generateThumbnailOptions(asset.uri, durMs);
    // Start uploading to storage immediately so the progress bar shows right
    // away while the user fills in the title. Publish then just finalizes it.
    setErr(null);
    setMsg(null);
    const sz = (asset as any).fileSize ?? 0;
    if (user?.is_subscribed && sz <= MULTIPART_THRESHOLD) {
      stageUpload(asset.uri, asset.mimeType || "video/mp4");
    }
  };

  // Stream a file to a presigned R2 URL with real progress. Native streams
  // straight from disk (never loads the video into memory — the old cause of
  // "network failed"); web PUTs the blob via XHR for progress.
  const streamPut = async (
    fileUri: string,
    uploadUrl: string,
    headers: Record<string, string>,
    onPct: (n: number) => void
  ): Promise<void> => {
    if (Platform.OS === "web") {
      const resp = await fetch(fileUri);
      const blob = await resp.blob();
      await xhrPut(uploadUrl, headers, blob, onPct);
    } else {
      const task = createUploadTask(
        uploadUrl,
        fileUri,
        {
          httpMethod: "PUT",
          uploadType: FileSystemUploadType.BINARY_CONTENT,
          headers,
        },
        (p) => {
          if (p.totalBytesExpectedToSend > 0) {
            onPct(Math.round((p.totalBytesSent / p.totalBytesExpectedToSend) * 100));
          }
        }
      );
      const res = await task.uploadAsync();
      if (!res || res.status < 200 || res.status >= 300) {
        throw new Error(
          `Cloud upload failed (${res?.status ?? "network"}). ${(res?.body || "").slice(0, 120)}`
        );
      }
    }
  };

  // Eager upload: the moment a video is picked we stage it to storage (no title
  // yet) so the progress bar starts immediately. Publish then just finalizes it.
  const stageUpload = async (fileUri: string, mime: string) => {
    setStageError(null);
    setStagedVideoId(null);
    setStaging(true);
    setUploadPct(0);
    try {
      const presigned = await api.post<{
        video_id: string;
        upload_url: string;
        headers: Record<string, string>;
      }>("/videos/upload-url", {
        title: "",
        description: "",
        mime_type: mime,
        no_ai_confirmed: false,
      });
      await streamPut(fileUri, presigned.upload_url, presigned.headers, setUploadPct);
      setStagedVideoId(presigned.video_id);
    } catch (e: any) {
      const m = e?.message ?? "Upload failed";
      if (typeof m === "string" && m.includes("(402)")) {
        setStageError("Membership required to upload.");
      } else {
        setStageError(typeof m === "string" ? m : "Upload failed. Tap to retry.");
      }
    } finally {
      setStaging(false);
    }
  };

  // Large files (> 4 GiB) can't use a single R2 PUT (5 GiB cap), so we upload
  // them in chunks via multipart and let the backend finalize from ListParts.
  const uploadViaMultipart = async (fileBlob: Blob): Promise<string> => {
    const mp = await api.post<{
      video_id: string;
      upload_id: string;
      part_size: number;
      parts: { part_number: number; url: string }[];
    }>("/videos/multipart/create", {
      title: title.trim(),
      description: desc.trim(),
      mime_type: pickedMime,
      no_ai_confirmed: true,
      total_size: fileBlob.size,
    });
    try {
      const total = mp.parts.length;
      for (const part of mp.parts) {
        const start = (part.part_number - 1) * mp.part_size;
        const end = Math.min(start + mp.part_size, fileBlob.size);
        const chunk = fileBlob.slice(start, end);
        const res = await fetch(part.url, { method: "PUT", body: chunk });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(
            `Chunk ${part.part_number}/${total} failed (${res.status}). ${detail.slice(0, 100)}`
          );
        }
        setUploadPct(Math.round((part.part_number / total) * 100));
      }
      await api.post(`/videos/${mp.video_id}/multipart/complete`, {
        upload_id: mp.upload_id,
        client_duration_sec: pickedDuration ?? undefined,
      });
      return mp.video_id;
    } catch (e) {
      // Best-effort: abort the abandoned multipart upload so we don't orphan it.
      try {
        await api.post(`/videos/${mp.video_id}/multipart/abort`, {});
      } catch (_) {}
      throw e;
    }
  };

  const onPublish = async () => {
    setErr(null);
    setMsg(null);
    if (!title.trim()) return setErr("Title is required.");
    if (!pickedUri) return setErr("Select a video first.");
    if (!noAi) return setErr("You must confirm the content policy.");
    if (!user?.is_subscribed) {
      router.push("/paywall");
      return;
    }
    if (staging) return setErr("Please wait for the video to finish uploading.");
    if (stageError) return setErr("Upload failed. Tap the video to retry, then publish.");

    setPublishing(true);
    try {
      const size = pickedSize ?? 0;
      let videoId: string;
      if (stagedVideoId) {
        // File already uploaded eagerly on select — just finalize/publish it.
        await api.post(`/videos/${stagedVideoId}/complete`, {
          title: title.trim(),
          description: desc.trim(),
          no_ai_confirmed: true,
          client_duration_sec: pickedDuration ?? undefined,
        });
        videoId = stagedVideoId;
      } else if (size > MULTIPART_THRESHOLD) {
        // Very large (>5 GiB) files weren't pre-staged; chunk-upload now.
        videoId = await uploadViaMultipart(await (await fetch(pickedUri)).blob());
      } else {
        // Staging didn't run (e.g. just subscribed) — stage then finalize now.
        const presigned = await api.post<{
          video_id: string;
          upload_url: string;
          headers: Record<string, string>;
        }>("/videos/upload-url", {
          title: "",
          description: "",
          mime_type: pickedMime,
          no_ai_confirmed: false,
        });
        await streamPut(pickedUri, presigned.upload_url, presigned.headers, setUploadPct);
        await api.post(`/videos/${presigned.video_id}/complete`, {
          title: title.trim(),
          description: desc.trim(),
          no_ai_confirmed: true,
          client_duration_sec: pickedDuration ?? undefined,
        });
        videoId = presigned.video_id;
      }

      // Best-effort thumbnail upload (don't fail publish if it errors)
      if (thumbBase64) {
        try {
          await api.put(`/videos/${videoId}/thumbnail`, { thumbnail_base64: thumbBase64 });
        } catch (_) {}
      }

      setMsg("Published!");
      setTitle("");
      setDesc("");
      setPickedUri(null);
      setPickedName("video.mp4");
      setPickedSize(null);
      setPickedDuration(null);
      setThumbUri(null);
      setThumbBase64(null);
      setNoAi(false);
      setStagedVideoId(null);
      setStageError(null);
      setUploadPct(0);
      await refresh();
      setTimeout(() => router.push("/(tabs)/home"), 600);
    } catch (e: any) {
      const m = e?.message ?? "Publish failed";
      if (typeof m === "string" && m.includes("(402)")) {
        router.push("/paywall");
        return;
      }
      setErr(typeof m === "string" ? m : "Publish failed");
    } finally {
      setPublishing(false);
    }
  };

  if (authLoading) {
    return (
      <SafeAreaView style={styles.root} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.h1}>Upload</Text>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.root} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.h1}>Upload</Text>
        </View>
        <SignInWall
          icon="cloud-upload-outline"
          title="Sign in to upload"
          message="Create a free account to share your own clips on WeClips."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Upload</Text>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {!user?.is_subscribed && (
            <Pressable
              testID="upload-paywall-banner"
              onPress={() => router.push("/paywall")}
              style={styles.paywallBanner}
            >
              <Ionicons name="lock-closed" size={18} color={colors.onBrandTertiary} />
              <Text style={styles.paywallText}>
                Active subscription required to upload. Tap to subscribe for $1/month.
              </Text>
            </Pressable>
          )}

          <Pressable
            testID="upload-pick-video-button"
            onPress={pickVideo}
            style={styles.dropZone}
          >
            <Ionicons
              name={pickedUri ? "checkmark-circle" : "cloud-upload-outline"}
              size={48}
              color={pickedUri ? colors.success : colors.brand}
            />
            <Text style={styles.dropTitle}>
              {pickedUri ? "Video selected" : "Select video from gallery"}
            </Text>
            {pickedUri ? (
              <Text style={styles.dropSub} numberOfLines={1}>
                {pickedName}
                {pickedSize ? `  ·  ${formatBytes(pickedSize)}` : ""}
              </Text>
            ) : (
              <Text style={styles.dropSub}>Up to 180 min, max 25GB. MP4 recommended.</Text>
            )}
          </Pressable>

          {pickedUri ? (
            <View style={styles.thumbCard} testID="upload-thumb-card">
              <View style={styles.thumbHeaderRow}>
                <Text style={styles.thumbTitle}>Choose a thumbnail</Text>
                <Pressable
                  testID="upload-thumb-regen"
                  onPress={() => pickedUri && generateThumbnailOptions(pickedUri)}
                  style={styles.thumbRegen}
                  hitSlop={8}
                >
                  <Ionicons name="refresh" size={14} color={colors.onSurface} />
                  <Text style={styles.thumbRegenText}>Refresh</Text>
                </Pressable>
              </View>
              <Text style={styles.thumbHint}>
                Pick from auto-generated frames, or upload your own image.
              </Text>

              {thumbBusy ? (
                <View style={styles.thumbLoading}>
                  <ActivityIndicator color={colors.brand} />
                  <Text style={styles.thumbLoadingText}>Generating previews…</Text>
                </View>
              ) : thumbOptions.length > 0 ? (
                <View style={styles.thumbOptionsRow}>
                  {thumbOptions.map((opt) => {
                    const selected = opt.uri === thumbUri;
                    return (
                      <Pressable
                        key={opt.uri}
                        testID={`upload-thumb-option-${opt.label.toLowerCase()}`}
                        onPress={() => {
                          setThumbUri(opt.uri);
                          setThumbBase64(opt.base64);
                        }}
                        style={[
                          styles.thumbOption,
                          selected && styles.thumbOptionSelected,
                        ]}
                      >
                        <Image
                          source={{ uri: opt.uri }}
                          style={styles.thumbOptionImg}
                          resizeMode="cover"
                        />
                        <View style={styles.thumbOptionFooter}>
                          <Text
                            style={[
                              styles.thumbOptionLabel,
                              selected && { color: colors.onBrand },
                            ]}
                          >
                            {opt.label}
                          </Text>
                          {selected ? (
                            <Ionicons
                              name="checkmark-circle"
                              size={14}
                              color={colors.onBrand}
                            />
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <View style={styles.thumbLoading}>
                  <Ionicons name="image-outline" size={28} color={colors.onSurfaceTertiary} />
                  <Text style={styles.thumbLoadingText}>
                    Couldn&apos;t generate frames. Upload your own below.
                  </Text>
                </View>
              )}

              <Pressable
                testID="upload-thumb-pick"
                onPress={pickCustomThumb}
                style={styles.thumbPickBtn}
              >
                <Ionicons name="image" size={14} color={colors.onSurface} />
                <Text style={styles.thumbPickText}>Upload custom image</Text>
              </Pressable>

              {thumbUri && !thumbOptions.some((o) => o.uri === thumbUri) ? (
                <Text style={styles.thumbCustomNote}>
                  Using your custom image. Tap an auto option above to switch back.
                </Text>
              ) : null}
            </View>
          ) : null}

          <TextInput
            testID="upload-title-input"
            placeholder="Title"
            placeholderTextColor={colors.onSurfaceTertiary}
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            maxLength={120}
          />
          <TextInput
            testID="upload-description-input"
            placeholder="Description (optional)"
            placeholderTextColor={colors.onSurfaceTertiary}
            style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
            value={desc}
            onChangeText={setDesc}
            multiline
            maxLength={2000}
          />

          <Pressable testID="upload-policy-checkbox" style={styles.checkRow} onPress={() => setNoAi(!noAi)}>
            <View style={[styles.checkbox, noAi && styles.checkboxOn]}>
              {noAi && <Ionicons name="checkmark" size={16} color={colors.onBrand} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.policyTitle}>I confirm this video follows the WeClips policy:</Text>
              <Text style={styles.policyRule}>• Not AI-generated</Text>
              <Text style={styles.policyRule}>• Only one music/audio track at a time (no two songs overlapping)</Text>
              <Text style={styles.policyRule}>• No excessive sound effects</Text>
              <Text style={styles.policyRule}>
                • Christian-friendly or neutral content only — nothing demonic. Anime & cartoons are welcome
                if they don&apos;t advocate anti-Christian beliefs.
              </Text>
              <Text style={styles.policyHint}>
                We ban overstimulating and spiritually harmful content so videos stay watchable and uplifting.
              </Text>
            </View>
          </Pressable>

          {err ? <Text style={styles.error} testID="upload-error">{err}</Text> : null}
          {msg ? <Text style={styles.success} testID="upload-success">{msg}</Text> : null}

          {/* Eager upload progress overlaid on the picked video's thumbnail. */}
          {staging || stagedVideoId ? (
            <View style={styles.uploadCard} testID="upload-progress">
              {thumbUri ? (
                <Image source={{ uri: thumbUri }} style={styles.uploadCardImg} resizeMode="cover" />
              ) : (
                <View style={[styles.uploadCardImg, styles.uploadCardImgFallback]}>
                  <Ionicons name="videocam" size={36} color={colors.onSurfaceTertiary} />
                </View>
              )}
              <View style={styles.uploadCardOverlay}>
                {staging ? (
                  <>
                    <Text style={styles.uploadCardPct} testID="upload-progress-pct">
                      {uploadPct}%
                    </Text>
                    <Text style={styles.uploadCardLabel}>
                      {uploadPct >= 100 ? "Finishing upload…" : "Uploading your video…"}
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="checkmark-circle" size={40} color="#ffffff" />
                    <Text style={styles.uploadCardLabel}>Uploaded — ready to publish</Text>
                  </>
                )}
              </View>
              <View style={styles.uploadCardBarTrack}>
                <View
                  testID="upload-progress-fill"
                  style={[
                    styles.uploadCardBarFill,
                    { width: `${staging ? Math.max(3, uploadPct) : 100}%` },
                  ]}
                />
              </View>
            </View>
          ) : stageError ? (
            <Pressable
              testID="upload-stage-retry"
              onPress={() => pickedUri && stageUpload(pickedUri, pickedMime)}
              style={[styles.progressWrap, styles.stageErrorWrap]}
            >
              <Ionicons name="alert-circle" size={18} color={colors.error} />
              <Text style={styles.stageErrorText}>{stageError} Tap to retry.</Text>
            </Pressable>
          ) : null}

          {/* Publishing loading bar — finalizes the already-uploaded video. */}
          {publishing ? (
            <View style={styles.progressWrap} testID="publish-progress">
              <View style={styles.progressHeaderRow}>
                <Text style={styles.progressTitle}>Publishing…</Text>
                <ActivityIndicator color={colors.brand} />
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, styles.indeterminate]} />
              </View>
            </View>
          ) : null}

          <Pressable
            testID="upload-submit-button"
            disabled={publishing || staging}
            onPress={onPublish}
            style={({ pressed }) => [
              styles.submit,
              (pressed || publishing || staging) && { opacity: 0.6 },
            ]}
          >
            {publishing ? (
              <View style={styles.submitBusyRow}>
                <ActivityIndicator color={colors.onBrand} />
                <Text style={styles.submitText}>Publishing…</Text>
              </View>
            ) : staging ? (
              <Text style={styles.submitText}>Uploading… {uploadPct}%</Text>
            ) : (
              <Text style={styles.submitText}>Publish</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  h1: { color: colors.onSurface, fontSize: text.xxl, fontWeight: "800" },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  paywallBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  paywallText: { color: colors.onBrandTertiary, flex: 1, fontSize: text.base },
  dropZone: {
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    marginBottom: spacing.lg,
  },
  dropTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700", marginTop: spacing.sm },
  dropSub: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: spacing.xs },
  input: {
    backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: text.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginVertical: spacing.md },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkLabel: { color: colors.onSurfaceSecondary, flex: 1, fontSize: text.base, lineHeight: 20 },
  policyTitle: { color: colors.onSurface, fontSize: text.base, fontWeight: "700", marginBottom: spacing.xs },
  policyRule: { color: colors.onSurfaceSecondary, fontSize: text.base, lineHeight: 20 },
  policyHint: { color: colors.onSurfaceTertiary, fontSize: text.sm, marginTop: spacing.xs, fontStyle: "italic" },
  bold: { color: colors.onSurface, fontWeight: "800" },
  submit: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.md,
  },
  submitText: { color: colors.onBrand, fontWeight: "800", fontSize: text.lg },
  submitBusyRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  progressWrap: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  progressHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  progressTitle: { color: colors.onSurface, fontSize: text.base, fontWeight: "700" },
  progressPct: { color: colors.brand, fontSize: text.base, fontWeight: "800" },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.surfaceTertiary,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 999, backgroundColor: colors.brand },
  progressHint: { color: colors.onSurfaceSecondary, fontSize: text.xs, marginTop: spacing.sm },
  stagedWrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  stagedText: { color: colors.onSurface, fontSize: text.sm, fontWeight: "600", flex: 1 },
  stageErrorWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderColor: colors.error,
  },
  stageErrorText: { color: colors.error, fontSize: text.sm, fontWeight: "600", flex: 1 },
  indeterminate: { width: "100%" },
  uploadCard: {
    borderRadius: radius.md,
    overflow: "hidden",
    marginBottom: spacing.md,
    backgroundColor: "#000",
    position: "relative",
  },
  uploadCardImg: { width: "100%", aspectRatio: 16 / 9 },
  uploadCardImgFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceTertiary,
  },
  uploadCardOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    gap: 4,
  },
  uploadCardPct: { color: "#ffffff", fontSize: 40, fontWeight: "900", letterSpacing: -1 },
  uploadCardLabel: { color: "#ffffff", fontSize: text.sm, fontWeight: "700" },
  uploadCardBarTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 6,
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  uploadCardBarFill: { height: "100%", backgroundColor: colors.brand },
  error: { color: colors.error, backgroundColor: colors.errorBg, padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.sm },
  success: { color: colors.onBrand, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.sm },
  thumbCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  thumbHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  thumbTitle: { color: colors.onSurface, fontSize: text.base, fontWeight: "800" },
  thumbHint: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 2 },
  thumbRegen: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surfaceTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  thumbRegenText: { color: colors.onSurface, fontSize: 11, fontWeight: "700" },
  thumbLoading: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.lg,
    gap: spacing.xs,
  },
  thumbLoadingText: { color: colors.onSurfaceSecondary, fontSize: text.sm },
  thumbOptionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  thumbOption: {
    flex: 1,
    borderRadius: radius.sm,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surfaceTertiary,
  },
  thumbOptionSelected: { borderColor: colors.brand },
  thumbOptionImg: {
    width: "100%",
    aspectRatio: 16 / 9,
  },
  thumbOptionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 4,
    backgroundColor: colors.brand,
  },
  thumbOptionLabel: {
    color: colors.onBrand,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "center",
  },
  thumbPickBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: spacing.md,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  thumbPickText: { color: colors.onSurface, fontWeight: "700", fontSize: text.sm },
  thumbCustomNote: {
    color: colors.onSurfaceSecondary,
    fontSize: text.sm,
    marginTop: spacing.sm,
    textAlign: "center",
  },
});
