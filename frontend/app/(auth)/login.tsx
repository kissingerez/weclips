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
import { useAuth } from "@/src/lib/auth";
import { colors, spacing, radius, text } from "@/src/theme";

export default function Login() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace("/(tabs)/home");
    } catch (e: any) {
      setErr(e?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand} testID="brand-logo">WeClips</Text>
          <Text style={styles.tagline}>Ad-free video, $1/month. No AI. Ever.</Text>

          <View style={styles.form}>
            <Text style={styles.h1}>Sign in</Text>
            {err ? (
              <Text style={styles.error} testID="login-error">
                {err}
              </Text>
            ) : null}
            <TextInput
              testID="login-email-input"
              placeholder="Email"
              placeholderTextColor={colors.onSurfaceTertiary}
              autoCapitalize="none"
              keyboardType="email-address"
              style={styles.input}
              value={email}
              onChangeText={setEmail}
            />
            <TextInput
              testID="login-password-input"
              placeholder="Password"
              placeholderTextColor={colors.onSurfaceTertiary}
              secureTextEntry
              style={styles.input}
              value={password}
              onChangeText={setPassword}
            />
            <Pressable
              testID="login-submit-button"
              style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}
              onPress={onSubmit}
              disabled={loading}
            >
              <Text style={styles.btnText}>{loading ? "Signing in..." : "Sign in"}</Text>
            </Pressable>

            <Link href="/(auth)/signup" asChild>
              <Pressable testID="login-go-signup-link" style={styles.linkRow} hitSlop={10}>
                <Text style={styles.linkMuted}>New here? </Text>
                <Text style={styles.link}>Create an account</Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  scroll: { padding: spacing.xl, justifyContent: "center", flexGrow: 1 },
  brand: {
    color: colors.brand,
    fontSize: 40,
    fontWeight: "900",
    letterSpacing: 1,
    marginBottom: spacing.xs,
  },
  tagline: { color: colors.onSurfaceSecondary, fontSize: text.base, marginBottom: spacing.xxl },
  form: {},
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
  btn: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  btnText: { color: colors.onBrand, fontWeight: "700", fontSize: text.lg },
  error: {
    color: colors.error,
    backgroundColor: colors.errorBg,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.md,
  },
  linkRow: { flexDirection: "row", justifyContent: "center", marginTop: spacing.lg },
  linkMuted: { color: colors.onSurfaceSecondary },
  link: { color: colors.brand, fontWeight: "700" },
});
