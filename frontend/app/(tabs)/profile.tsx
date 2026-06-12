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
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [videos, setVideos] = useState<VideoCardData[]>([]);
  const [loading, setLoading] = useState(true);

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

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.topBar}>
        <View style={{ width: 40 }} />
        <Pressable
          testID="profile-settings-button"
          onPress={() => router.push("/settings")}
          hitSlop={8}
          style={styles.gearBtn}
        >
          <Ionicons name="settings-outline" size={22} color={colors.onSurface} />
        </Pressable>
      </View>

      <ScrollView
        testID="profile-scroll"
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <Avatar
              userId={user?.id}
              displayName={user?.display_name}
              hasAvatar={!!user?.has_avatar}
              size={84}
              version={user?.id}
              square
            />
            <View style={styles.headerInfo}>
              <View style={styles.nameRow}>
                <Text style={styles.name} testID="profile-name" numberOfLines={1}>
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
              {user?.is_subscribed ? (
                <View style={styles.memberChip} testID="profile-subscription-badge">
                  <Ionicons name="checkmark-circle" size={12} color={colors.brand} />
                  <Text style={styles.memberChipText}>Member</Text>
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.statsRow}>
            <Pressable
              testID="profile-followers-count"
              onPress={() => user?.id && router.push(`/user/${user.id}/followers?tab=followers`)}
              style={styles.statBtn}
              hitSlop={6}
            >
              <Text style={styles.statNum}>{user?.followers ?? 0}</Text>
              <Text style={styles.statLabel}>
                {(user?.followers ?? 0) === 1 ? "Follower" : "Followers"}
              </Text>
            </Pressable>
            <Text style={styles.statDot}>·</Text>
            <Pressable
              testID="profile-following-count"
              onPress={() => user?.id && router.push(`/user/${user.id}/followers?tab=following`)}
              style={styles.statBtn}
              hitSlop={6}
            >
              <Text style={styles.statNum}>{user?.following ?? 0}</Text>
              <Text style={styles.statLabel}>Following</Text>
            </Pressable>
            <Text style={styles.statDot}>·</Text>
            <View style={styles.statBtn}>
              <Text style={styles.statNum}>{videos.length}</Text>
              <Text style={styles.statLabel}>{videos.length === 1 ? "Clip" : "Clips"}</Text>
            </View>
          </View>

          {user?.bio ? (
            <Text style={styles.bio} testID="profile-bio" numberOfLines={5}>
              {user.bio}
            </Text>
          ) : null}

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
              style={[styles.action, styles.actionOutline]}
            >
              <Text style={[styles.actionText, { color: colors.onSurface }]}>Edit profile</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Clips</Text>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.brand} />
          </View>
        ) : videos.length === 0 ? (
          <View style={styles.center} testID="profile-empty">
            <Ionicons name="film-outline" size={48} color={colors.onSurfaceTertiary} />
            <Text style={styles.emptyTitle}>No uploads yet</Text>
            <Text style={styles.emptySub}>Upload your first video from the Upload tab.</Text>
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
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  gearBtn: { width: 40, height: 40, alignItems: "flex-end", justifyContent: "center" },
  scrollContent: { paddingBottom: spacing.xxxl },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerTop: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  headerInfo: { flex: 1 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexWrap: "wrap" },
  name: { color: colors.onSurface, fontSize: text.xl, fontWeight: "800" },
  username: { color: colors.brand, fontSize: text.sm, fontWeight: "700", marginTop: 2 },
  founderInlineBadge: {
    backgroundColor: "#FFB300",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  founderInlineText: { color: "#1A1A1A", fontSize: 11, fontWeight: "800" },
  memberChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    marginTop: spacing.xs,
    backgroundColor: colors.surfaceTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  memberChipText: { color: colors.onSurface, fontSize: 11, fontWeight: "700" },
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
  bio: { color: colors.onSurface, fontSize: text.sm, marginTop: spacing.md, lineHeight: 19 },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  action: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: "center" },
  actionOutline: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionText: { color: colors.onBrand, fontWeight: "700" },
  sectionHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  sectionTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700", marginTop: spacing.sm },
  emptySub: { color: colors.onSurfaceSecondary, fontSize: text.base, marginTop: spacing.xs, textAlign: "center" },
  videoRow: { position: "relative" },
  videoActions: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.lg + spacing.sm,
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
});
