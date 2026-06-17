import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/lib/auth";
import { api } from "@/src/lib/api";
import { confirmDialog, alertDialog } from "@/src/lib/dialogs";
import { manageSubscriptions, rcRestore } from "@/src/lib/iap";
import { registerForPush } from "@/src/lib/push";
import { colors, radius, spacing, text } from "@/src/theme";

export default function Settings() {
  const { user, logout, refresh } = useAuth();
  const router = useRouter();
  const [openReports, setOpenReports] = useState<number>(0);
  const [pushOn, setPushOn] = useState<boolean>(user?.push_enabled !== false);
  const [pushBusy, setPushBusy] = useState(false);

  const togglePush = async (next: boolean) => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushOn(next); // optimistic
    try {
      await api.post("/notifications/push-preference", { enabled: next });
      if (next) await registerForPush();
      await refresh();
    } catch (e: any) {
      setPushOn(!next); // revert
      await alertDialog("Couldn't update", e?.message ?? "Please try again.");
    } finally {
      setPushBusy(false);
    }
  };

  const loadFounderSummary = useCallback(async () => {
    try {
      const r = await api.get<{ open: number }>("/admin/reports/summary");
      setOpenReports(r.open || 0);
    } catch {
      setOpenReports(0);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (user?.is_founder) loadFounderSummary();
    }, [loadFounderSummary, user?.is_founder])
  );

  const onRestore = async () => {
    try {
      const active = await rcRestore();
      if (active === null) {
        await alertDialog("Restore purchases", "Open WeClips on your phone to restore your subscription.");
        return;
      }
      if (active) {
        try {
          await api.post("/subscription/sync");
        } catch {}
        await refresh();
        await alertDialog("Restored", "Your membership has been restored.");
      } else {
        await alertDialog("No subscription found", "We couldn't find an active subscription for this account.");
      }
    } catch (e: any) {
      await alertDialog("Restore failed", e?.message ?? "Please try again.");
    }
  };

  const legalItems = [
    { key: "blocked", label: "Blocked accounts", route: "/blocked" },
    { key: "guidelines", label: "Community Guidelines" },
    { key: "privacy", label: "Privacy Policy" },
    { key: "terms", label: "Terms of Service" },
    { key: "about", label: "About & Contact" },
  ];

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.topBar}>
        <Pressable
          testID="settings-back"
          onPress={() => router.back()}
          hitSlop={10}
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.topTitle}>Settings</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        testID="settings-scroll"
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        {user?.deletion_pending ? (
          <View style={styles.deletionBanner} testID="settings-deletion-banner">
            <Ionicons name="warning" size={18} color={colors.error} />
            <Text style={styles.deletionText}>
              Account scheduled for deletion
              {user.deletion_expires_at
                ? ` on ${new Date(user.deletion_expires_at).toLocaleDateString()}`
                : ""}
              .
            </Text>
            <Pressable
              testID="settings-restore-account"
              onPress={async () => {
                try {
                  await api.post("/auth/restore");
                  await refresh();
                } catch {}
              }}
              style={styles.restoreBtn}
            >
              <Text style={styles.restoreText}>Restore</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.menu}>
          {user?.is_founder ? (
            <Pressable
              testID="settings-founder-reports"
              onPress={() => router.push("/admin/reports")}
              style={[styles.row, styles.founderRow]}
            >
              <View style={styles.founderRowLeft}>
                <View style={styles.founderRowIcon}>
                  <Ionicons name="flag" size={16} color="#1A1A1A" />
                </View>
                <Text style={[styles.label, { fontWeight: "800" }]}>Reports</Text>
                {openReports > 0 ? (
                  <View style={styles.openCountPill} testID="settings-founder-reports-count">
                    <Text style={styles.openCountText}>{openReports}</Text>
                  </View>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceTertiary} />
            </Pressable>
          ) : null}

          <Text style={styles.sectionLabel}>MEMBERSHIP</Text>
          {user?.is_subscribed ? (
            <Pressable
              testID="settings-manage-subscription"
              onPress={manageSubscriptions}
              style={styles.row}
            >
              <View style={styles.rowLeft}>
                <Text style={styles.label}>Manage subscription</Text>
                <Text style={styles.subLabel}>Cancel or change your plan</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceTertiary} />
            </Pressable>
          ) : (
            <Pressable
              testID="settings-become-member"
              onPress={() => router.push("/paywall")}
              style={styles.row}
            >
              <Text style={[styles.label, { color: colors.brand, fontWeight: "800" }]}>
                Become a member
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.brand} />
            </Pressable>
          )}
          <Pressable
            testID="settings-restore-purchases"
            onPress={onRestore}
            style={styles.row}
          >
            <Text style={styles.label}>Restore purchases</Text>
            <Ionicons name="refresh" size={18} color={colors.onSurfaceTertiary} />
          </Pressable>

          {user ? (
            <>
              <Text style={[styles.sectionLabel, styles.divTop]}>NOTIFICATIONS</Text>
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Text style={styles.label}>Push notifications</Text>
                  <Text style={styles.subLabel}>
                    Likes, comments, new followers & posts
                  </Text>
                </View>
                <Switch
                  testID="settings-push-toggle"
                  value={pushOn}
                  onValueChange={togglePush}
                  disabled={pushBusy}
                  trackColor={{ false: colors.border, true: colors.brand }}
                />
              </View>
            </>
          ) : null}

          <Text style={[styles.sectionLabel, styles.divTop]}>LEGAL</Text>
          {legalItems.map((item) => (
            <Pressable
              key={item.key}
              testID={`settings-${item.key}`}
              onPress={() =>
                (item as any).route
                  ? router.push((item as any).route)
                  : router.push({ pathname: "/legal", params: { section: item.key } })
              }
              style={styles.row}
            >
              <Text style={styles.label}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceTertiary} />
            </Pressable>
          ))}

          <Pressable
            testID="settings-logout"
            onPress={async () => {
              await logout();
              router.replace("/(auth)/login");
            }}
            style={[styles.row, styles.divTop]}
          >
            <Text style={[styles.label, { fontWeight: "700" }]}>Log out</Text>
            <Ionicons name="log-out-outline" size={18} color={colors.onSurface} />
          </Pressable>

          <Pressable
            testID="settings-delete-account"
            onPress={async () => {
              const ok = await confirmDialog(
                "Delete your account?",
                "You have 30 days to change your mind by signing back in and tapping Restore. After 30 days everything is permanently erased.",
                { confirmText: "Delete account", destructive: true }
              );
              if (!ok) return;
              try {
                await api.del("/auth/me");
                await refresh();
                router.replace("/(auth)/login");
              } catch {}
            }}
            style={styles.row}
          >
            <Text style={[styles.label, { color: colors.error, fontWeight: "700" }]}>
              Delete account
            </Text>
            <Ionicons name="trash" size={18} color={colors.error} />
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  backBtn: { width: 24, alignItems: "flex-start" },
  topTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  scrollContent: { paddingBottom: spacing.xxxl },
  menu: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
  },
  divTop: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.sm, paddingTop: spacing.md },
  label: { color: colors.onSurface, fontSize: text.base },
  rowLeft: { flex: 1 },
  subLabel: { color: colors.onSurfaceTertiary, fontSize: text.sm, marginTop: 2 },
  sectionLabel: {
    color: colors.onSurfaceTertiary,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  founderRow: {
    backgroundColor: "#FFF8E1",
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#FFB300",
    marginBottom: spacing.sm,
  },
  founderRowLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  founderRowIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#FFB300",
    alignItems: "center",
    justifyContent: "center",
  },
  openCountPill: {
    backgroundColor: colors.error,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    minWidth: 22,
    alignItems: "center",
  },
  openCountText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  deletionBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.errorBg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  deletionText: { flex: 1, color: colors.error, fontSize: text.sm, fontWeight: "600" },
  restoreBtn: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  restoreText: { color: colors.onBrand, fontWeight: "700", fontSize: text.sm },
});
