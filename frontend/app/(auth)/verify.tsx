import { useEffect, useRef, useState } from "react";
import {
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/src/lib/auth";
import { colors, spacing, radius, text, brandFont } from "@/src/theme";

const RESEND_COOLDOWN_SEC = 60;

export default function Verify() {
  const { verifyEmail, resendVerification } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = (Array.isArray(params.email) ? params.email[0] : params.email) || "";

  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SEC);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timer.current = setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const onVerify = async () => {
    setErr(null);
    setMsg(null);
    if (code.trim().length !== 6) {
      setErr("Enter the 6-digit code from your email.");
      return;
    }
    setLoading(true);
    try {
      await verifyEmail(email, code.trim());
      router.replace("/(tabs)/home");
    } catch (e: any) {
      setErr(e?.message ?? "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    if (cooldown > 0) return;
    setErr(null);
    setMsg(null);
    try {
      await resendVerification(email);
      setMsg("A new code is on the way. Check your inbox.");
      setCooldown(RESEND_COOLDOWN_SEC);
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't resend the code. Try again shortly.");
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.brand}>WeClips</Text>
          <Text style={styles.h1}>Verify your email</Text>
          <Text style={styles.sub}>
            We sent a 6-digit code to{"\n"}
            <Text style={styles.email}>{email || "your email"}</Text>
          </Text>

          {err ? (
            <Text style={styles.error} testID="verify-error">
              {err}
            </Text>
          ) : null}
          {msg ? (
            <Text style={styles.success} testID="verify-success">
              {msg}
            </Text>
          ) : null}

          <TextInput
            testID="verify-code-input"
            placeholder="------"
            placeholderTextColor={colors.onSurfaceTertiary}
            keyboardType="number-pad"
            autoFocus
            maxLength={6}
            style={styles.codeInput}
            value={code}
            onChangeText={(v) => setCode(v.replace(/[^0-9]/g, ""))}
          />

          <Pressable
            testID="verify-submit-button"
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}
            onPress={onVerify}
            disabled={loading}
          >
            <Text style={styles.btnText}>{loading ? "Verifying..." : "Verify & continue"}</Text>
          </Pressable>

          <Pressable
            testID="verify-resend-button"
            onPress={onResend}
            disabled={cooldown > 0}
            style={styles.resendRow}
            hitSlop={10}
          >
            <Text style={[styles.link, cooldown > 0 && styles.linkDisabled]}>
              {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
            </Text>
          </Pressable>

          <Pressable
            testID="verify-back-login"
            onPress={() => router.replace("/(auth)/login")}
            style={styles.backRow}
            hitSlop={10}
          >
            <Text style={styles.linkMuted}>Back to sign in</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  scroll: { padding: spacing.xl, justifyContent: "center", flexGrow: 1 },
  brand: {
    ...brandFont,
    color: colors.brand,
    fontSize: 42,
    fontWeight: "900",
    letterSpacing: -1,
    marginBottom: spacing.lg,
  },
  h1: { color: colors.onSurface, fontSize: text.xxl, fontWeight: "700", marginBottom: spacing.sm },
  sub: { color: colors.onSurfaceSecondary, fontSize: text.base, marginBottom: spacing.xl, lineHeight: 22 },
  email: { color: colors.onSurface, fontWeight: "700" },
  codeInput: {
    backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: 10,
    textAlign: "center",
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.lg,
  },
  btn: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  btnText: { color: colors.onBrand, fontWeight: "700", fontSize: text.lg },
  resendRow: { alignItems: "center", marginTop: spacing.lg },
  backRow: { alignItems: "center", marginTop: spacing.md },
  link: { color: colors.brand, fontWeight: "700" },
  linkDisabled: { color: colors.onSurfaceTertiary },
  linkMuted: { color: colors.onSurfaceSecondary },
  error: {
    color: colors.error,
    backgroundColor: colors.errorBg,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.md,
  },
  success: {
    color: colors.onBrand,
    backgroundColor: colors.success,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.md,
  },
});
