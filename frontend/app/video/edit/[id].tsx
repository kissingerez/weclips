import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api, API_BASE, ApiError } from "@/src/lib/api";
import { Toast } from "@/src/components/Toast";
import { colors, radius, spacing, text } from "@/src/theme";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const r = (reader.result as string) || "";
      const c = r.indexOf(",");
      resolve(c >= 0 ? r.slice(c + 1) : r);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

type VideoDetail = {
  id: string;
  title: string;
  description: string;
  creator_id: string;
  has_thumbnail: boolean;
};

export default function EditVideo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [thumbVer, setThumbVer] = useState(Date.now());
  const [newThumbUri, setNewThumbUri] = useState<string | null>(null);
  const [autoOptions, setAutoOptions] = useState<
    { label: string; base64: string; at_sec: number }[]
  >([]);
  const [autoBusy, setAutoBusy] = useState(false);
  const [selectedAuto, setSelectedAuto] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const v = await api.get<VideoDetail>(`/videos/${id}`);
      setVideo(v);
      setTitle(v.title);
      setDesc(v.description || "");
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 402) {
        router.replace("/paywall");
        return;
      }
      setErr("Could not load video");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  const pickThumb = async () => {
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
    let b64 = asset.base64;
    if (!b64) {
      try {
        const resp = await fetch(asset.uri);
        const blob = await resp.blob();
        b64 = await blobToBase64(blob);
      } catch {}
    }
    if (!b64) {
      setErr("Could not read image.");
      return;
    }
    setNewThumbUri(asset.uri);
    try {
      await api.put(`/videos/${id}/thumbnail`, { thumbnail_base64: b64 });
      setThumbVer(Date.now());
    } catch (e: any) {
      setErr(e?.message || "Failed to update thumbnail");
    }
  };

  const generateAutoThumbnails = async () => {
    if (!id || autoBusy) return;
    setErr(null);
    setOk(null);
    setAutoBusy(true);
    try {
      const data = await api.get<{
        options: { label: string; base64: string; at_sec: number }[];
      }>(`/videos/${id}/thumbnail-options`);
      setAutoOptions(data.options || []);
      setSelectedAuto(null);
      if ((data.options || []).length === 0) {
        setErr("Could not generate any frames from this video.");
      }
    } catch (e: any) {
      setErr(e?.message || "Could not generate thumbnails");
    } finally {
      setAutoBusy(false);
    }
  };

  const applyAutoThumb = async (opt: { label: string; base64: string }) => {
    setErr(null);
    setSelectedAuto(opt.label);
    try {
      await api.put(`/videos/${id}/thumbnail`, { thumbnail_base64: opt.base64 });
      setNewThumbUri(`data:image/jpeg;base64,${opt.base64}`);
      setThumbVer(Date.now());
    } catch (e: any) {
      setErr(e?.message || "Failed to update thumbnail");
    }
  };

  const onSave = async () => {
    setErr(null);
    setOk(null);
    const t = title.trim();
    if (!t) {
      setErr("Title cannot be empty.");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/videos/${id}`, { title: t, description: desc.trim() });
      setToast("Saved");
    } catch (e: any) {
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (typeof window !== "undefined" && window.confirm) {
      if (!window.confirm("Delete this video? This cannot be undone.")) return;
    }
    try {
      await api.del(`/videos/${id}`);
      router.replace("/(tabs)/profile");
    } catch (e: any) {
      setErr(e?.message || "Delete failed");
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      </SafeAreaView>
    );
  }
  if (!video) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <Text style={styles.errText}>Video not found</Text>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const thumbSrc =
    newThumbUri ||
    (video.has_thumbnail
      ? `${API_BASE}/videos/${video.id}/thumbnail?v=${thumbVer}`
      : null);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="edit-video-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Edit video</Text>
        <View style={{ width: 24 }} />
      </View>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {err ? <Text style={styles.error} testID="edit-video-error">{err}</Text> : null}

          <Text style={styles.label}>Thumbnail</Text>
          <View style={styles.thumbWrap}>
            {thumbSrc ? (
              <Image source={{ uri: thumbSrc }} style={styles.thumb} resizeMode="cover" />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]}>
                <Ionicons name="image-outline" size={36} color={colors.onSurfaceTertiary} />
                <Text style={styles.thumbEmptyText}>No thumbnail yet</Text>
              </View>
            )}
          </View>
          <Pressable
            testID="edit-video-pick-thumb"
            onPress={pickThumb}
            style={styles.thumbBtn}
          >
            <Ionicons name="image" size={16} color={colors.onBrand} />
            <Text style={styles.thumbBtnText}>Change thumbnail</Text>
          </Pressable>

          <View style={styles.autoBox}>
            <View style={styles.autoHeader}>
              <Text style={styles.autoTitle}>Auto-generate from video</Text>
              <Pressable
                testID="edit-video-auto-regen"
                onPress={generateAutoThumbnails}
                disabled={autoBusy}
                style={[styles.autoRegen, autoBusy && { opacity: 0.6 }]}
                hitSlop={8}
              >
                {autoBusy ? (
                  <ActivityIndicator size="small" color={colors.onSurface} />
                ) : (
                  <>
                    <Ionicons
                      name={autoOptions.length ? "refresh" : "sparkles"}
                      size={14}
                      color={colors.onSurface}
                    />
                    <Text style={styles.autoRegenText}>
                      {autoOptions.length ? "Refresh" : "Generate"}
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
            <Text style={styles.autoHint}>
              Pulls 3 frames from your video (start / middle / end). Tap one to use it.
            </Text>

            {autoBusy ? (
              <View style={styles.autoLoading}>
                <ActivityIndicator color={colors.brand} />
                <Text style={styles.autoLoadingText}>
                  Extracting frames from your video…
                </Text>
              </View>
            ) : autoOptions.length > 0 ? (
              <View style={styles.autoOptionsRow}>
                {autoOptions.map((opt) => {
                  const selected = opt.label === selectedAuto;
                  return (
                    <Pressable
                      key={opt.label}
                      testID={`edit-video-auto-${opt.label.toLowerCase()}`}
                      onPress={() => applyAutoThumb(opt)}
                      style={[
                        styles.autoOption,
                        selected && styles.autoOptionSelected,
                      ]}
                    >
                      <Image
                        source={{ uri: `data:image/jpeg;base64,${opt.base64}` }}
                        style={styles.autoOptionImg}
                        resizeMode="cover"
                      />
                      <View style={styles.autoOptionFooter}>
                        <Text
                          style={[
                            styles.autoOptionLabel,
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
            ) : null}
          </View>

          <Text style={styles.label}>Title</Text>
          <TextInput
            testID="edit-video-title"
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            maxLength={120}
          />

          <Text style={styles.label}>Description</Text>
          <TextInput
            testID="edit-video-description"
            style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
            value={desc}
            onChangeText={setDesc}
            multiline
            maxLength={2000}
          />

          <Pressable
            testID="edit-video-save"
            disabled={saving}
            onPress={onSave}
            style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.7 }]}
          >
            {saving ? (
              <ActivityIndicator color={colors.onBrand} />
            ) : (
              <Text style={styles.saveBtnText}>Save changes</Text>
            )}
          </Pressable>

          <Pressable
            testID="edit-video-delete"
            onPress={onDelete}
            style={styles.deleteBtn}
          >
            <Ionicons name="trash" size={16} color={colors.error} />
            <Text style={styles.deleteText}>Delete video</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
      <Toast
        message={toast}
        variant="success"
        durationMs={1500}
        onHide={() => setToast(null)}
        testID="edit-video-toast"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  errText: { color: colors.onSurface, fontSize: text.lg, marginBottom: spacing.md },
  backBtn: { backgroundColor: colors.brand, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md },
  backText: { color: colors.onBrand, fontWeight: "800" },
  headerBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  headerTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  label: { color: colors.onSurfaceSecondary, fontSize: text.sm, fontWeight: "700", marginTop: spacing.lg, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surfaceSecondary, color: colors.onSurface,
    borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    fontSize: text.lg, borderWidth: 1, borderColor: colors.border,
  },
  thumbWrap: {
    width: "100%", aspectRatio: 16 / 9, backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md, overflow: "hidden",
  },
  thumb: { width: "100%", height: "100%" },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  thumbEmptyText: { color: colors.onSurfaceTertiary, marginTop: spacing.xs },
  thumbBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    alignSelf: "flex-start", backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    borderRadius: radius.pill, marginTop: spacing.md,
  },
  thumbBtnText: { color: colors.onBrand, fontWeight: "700", fontSize: text.sm },
  autoBox: {
    marginTop: spacing.lg,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  autoHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  autoTitle: { color: colors.onSurface, fontSize: text.base, fontWeight: "800" },
  autoHint: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 2 },
  autoRegen: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surfaceTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  autoRegenText: { color: colors.onSurface, fontSize: 11, fontWeight: "700" },
  autoLoading: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.lg,
    gap: spacing.xs,
  },
  autoLoadingText: { color: colors.onSurfaceSecondary, fontSize: text.sm },
  autoOptionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  autoOption: {
    flex: 1,
    borderRadius: radius.sm,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surfaceTertiary,
  },
  autoOptionSelected: { borderColor: colors.brand },
  autoOptionImg: { width: "100%", aspectRatio: 16 / 9 },
  autoOptionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 4,
    backgroundColor: colors.brand,
  },
  autoOptionLabel: {
    color: colors.onBrand,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "center",
  },
  saveBtn: { backgroundColor: colors.brand, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.xl },
  saveBtnText: { color: colors.onBrand, fontWeight: "800", fontSize: text.lg },
  deleteBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: spacing.md, borderRadius: radius.md, marginTop: spacing.lg,
    borderWidth: 1, borderColor: colors.error,
  },
  deleteText: { color: colors.error, fontWeight: "800" },
  error: { color: colors.error, backgroundColor: colors.errorBg, padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.sm },
  success: { color: colors.onBrand, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.sm },
});
