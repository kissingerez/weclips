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
import { Avatar } from "@/src/components/Avatar";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { colors, radius, spacing, text } from "@/src/theme";

type PublicUser = {
  id: string;
  display_name: string;
  username?: string | null;
  bio?: string | null;
  has_avatar?: boolean;
  followers: number;
};

export default function UserProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [videos, setVideos] = useState<VideoCardData[]>([]);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        <View style={styles.heroRow}>
          <Avatar
            userId={user.id}
            displayName={user.display_name}
            hasAvatar={!!user.has_avatar}
            size={88}
          />
          <View style={{ flex: 1, marginLeft: spacing.lg }}>
            <Text style={styles.name} testID="user-profile-name">
              {user.display_name}
            </Text>
            {user.username ? (
              <Text style={styles.handle}>@{user.username}</Text>
            ) : null}
            <Text style={styles.followers}>
              {user.followers} {user.followers === 1 ? "follower" : "followers"}
            </Text>
          </View>
        </View>

        {user.bio ? (
          <Text style={styles.bio} testID="user-profile-bio">
            {user.bio}
          </Text>
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
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  name: { color: colors.onSurface, fontSize: text.xl, fontWeight: "800" },
  handle: { color: colors.brand, fontSize: text.base, fontWeight: "700", marginTop: 2 },
  followers: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 4 },
  bio: {
    color: colors.onSurface,
    fontSize: text.base,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    lineHeight: 20,
  },
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
