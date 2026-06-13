import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, ApiError } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { alertDialog, confirmDialog } from "@/src/lib/dialogs";
import { Avatar } from "@/src/components/Avatar";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { colors, radius, spacing, text } from "@/src/theme";

type PublicUser = {
  id: string;
  display_name: string;
  username?: string | null;
  bio?: string | null;
  has_avatar?: boolean;
  followers_hidden?: boolean;
  followers: number;
  following?: number;
  is_founder?: boolean;
  // Founder-only moderation fields
  is_banned?: boolean;
  ban_type?: "temporary" | "permanent" | null;
  banned_until?: string | null;
  ban_reason?: string | null;
  warnings_count?: number;
};

export default function UserProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user: me } = useAuth();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [videos, setVideos] = useState<VideoCardData[]>([]);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unbanBusy, setUnbanBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [u, vids, fs] = await Promise.all([
        api.get<PublicUser>(`/users/${id}`),
        api.get<VideoCardData[]>(`/users/${id}/videos`).catch(() => []),
        api
          .get<{ following: boolean; followers: number }>(`/users/${id}/follow-status`)
          .catch(() => ({ following: false, followers: 0 })),
      ]);
      setUser(u);
      setVideos(vids || []);
      setFollowing(!!fs.following);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 404) {
        setErr("User not found");
      } else {
        setErr(e?.message || "Could not load user");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleFollow = async () => {
    if (!me) return router.push("/(auth)/login");
    if (busy || !user) return;
    setBusy(true);
    try {
      if (following) {
        const r = await api.del<{ following: boolean; followers: number }>(
          `/users/${user.id}/follow`
        );
        setFollowing(r.following);
        setUser({ ...user, followers: r.followers });
      } else {
        const r = await api.post<{ following: boolean; followers: number }>(
          `/users/${user.id}/follow`
        );
        setFollowing(r.following);
        setUser({ ...user, followers: r.followers });
      }
    } catch {}
    setBusy(false);
  };

  const liftBan = async () => {
    if (!user || unbanBusy) return;
    const ok = await confirmDialog(
      `Lift ban on ${user.display_name}?`,
      "They will regain immediate access to WeClips and receive a reinstatement notice.",
      { confirmText: "Lift ban" }
    );
    if (!ok) return;
    setUnbanBusy(true);
    try {
      await api.post(`/admin/users/${user.id}/unban`);
      await load();
      await alertDialog("Done", `${user.display_name} has been reinstated.`);
    } catch (e: any) {
      await alertDialog("Failed", e?.message || "Please try again.");
    } finally {
      setUnbanBusy(false);
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
  if (err || !user) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <Text style={styles.errText}>{err || "User not found"}</Text>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="user-profile-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {user.username ? `@${user.username}` : user.display_name}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <Avatar
              userId={user.id}
              displayName={user.display_name}
              hasAvatar={!!user.has_avatar}
              size={84}
              square
            />
            <View style={styles.headerInfo}>
              <View style={styles.nameRow}>
                <Text style={styles.name} testID="user-profile-name" numberOfLines={1}>
                  {user.display_name}
                </Text>
                {user.is_founder ? (
                  <View style={styles.founderInlineBadge} testID="user-profile-founder-badge">
                    <Text style={styles.founderInlineText}>Founder</Text>
                  </View>
                ) : null}
              </View>
              {user.username ? <Text style={styles.handle}>@{user.username}</Text> : null}
            </View>
          </View>

          <View style={styles.statsRow}>
            {user.followers_hidden ? (
              <Text style={styles.followers}>Followers hidden</Text>
            ) : (
              <>
                <Pressable
                  testID="user-profile-followers-count"
                  onPress={() => router.push(`/user/${user.id}/followers?tab=followers`)}
                  style={styles.statBtn}
                  hitSlop={6}
                >
                  <Text style={styles.statNum}>{user.followers}</Text>
                  <Text style={styles.statLabel}>
                    {user.followers === 1 ? "Follower" : "Followers"}
                  </Text>
                </Pressable>
                <Text style={styles.statDot}>·</Text>
                <Pressable
                  testID="user-profile-following-count"
                  onPress={() => router.push(`/user/${user.id}/followers?tab=following`)}
                  style={styles.statBtn}
                  hitSlop={6}
                >
                  <Text style={styles.statNum}>{user.following ?? 0}</Text>
                  <Text style={styles.statLabel}>Following</Text>
                </Pressable>
                <Text style={styles.statDot}>·</Text>
              </>
            )}
            <View style={styles.statBtn}>
              <Text style={styles.statNum}>{videos.length}</Text>
              <Text style={styles.statLabel}>{videos.length === 1 ? "Clip" : "Clips"}</Text>
            </View>
          </View>
        </View>

        {user.bio ? (
          <Text style={styles.bio} testID="user-profile-bio">
            {user.bio}
          </Text>
        ) : null}

        {me?.is_founder && (user.is_banned || (user.warnings_count ?? 0) > 0) ? (
          <View
            style={[
              styles.modBanner,
              user.is_banned ? styles.modBannerBan : styles.modBannerWarn,
            ]}
            testID="user-profile-mod-banner"
          >
            <View style={styles.modBannerHeader}>
              <Ionicons
                name={
                  user.is_banned
                    ? user.ban_type === "permanent"
                      ? "hand-left"
                      : "time"
                    : "warning"
                }
                size={18}
                color={user.is_banned ? "#fff" : "#78350F"}
              />
              <Text
                style={[
                  styles.modBannerTitle,
                  { color: user.is_banned ? "#fff" : "#78350F" },
                ]}
              >
                {user.is_banned
                  ? user.ban_type === "permanent"
                    ? "Permanently banned"
                    : `Suspended${
                        user.banned_until
                          ? ` until ${new Date(user.banned_until).toLocaleDateString()}`
                          : ""
                      }`
                  : `${user.warnings_count} warning${
                      user.warnings_count === 1 ? "" : "s"
                    } on record`}
              </Text>
            </View>
            {user.ban_reason ? (
              <Text
                style={[
                  styles.modBannerReason,
                  { color: user.is_banned ? "#fff" : "#78350F" },
                ]}
              >
                {user.ban_reason}
              </Text>
            ) : null}
            {user.is_banned ? (
              <Pressable
                testID="user-profile-lift-ban"
                disabled={unbanBusy}
                onPress={liftBan}
                style={styles.liftBanBtn}
              >
                {unbanBusy ? (
                  <ActivityIndicator color={colors.error} size="small" />
                ) : (
                  <Ionicons name="lock-open" size={16} color={colors.error} />
                )}
                <Text style={styles.liftBanText}>Lift ban</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            testID="user-profile-follow"
            onPress={toggleFollow}
            disabled={busy}
            style={[
              styles.followBtn,
              following && styles.followingBtn,
              busy && { opacity: 0.6 },
            ]}
          >
            <Text style={[styles.followText, following && styles.followingText]}>
              {following ? "Following" : "Follow"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            Videos {videos.length > 0 ? `(${videos.length})` : ""}
          </Text>
        </View>

        {videos.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="film-outline" size={48} color={colors.onSurfaceTertiary} />
            <Text style={styles.emptyTitle}>No uploads yet</Text>
          </View>
        ) : (
          videos.map((v) => <VideoCard key={v.id} video={v} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  errText: { color: colors.onSurface, fontSize: text.lg, marginBottom: spacing.md },
  backBtn: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  backText: { color: colors.onBrand, fontWeight: "800" },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerTitle: {
    color: colors.onSurface,
    fontSize: text.lg,
    fontWeight: "800",
    flex: 1,
    textAlign: "center",
    paddingHorizontal: spacing.md,
  },
  scrollContent: { paddingBottom: spacing.xxxl },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTop: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  headerInfo: { flex: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" },
  name: { color: colors.onSurface, fontSize: text.xl, fontWeight: "800" },
  handle: { color: colors.brand, fontSize: text.sm, fontWeight: "700", marginTop: 2 },
  founderInlineBadge: {
    backgroundColor: "#FFB300",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  founderInlineText: { color: "#1A1A1A", fontSize: 11, fontWeight: "800" },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  statBtn: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  statNum: { color: colors.onSurface, fontSize: text.base, fontWeight: "800" },
  statLabel: { color: colors.onSurfaceSecondary, fontSize: text.sm, fontWeight: "600" },
  statDot: { color: colors.onSurfaceTertiary, fontSize: text.base, fontWeight: "800" },
  followers: { color: colors.onSurfaceSecondary, fontSize: text.sm },
  bio: {
    color: colors.onSurface,
    fontSize: text.base,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    lineHeight: 20,
  },
  modBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  modBannerWarn: {
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  modBannerBan: { backgroundColor: colors.error },
  modBannerHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  modBannerTitle: { fontSize: text.base, fontWeight: "800" },
  modBannerReason: { fontSize: text.sm, lineHeight: 18 },
  liftBanBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#fff",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  liftBanText: { color: colors.error, fontWeight: "800", fontSize: 13 },
  actions: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  followBtn: {
    backgroundColor: colors.brand,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  followingBtn: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  followText: { color: colors.onBrand, fontWeight: "800", fontSize: text.base },
  followingText: { color: colors.onSurface },
  sectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  sectionTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700" },
  empty: { alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: {
    color: colors.onSurface,
    fontSize: text.base,
    fontWeight: "700",
    marginTop: spacing.sm,
  },
});
