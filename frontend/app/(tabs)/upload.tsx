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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/lib/auth";
import { api } from "@/src/lib/api";
import { colors, radius, spacing, text } from "@/src/theme";

export default function Upload() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [noAi, setNoAi] = useState(false);
  const [pickedUri, setPickedUri] = useState<string | null>(null);
  const [pickedBase64, setPickedBase64] = useState<string | null>(null);
  const [pickedMime, setPickedMime] = useState<string>("video/mp4");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const pickVideo = async () => {
    setErr(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErr("Media library permission required.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      base64: false,
      quality: 0.7,
      videoMaxDuration: 120,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    try {
      // Universal: fetch the asset URI and read as base64 via FileReader
      const resp = await fetch(asset.uri);
      const blob = await resp.blob();
      const b64: string = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
          const r = fr.result as string;
          resolve((r || "").split(",")[1] || "");
        };
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      setPickedUri(asset.uri);
      setPickedBase64(b64);
      setPickedMime(asset.mimeType || "video/mp4");
    } catch (e: any) {
      setErr("Could not read selected video.");
    }
  };

  const onUpload = async () => {
    setErr(null);
    setMsg(null);
    if (!title.trim()) return setErr("Title is required.");
    if (!pickedBase64) return setErr("Select a video first.");
    if (!noAi) return setErr("You must confirm the No-AI policy.");
    if (!user?.is_subscribed) {
      router.push("/paywall");
      return;
    }
    setUploading(true);
    try {
      await api.post("/videos", {
        title: title.trim(),
        description: desc.trim(),
        content_base64: pickedBase64,
        mime_type: pickedMime,
        no_ai_confirmed: true,
      });
      setMsg("Upload complete!");
      setTitle("");
      setDesc("");
      setPickedUri(null);
      setPickedBase64(null);
      setNoAi(false);
      await refresh();
      setTimeout(() => router.push("/(tabs)/home"), 600);
    } catch (e: any) {
      if (e?.status === 402) {
        router.push("/paywall");
      } else {
        setErr(e?.message ?? "Upload failed");
      }
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
                {pickedMime}
              </Text>
            ) : (
              <Text style={styles.dropSub}>Max ~60MB. MP4 recommended.</Text>
            )}
          </Pressable>

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

          <Pressable testID="upload-no-ai-checkbox" style={styles.checkRow} onPress={() => setNoAi(!noAi)}>
            <View style={[styles.checkbox, noAi && styles.checkboxOn]}>
              {noAi && <Ionicons name="checkmark" size={16} color={colors.onBrand} />}
            </View>
            <Text style={styles.checkLabel}>
              I confirm this video is <Text style={styles.bold}>NOT AI-generated</Text>. Slate bans synthetic
              content.
            </Text>
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
  bold: { color: colors.onSurface, fontWeight: "800" },
  submit: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.md,
  },
  submitText: { color: colors.onBrand, fontWeight: "800", fontSize: text.lg },
  error: { color: colors.brand, backgroundColor: colors.brandTertiary, padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.sm },
  success: { color: colors.onBrand, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.sm },
});
