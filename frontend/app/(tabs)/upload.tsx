import { useState } from "react";
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
import { useRouter } from "expo-router";
import { useAuth } from "@/src/lib/auth";
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

export default function Upload() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [noAi, setNoAi] = useState(false);
  const [pickedUri, setPickedUri] = useState<string | null>(null);
  const [pickedName, setPickedName] = useState<string>("video.mp4");
  const [pickedMime, setPickedMime] = useState<string>("video/mp4");
  const [pickedSize, setPickedSize] = useState<number | null>(null);
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const [thumbBase64, setThumbBase64] = useState<string | null>(null);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const generateAutoThumb = async (videoUri: string) => {
    try {
      setThumbBusy(true);
      // Try first second; fall back to frame 0 if that fails
      const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
        time: 1000,
        quality: 0.7,
      });
      // Read as base64
      const resp = await fetch(uri);
      const blob = await resp.blob();
      const b64 = await blobToBase64(blob);
      setThumbUri(uri);
      setThumbBase64(b64);
    } catch (e) {
      // Auto-thumb is best-effort; user can pick custom
      setThumbUri(null);
      setThumbBase64(null);
    } finally {
      setThumbBusy(false);
    }
  };

  const pickCustomThumb = async () => {
    setErr(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErr("Media library permission required.");
      return;
    }
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
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErr("Media library permission required.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      // Slightly lower bitrate for smoother playback; still HD
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.IFrame1280x720,
      videoExportPreset: ImagePicker.VideoExportPreset.MediumQuality,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const dur = (asset as any).duration as number | undefined; // milliseconds (RN) or seconds (web)
    if (dur && dur > 0) {
      // expo-image-picker returns seconds on web, milliseconds on native — normalise to seconds
      const seconds = dur > 1000 ? dur / 1000 : dur;
      if (seconds > 120) {
        setErr(`Videos must be 2 minutes or less. This clip is ${Math.round(seconds)}s.`);
        return;
      }
    }
    setPickedUri(asset.uri);
    const inferredName =
      (asset as any).fileName ||
      asset.uri.split("/").pop()?.split("?")[0] ||
      "video.mp4";
    setPickedName(inferredName);
    setPickedMime(asset.mimeType || "video/mp4");
    setPickedSize((asset as any).fileSize ?? null);
    // Best-effort auto-thumbnail (user can override)
    setThumbUri(null);
    setThumbBase64(null);
    generateAutoThumb(asset.uri);
  };

  const onUpload = async () => {
    setErr(null);
    setMsg(null);
    if (!title.trim()) return setErr("Title is required.");
    if (!pickedUri) return setErr("Select a video first.");
    if (!noAi) return setErr("You must confirm the content policy.");
    if (!user?.is_subscribed) {
      router.push("/paywall");
      return;
    }
    setUploading(true);
    try {
      // Step 1: ask backend for a presigned PUT URL
      const presigned = await api.post<{
        video_id: string;
        upload_url: string;
        headers: Record<string, string>;
        object_key: string;
        expires_in: number;
      }>("/videos/upload-url", {
        title: title.trim(),
        description: desc.trim(),
        mime_type: pickedMime,
        no_ai_confirmed: true,
      });

      // Step 2: PUT the file directly to R2 (bypasses our API)
      const putHeaders: Record<string, string> = { ...presigned.headers };
      let putBody: any;
      if (Platform.OS === "web") {
        const resp = await fetch(pickedUri);
        putBody = await resp.blob();
      } else {
        // React Native: send the file as a Blob via fetch (RN supports {uri} -> Blob upload)
        const resp = await fetch(pickedUri);
        putBody = await resp.blob();
      }
      const putRes = await fetch(presigned.upload_url, {
        method: "PUT",
        headers: putHeaders,
        body: putBody,
      });
      if (!putRes.ok) {
        const detail = await putRes.text().catch(() => "");
        throw new Error(`Cloud upload failed (${putRes.status}). ${detail.slice(0, 120)}`);
      }

      // Step 3: tell backend the upload is done (it HEADs the object to verify)
      await api.post(`/videos/${presigned.video_id}/complete`);

      // Step 4: best-effort thumbnail upload (don't fail the whole upload if it errors)
      if (thumbBase64) {
        try {
          await api.put(`/videos/${presigned.video_id}/thumbnail`, {
            thumbnail_base64: thumbBase64,
          });
        } catch (_) {
          // ignore — video is uploaded; thumb can be re-set later
        }
      }

      setMsg("Upload complete!");
      setTitle("");
      setDesc("");
      setPickedUri(null);
      setPickedName("video.mp4");
      setPickedSize(null);
      setThumbUri(null);
      setThumbBase64(null);
      setNoAi(false);
      await refresh();
      setTimeout(() => router.push("/(tabs)/home"), 600);
    } catch (e: any) {
      const m = e?.message ?? "Upload failed";
      if (typeof m === "string" && m.includes("(402)")) {
        router.push("/paywall");
        return;
      }
      setErr(m);
    } finally {
      setUploading(false);
    }
  };

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
              <Text style={styles.dropSub}>Up to 2 min, max 2GB. MP4 recommended.</Text>
            )}
          </Pressable>

          {pickedUri ? (
            <View style={styles.thumbCard} testID="upload-thumb-card">
              <View style={styles.thumbRow}>
                <View style={styles.thumbPreviewWrap}>
                  {thumbBusy ? (
                    <View style={[styles.thumbPreview, styles.thumbPreviewLoading]}>
                      <ActivityIndicator color={colors.brand} />
                    </View>
                  ) : thumbUri ? (
                    <Image
                      source={{ uri: thumbUri }}
                      style={styles.thumbPreview}
                      resizeMode="cover"
                    />
                  ) : (
                    <View style={[styles.thumbPreview, styles.thumbPreviewLoading]}>
                      <Ionicons name="image-outline" size={28} color={colors.onSurfaceTertiary} />
                    </View>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.thumbTitle}>Thumbnail</Text>
                  <Text style={styles.thumbHint}>
                    {thumbBase64
                      ? "Auto-generated from your video. Tap to choose your own."
                      : "Pick a 16:9 image as the cover."}
                  </Text>
                  <View style={styles.thumbBtnRow}>
                    <Pressable
                      testID="upload-thumb-pick"
                      onPress={pickCustomThumb}
                      style={styles.thumbBtn}
                    >
                      <Ionicons name="image" size={14} color={colors.onBrand} />
                      <Text style={styles.thumbBtnText}>Choose image</Text>
                    </Pressable>
                    {thumbBase64 ? (
                      <Pressable
                        testID="upload-thumb-regen"
                        onPress={() => pickedUri && generateAutoThumb(pickedUri)}
                        style={[styles.thumbBtn, styles.thumbBtnGhost]}
                      >
                        <Ionicons name="refresh" size={14} color={colors.onSurface} />
                        <Text style={[styles.thumbBtnText, styles.thumbBtnTextGhost]}>
                          Auto
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              </View>
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
                if they don't advocate anti-Christian beliefs.
              </Text>
              <Text style={styles.policyHint}>
                We ban overstimulating and spiritually harmful content so videos stay watchable and uplifting.
              </Text>
            </View>
          </Pressable>

          {err ? <Text style={styles.error} testID="upload-error">{err}</Text> : null}
          {msg ? <Text style={styles.success} testID="upload-success">{msg}</Text> : null}

          <Pressable
            testID="upload-submit-button"
            disabled={uploading}
            onPress={onUpload}
            style={({ pressed }) => [styles.submit, (pressed || uploading) && { opacity: 0.7 }]}
          >
            {uploading ? (
              <ActivityIndicator color={colors.onBrand} />
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
  thumbRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  thumbPreviewWrap: {
    width: 120,
    aspectRatio: 16 / 9,
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: colors.surfaceTertiary,
  },
  thumbPreview: { width: "100%", height: "100%" },
  thumbPreviewLoading: { alignItems: "center", justifyContent: "center" },
  thumbTitle: { color: colors.onSurface, fontSize: text.base, fontWeight: "800" },
  thumbHint: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 2 },
  thumbBtnRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" },
  thumbBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  thumbBtnGhost: { backgroundColor: colors.surfaceTertiary },
  thumbBtnText: { color: colors.onBrand, fontWeight: "700", fontSize: text.sm },
  thumbBtnTextGhost: { color: colors.onSurface },
});
