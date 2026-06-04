import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { Link, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/src/lib/api";
import { colors, spacing, radius, text, brandFont } from "@/src/theme";

export default function Forgot() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    setErr(null);
    if (!email.trim()) return setErr("Please enter your email.");
    setLoading(true);
    try {
      const r = await api.post<{ status: string; dev_reset_url?: string }>(
        "/auth/forgot-password",
        { email: email.trim().toLowerCase() }
      );
      setSent(true);
      if (r.dev_reset_url) setDevUrl(r.dev_reset_url);
    } catch (e: any) {
      setErr(e?.message ?? "Could not send reset email");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>WeClips</Text>
          <Text style={styles.h1}>Reset your password</Text>

          {!sent ? (
            <>
              <Text style={styles.tagline}>
                Enter the email you signed up with. We'll send a link to reset your password.
              </Text>
              {err ? <Text style={styles.error} testID="forgot-error">{err}</Text> : null}
              <TextInput
                testID="forgot-email-input"
                placeholder="Email"
                placeholderTextColor={colors.onSurfaceTertiary}
                autoCapitalize="none"
                keyboardType="email-address"
                style={styles.input}
                value={email}
                onChangeText={setEmail}
              />
              <Pressable
                testID="forgot-submit-button"
                style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}
                onPress={onSubmit}
                disabled={loading}
              >
                <Text style={styles.btnText}>{loading ? "Sending..." : "Send reset link"}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.info} testID="forgot-success">
                If that email is registered, we just sent a reset link. It's valid for 15 minutes.
              </Text>
              {devUrl ? (
                <View style={styles.devBox}>
                  <Text style={styles.devLabel}>Preview / dev mode</Text>
                  <Text style={styles.devText} numberOfLines={3}>
                    Email service isn't configured yet. Tap below to open the reset page directly:
                  </Text>
                  <Pressable
                    testID="forgot-dev-link-button"
                    style={styles.devLink}
                    onPress={() => {
                      // Extract token from URL and navigate to /reset?token=
                      const m = devUrl.match(/[?&]token=([^&]+)/);
                      if (m) router.push(`/(auth)/reset?token=${m[1]}`);
                    }}
                  >
                    <Text style={styles.devLinkText}>Open reset page</Text>
                  </Pressable>
                </View>
              ) : null}
            </>
          )}

          <Link href="/(auth)/login" asChild>
            <Pressable testID="forgot-back-login" style={styles.linkRow} hitSlop={10}>
              <Text style={styles.link}>← Back to sign in</Text>
            </Pressable>
          </Link>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  scroll: { padding: spacing.xl, justifyContent: "center", flexGrow: 1 },
  brand: { ...brandFont, color: colors.brand, fontSize: 42, fontWeight: "900", letterSpacing: -1, marginBottom: spacing.lg },
  h1: { color: colors.onSurface, fontSize: text.xxl, fontWeight: "700", marginBottom: spacing.md },
  tagline: { color: colors.onSurfaceSecondary, fontSize: text.base, marginBottom: spacing.xl },
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
  btn: { backgroundColor: colors.brand, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.sm },
  btnText: { color: colors.onBrand, fontWeight: "700", fontSize: text.lg },
  error: { color: colors.error, backgroundColor: colors.errorBg, padding: spacing.md, borderRadius: radius.sm, marginBottom: spacing.md },
  info: { color: colors.onSurface, backgroundColor: colors.brandTertiary, padding: spacing.lg, borderRadius: radius.md, marginBottom: spacing.lg, fontSize: text.base, lineHeight: 22 },
  devBox: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.lg },
  devLabel: { color: colors.warning, fontWeight: "800", fontSize: text.sm, marginBottom: spacing.xs, letterSpacing: 1 },
  devText: { color: colors.onSurfaceSecondary, fontSize: text.base, marginBottom: spacing.md, lineHeight: 20 },
  devLink: { backgroundColor: colors.brand, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: "center" },
  devLinkText: { color: colors.onBrand, fontWeight: "700" },
  linkRow: { alignItems: "center", marginTop: spacing.lg },
  link: { color: colors.brand, fontWeight: "700" },
});
