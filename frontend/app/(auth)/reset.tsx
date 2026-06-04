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
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/src/lib/api";
import { colors, spacing, radius, text, brandFont } from "@/src/theme";

export default function Reset() {
  const { token: rawToken } = useLocalSearchParams<{ token?: string }>();
  const router = useRouter();
  const [token] = useState<string>((rawToken as string) || "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async () => {
    setErr(null);
    if (!token) return setErr("Missing reset token. Open the link from your email again.");
    if (password.length < 6) return setErr("Password must be at least 6 characters.");
    if (password !== confirm) return setErr("Passwords don't match.");
    setLoading(true);
    try {
      await api.post("/auth/reset-password", { token, new_password: password });
      setDone(true);
      setTimeout(() => router.replace("/(auth)/login"), 1500);
    } catch (e: any) {
      setErr(e?.message ?? "Reset failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>WeClips</Text>
          <Text style={styles.h1}>Choose a new password</Text>

          {done ? (
            <Text style={styles.success} testID="reset-success">
              Password updated. Redirecting to sign in...
            </Text>
          ) : (
            <>
              {err ? <Text style={styles.error} testID="reset-error">{err}</Text> : null}
              <TextInput
                testID="reset-password-input"
                placeholder="New password (min 6 chars)"
                placeholderTextColor={colors.onSurfaceTertiary}
                secureTextEntry
                style={styles.input}
                value={password}
                onChangeText={setPassword}
              />
              <TextInput
                testID="reset-confirm-input"
                placeholder="Confirm new password"
                placeholderTextColor={colors.onSurfaceTertiary}
                secureTextEntry
                style={styles.input}
                value={confirm}
                onChangeText={setConfirm}
              />
              <Pressable
                testID="reset-submit-button"
                style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}
                onPress={onSubmit}
                disabled={loading}
              >
                <Text style={styles.btnText}>{loading ? "Updating..." : "Update password"}</Text>
              </Pressable>
            </>
          )}

          <Link href="/(auth)/login" asChild>
            <Pressable testID="reset-back-login" style={styles.linkRow} hitSlop={10}>
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
  h1: { color: colors.onSurface, fontSize: text.xxl, fontWeight: "700", marginBottom: spacing.lg },
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
  success: { color: colors.onBrand, backgroundColor: colors.success, padding: spacing.lg, borderRadius: radius.md, fontSize: text.base, fontWeight: "700" },
  linkRow: { alignItems: "center", marginTop: spacing.lg },
  link: { color: colors.brand, fontWeight: "700" },
});
