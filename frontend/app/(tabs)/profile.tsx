import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/lib/auth";
import { api } from "@/src/lib/api";
import { confirmDialog } from "@/src/lib/dialogs";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { Avatar } from "@/src/components/Avatar";
import { colors, radius, spacing, text } from "@/src/theme";

export default function Profile() {
  const { user, logout, refresh } = useAuth();
  const router = useRouter();
  const [videos, setVideos] = useState<VideoCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [openReports, setOpenReports] = useState<number>(0);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      await refresh();
      const mine = await api.get<VideoCardData[]>("/videos/mine");
      setVideos(mine);
    } catch {
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

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
      load();
      if (user?.is_founder) loadFounderSummary();
    }, [load, loadFounderSummary, user?.is_founder])
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView
        testID="profile-scroll"
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={true}
      >
        {user?.deletion_pending ? (
          <View style={styles.deletionBanner} testID="profile-deletion-banner">
            <Ionicons name="warning" size={18} color={colors.error} />
            <Text style={styles.deletionText}>
              Account scheduled for deletion
              {user.deletion_expires_at
                ? ` on ${new Date(user.deletion_expires_at).toLocaleDateString()}`
                : ""}
              .
            </Text>
            <Pressable
              testID="profile-restore-account"
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

        <View style={styles.header}>
          <Avatar
            userId={user?.id}
            displayName={user?.display_name}
            hasAvatar={!!user?.has_avatar}
            size={64}
            version={user?.id}
          />
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={styles.name} testID="profile-name">
                {user?.display_name || "Unknown"}
              </Text>
              {user?.is_founder ? (
                <View style={styles.founderInlineBadge} testID="profile-founder-badge">
                  <Text style={styles.founderInlineText}>Founder</Text>
                </View>
              ) : null}
            </View>
            {user?.username ? (
              <Text style={styles.username} testID="profile-username">
                @{user.username}
              </Text>
            ) : null}
            <Text style={styles.email}>{user?.email_public ? user?.email : ""}</Text>
            {user?.bio ? (
              <Text style={styles.bio} testID="profile-bio" numberOfLines={4}>
                {user.bio}
              </Text>
            ) : null}
            <View style={styles.followCountsRow}>
              <Pressable
                testID="profile-followers-count"
                onPress={() =>
                  user?.id && router.push(`/user/${user.id}/followers?tab=followers`)
                }
                style={styles.countBtn}
                hitSlop={6}
              >
                <Text style={styles.countNum}>{user?.followers ?? 0}</Text>
                <Text style={styles.countLabel}>
                  {(user?.followers ?? 0) === 1 ? "Follower" : "Followers"}
                  {user?.followers_hidden ? " · Hidden" : ""}
                </Text>
              </Pressable>
              <View style={styles.countDivider} />
              <Pressable
                testID="profile-following-count"
                onPress={() =>
                  user?.id && router.push(`/user/${user.id}/followers?tab=following`)
                }
                style={styles.countBtn}
                hitSlop={6}
              >
                <Text style={styles.countNum}>{user?.following ?? 0}</Text>
                <Text style={styles.countLabel}>Following</Text>
              </Pressable>
            </View>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusBadge,
                  user?.is_subscribed ? styles.subOn : styles.subOff,
                ]}
              >
                <Ionicons
                  name={user?.is_subscribed ? "checkmark-circle" : "lock-closed"}
                  size={12}
                  color={user?.is_subscribed ? colors.onBrand : colors.onSurfaceSecondary}
                />
                <Text
                  testID="profile-subscription-badge"
                  style={[
                    styles.statusText,
                    {
                      color: user?.is_subscribed
                        ? colors.onBrand
                        : colors.onSurfaceSecondary,
                    },
                  ]}
                >
                  {user?.is_subscribed ? "Member · Active" : "Free"}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.actions}>
          {!user?.is_subscribed ? (
            <Pressable
              testID="profile-subscribe-button"
              onPress={() => router.push("/paywall")}
              style={[styles.action, { backgroundColor: colors.brand }]}
            >
              <Text style={styles.actionText}>Become a Member · $1/mo</Text>
            </Pressable>
          ) : null}
          <Pressable
            testID="profile-edit-button"
            onPress={() => router.push("/edit-profile")}
            style={[
              styles.action,
              {
                backgroundColor: colors.surfaceSecondary,
                borderWidth: 1,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.actionText, { color: colors.onSurface }]}>
              Edit account
            </Text>
          </Pressable>
          <Pressable
            testID="profile-logout-button"
            onPress={async () => {
              await logout();
              router.replace("/(auth)/login");
            }}
            style={[
              styles.action,
              {
                backgroundColor: colors.surfaceSecondary,
                borderWidth: 1,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.actionText, { color: colors.onSurface }]}>
              Log out
            </Text>
          </Pressable>
        </View>

        <View style={styles.legalMenu} testID="profile-legal-menu">
          {user?.is_founder ? (
            <Pressable
              testID="profile-founder-reports"
              onPress={() => router.push("/admin/reports")}
              style={[styles.legalRow, styles.founderRow]}
            >
              <View style={styles.founderRowLeft}>
                <View style={styles.founderRowIcon}>
                  <Ionicons name="flag" size={16} color="#1A1A1A" />
                </View>
                <Text style={[styles.legalLabel, { fontWeight: "800" }]}>
                  Reports
                </Text>
                {openReports > 0 ? (
                  <View style={styles.openCountPill} testID="profile-founder-reports-count">
                    <Text style={styles.openCountText}>{openReports}</Text>
                  </View>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceTertiary} />
            </Pressable>
          ) : null}
          {[
            { key: "blocked", label: "Blocked accounts", route: "/blocked" },
            { key: "guidelines", label: "Community Guidelines" },
            { key: "privacy", label: "Privacy Policy" },
            { key: "terms", label: "Terms of Service" },
            { key: "about", label: "About & Contact" },
          ].map((item) => (
            <Pressable
              key={item.key}
              testID={`profile-legal-${item.key}`}
              onPress={() =>
                (item as any).route
                  ? router.push((item as any).route)
                  : router.push({ pathname: "/legal", params: { section: item.key } })
              }
              style={styles.legalRow}
            >
              <Text style={styles.legalLabel}>{item.label}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceTertiary} />
            </Pressable>
          ))}
          <Pressable
            testID="profile-delete-account"
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
              } catch {}
            }}
            style={[
              styles.legalRow,
              { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.sm },
            ]}
          >
            <Text style={[styles.legalLabel, { color: colors.error, fontWeight: "700" }]}>
              Delete account
            </Text>
            <Ionicons name="trash" size={18} color={colors.error} />
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your videos</Text>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.brand} />
          </View>
        ) : videos.length === 0 ? (
          <View style={styles.center} testID="profile-empty">
            <Ionicons name="film-outline" size={48} color={colors.onSurfaceTertiary} />
            <Text style={styles.emptyTitle}>No uploads yet</Text>
            <Text style={styles.emptySub}>
              Upload your first video from the Upload tab.
            </Text>
          </View>
        ) : (
          videos.map((item) => (
            <View key={item.id} style={styles.videoRow}>
              <VideoCard video={item} />
              <View style={styles.videoActions}>
                <Pressable
                  testID={`profile-edit-video-${item.id}`}
                  onPress={() => router.push(`/video/edit/${item.id}`)}
                  style={[styles.videoBtn, { backgroundColor: colors.brand }]}
                  hitSlop={8}
                >
                  <Ionicons name="create" size={14} color={colors.onBrand} />
                  <Text style={styles.videoBtnText}>Edit</Text>
                </Pressable>
                <Pressable
                  testID={`profile-delete-video-${item.id}`}
                  onPress={async () => {
                    const ok = await confirmDialog(
                      "Delete video?",
                      `Delete "${item.title}"? This cannot be undone.`,
                      { confirmText: "Delete", destructive: true }
                    );
                    if (!ok) return;
                    try {
                      await api.del(`/videos/${item.id}`);
                      setVideos((prev) => prev.filter((v) => v.id !== item.id));
                    } catch {}
                  }}
                  style={[styles.videoBtn, { backgroundColor: colors.error }]}
                  hitSlop={8}
                >
                  <Ionicons name="trash" size={14} color={colors.onBrand} />
                  <Text style={styles.videoBtnText}>Delete</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  scrollContent: { paddingBottom: spacing.xxxl },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.onBrand, fontSize: 28, fontWeight: "900" },
  name: { color: colors.onSurface, fontSize: text.xl, fontWeight: "800" },
  username: { color: colors.brand, fontSize: text.sm, fontWeight: "700", marginTop: 2 },
  email: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 2 },
  bio: { color: colors.onSurface, fontSize: text.sm, marginTop: spacing.xs, lineHeight: 18 },
  followCountsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
    gap: spacing.lg,
  },
  countBtn: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  countNum: { color: colors.onSurface, fontSize: text.base, fontWeight: "800" },
  countLabel: { color: colors.onSurfaceSecondary, fontSize: text.sm, fontWeight: "600" },
  countDivider: { width: 1, height: 14, backgroundColor: colors.border },
  statusRow: { flexDirection: "row", marginTop: spacing.sm },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  subOn: { backgroundColor: colors.brand },
  subOff: { backgroundColor: colors.surfaceTertiary },
  founderBadge: { backgroundColor: "#FFB300", marginLeft: spacing.xs },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" },
  founderInlineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#FFB300",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  founderInlineText: { color: "#1A1A1A", fontSize: 11, fontWeight: "800" },
  statusText: { fontSize: 11, fontWeight: "700" },
  actions: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  action: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  actionText: { color: colors.onBrand, fontWeight: "700" },
  sectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  sectionTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700" },
  legalMenu: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  legalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
  },
  legalLabel: { color: colors.onSurface, fontSize: text.base },
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
  videoRow: { position: "relative" },
  videoActions: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: "row",
    gap: spacing.xs,
  },
  videoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  videoBtnText: { color: colors.onBrand, fontSize: 11, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: {
    color: colors.onSurface,
    fontSize: text.lg,
    fontWeight: "700",
    marginTop: spacing.sm,
  },
  emptySub: {
    color: colors.onSurfaceSecondary,
    fontSize: text.base,
    marginTop: spacing.xs,
    textAlign: "center",
  },
});
