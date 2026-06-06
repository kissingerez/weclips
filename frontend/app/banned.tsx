import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/lib/auth";
import { colors, radius, spacing, text } from "@/src/theme";

function fmtDate(iso?: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function useCountdown(targetIso?: string | null): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!targetIso) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [targetIso]);
  if (!targetIso) return null;
  const target = new Date(targetIso).getTime();
  const diff = target - now;
  if (diff <= 0) return "Suspension ends soon — try refreshing.";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${mins}m remaining`;
  return `${mins}m remaining`;
}

export default function Banned() {
  const { user, logout, refresh } = useAuth();
  const router = useRouter();
  const isPermanent = user?.ban_type === "permanent" || !user?.banned_until;
  const countdown = useCountdown(user?.banned_until || null);
  const endsAt = fmtDate(user?.banned_until || null);

  const onSignOut = useCallback(async () => {
    await logout();
    router.replace("/(auth)/login");
  }, [logout, router]);

  const onCheckAgain = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Ionicons
            name={isPermanent ? "hand-left" : "time"}
            size={56}
            color={colors.error}
          />
        </View>
        <Text style={styles.title}>
          {isPermanent ? "Account permanently banned" : "Account suspended"}
        </Text>
        {isPermanent ? (
          <Text style={styles.sub}>
            Your access to WeClips has been revoked.
          </Text>
        ) : (
          <>
            <Text style={styles.sub}>
              {countdown || "You can return when the suspension ends."}
            </Text>
            {endsAt ? (
              <Text style={styles.timestamp}>Ends {endsAt}</Text>
            ) : null}
          </>
        )}

        {user?.ban_reason ? (
          <View style={styles.reasonBox}>
            <Ionicons name="flag" size={14} color="#78350F" />
            <Text style={styles.reasonText}>{user.ban_reason}</Text>
          </View>
        ) : null}

        <View style={styles.policyBox}>
          <Text style={styles.policyTitle}>Community policy</Text>
          <Text style={styles.policyBody}>
            We aim to create a fun environment at WeClips. Repeated violations
            to our policies may result in temporary or permanent deletion of
            your account.
          </Text>
        </View>

        <Text style={styles.helpLine}>
          If you believe this was a mistake, contact{" "}
          <Text style={styles.email}>support@weclips.app</Text>.
        </Text>

        <View style={styles.actions}>
          {!isPermanent ? (
            <Pressable
              testID="banned-check-again"
              onPress={onCheckAgain}
              style={[styles.btn, styles.btnSecondary]}
            >
              <Ionicons name="refresh" size={16} color={colors.onSurface} />
              <Text style={styles.btnSecondaryText}>Check again</Text>
            </Pressable>
          ) : null}
          <Pressable
            testID="banned-sign-out"
            onPress={onSignOut}
            style={[styles.btn, styles.btnPrimary]}
          >
            <Ionicons name="log-out-outline" size={16} color={colors.onBrand} />
            <Text style={styles.btnPrimaryText}>Sign out</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  body: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.errorBg,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.onSurface,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
  },
  sub: {
    color: colors.onSurfaceSecondary,
    fontSize: text.base,
    textAlign: "center",
    marginTop: spacing.xs,
  },
  timestamp: {
    color: colors.onSurfaceTertiary,
    fontSize: text.sm,
    marginTop: spacing.xs,
  },
  reasonBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: "#FEF3C7",
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
    width: "100%",
  },
  reasonText: { color: "#78350F", fontSize: text.sm, flex: 1, lineHeight: 18 },
  policyBox: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    width: "100%",
  },
  policyTitle: {
    color: colors.onSurface,
    fontSize: text.sm,
    fontWeight: "800",
    marginBottom: spacing.xs,
  },
  policyBody: {
    color: colors.onSurfaceSecondary,
    fontSize: text.sm,
    lineHeight: 20,
  },
  helpLine: {
    color: colors.onSurfaceSecondary,
    fontSize: text.sm,
    textAlign: "center",
    marginTop: spacing.sm,
  },
  email: { color: colors.brand, fontWeight: "700" },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.lg,
    width: "100%",
  },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  btnSecondary: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnSecondaryText: { color: colors.onSurface, fontWeight: "700" },
  btnPrimary: { backgroundColor: colors.brand },
  btnPrimaryText: { color: colors.onBrand, fontWeight: "800" },
});
