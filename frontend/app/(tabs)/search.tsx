import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { Avatar } from "@/src/components/Avatar";
import { api } from "@/src/lib/api";
import { colors, radius, spacing, text } from "@/src/theme";

type Mode = "videos" | "users";

type UserResult = {
  id: string;
  display_name: string;
  username?: string | null;
  has_avatar?: boolean;
  followers: number;
};

export default function Search() {
  const [mode, setMode] = useState<Mode>("videos");
  const [q, setQ] = useState("");
  const [videoResults, setVideoResults] = useState<VideoCardData[]>([]);
  const [userResults, setUserResults] = useState<UserResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  const onSearch = async () => {
    const term = q.trim();
    if (!term) return;
    setLoading(true);
    try {
      if (mode === "videos") {
        const data = await api.get<VideoCardData[]>(`/videos?q=${encodeURIComponent(term)}`);
        setVideoResults(data);
      } else {
        const data = await api.get<UserResult[]>(`/users/search?q=${encodeURIComponent(term)}`);
        setUserResults(data);
      }
      setSearched(true);
    } catch {
      if (mode === "videos") setVideoResults([]);
      else setUserResults([]);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setSearched(false);
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.searchBox}>
          <Ionicons name="search" color={colors.onSurfaceTertiary} size={18} />
          <TextInput
            testID="search-input"
            placeholder={mode === "videos" ? "Search videos, titles, creators..." : "Search by @username or name..."}
            placeholderTextColor={colors.onSurfaceTertiary}
            style={styles.searchInput}
            value={q}
            onChangeText={setQ}
            onSubmitEditing={onSearch}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {q.length > 0 && (
            <Pressable onPress={() => setQ("")} hitSlop={10}>
              <Ionicons name="close-circle" size={18} color={colors.onSurfaceTertiary} />
            </Pressable>
          )}
        </View>
        <Pressable onPress={onSearch} style={styles.goBtn} testID="search-submit">
          <Text style={styles.goText}>{loading ? "..." : "Go"}</Text>
        </Pressable>
      </View>

      <View style={styles.modeRow}>
        <Pressable
          testID="search-mode-videos"
          style={[styles.modeBtn, mode === "videos" && styles.modeBtnActive]}
          onPress={() => switchMode("videos")}
        >
          <Ionicons
            name="film"
            size={14}
            color={mode === "videos" ? colors.onBrand : colors.onSurfaceSecondary}
          />
          <Text style={[styles.modeText, mode === "videos" && styles.modeTextActive]}>
            Videos
          </Text>
        </Pressable>
        <Pressable
          testID="search-mode-users"
          style={[styles.modeBtn, mode === "users" && styles.modeBtnActive]}
          onPress={() => switchMode("users")}
        >
          <Ionicons
            name="people"
            size={14}
            color={mode === "users" ? colors.onBrand : colors.onSurfaceSecondary}
          />
          <Text style={[styles.modeText, mode === "users" && styles.modeTextActive]}>
            Users
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : mode === "videos" ? (
        searched && videoResults.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="search-outline" size={56} color={colors.onSurfaceTertiary} />
            <Text style={styles.emptyTitle}>No video matches</Text>
            <Text style={styles.emptySub}>Try a different keyword.</Text>
          </View>
        ) : (
          <FlatList
            testID="search-results-list"
            data={videoResults}
            keyExtractor={(v) => v.id}
            renderItem={({ item }) => <VideoCard video={item} />}
            contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xxxl }}
          />
        )
      ) : searched && userResults.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={56} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>No users found</Text>
          <Text style={styles.emptySub}>Try a different username or name.</Text>
        </View>
      ) : (
        <FlatList
          testID="search-users-list"
          data={userResults}
          keyExtractor={(u) => u.id}
          renderItem={({ item }) => <UserRow user={item} />}
          contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xxxl }}
        />
      )}
    </SafeAreaView>
  );
}

function UserRow({ user }: { user: UserResult }) {
  const [following, setFollowing] = useState(false);
  const [followers, setFollowers] = useState(user.followers);
  const [busy, setBusy] = useState(false);

  // Load real follow status on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ following: boolean; followers: number }>(
          `/users/${user.id}/follow-status`
        );
        if (cancelled) return;
        setFollowing(r.following);
        setFollowers(r.followers);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (following) {
        const r = await api.del<{ following: boolean; followers: number }>(
          `/users/${user.id}/follow`
        );
        setFollowing(r.following);
        setFollowers(r.followers);
      } else {
        const r = await api.post<{ following: boolean; followers: number }>(
          `/users/${user.id}/follow`
        );
        setFollowing(r.following);
        setFollowers(r.followers);
      }
    } catch {}
    setBusy(false);
  };

  return (
    <View style={styles.userRow} testID={`user-result-${user.id}`}>
      <Avatar
        userId={user.id}
        displayName={user.display_name}
        hasAvatar={!!user.has_avatar}
        size={48}
      />
      <View style={{ flex: 1 }}>
        <Text style={styles.userName} numberOfLines={1}>
          {user.display_name}
        </Text>
        {user.username ? (
          <Text style={styles.userHandle} numberOfLines={1}>
            @{user.username}
          </Text>
        ) : null}
        <Text style={styles.userMeta}>
          {followers} {followers === 1 ? "follower" : "followers"}
        </Text>
      </View>
      <Pressable
        testID={`user-follow-${user.id}`}
        onPress={toggle}
        style={[styles.followBtn, following && styles.followingBtn]}
      >
        <Text style={[styles.followText, following && styles.followingText]}>
          {following ? "Following" : "Follow"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, color: colors.onSurface, fontSize: text.lg, padding: 0 },
  goBtn: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  goText: { color: colors.onBrand, fontWeight: "700" },
  modeRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  modeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modeBtnActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  modeText: { color: colors.onSurfaceSecondary, fontWeight: "700", fontSize: text.sm },
  modeTextActive: { color: colors.onBrand },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.xl, fontWeight: "700", marginTop: spacing.md },
  emptySub: { color: colors.onSurfaceSecondary, fontSize: text.base, marginTop: spacing.sm },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.onBrand, fontSize: 20, fontWeight: "900" },
  userName: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  userHandle: { color: colors.brand, fontSize: text.sm, fontWeight: "700", marginTop: 1 },
  userMeta: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 2 },
  followBtn: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  followingBtn: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  followText: { color: colors.onBrand, fontWeight: "700", fontSize: text.sm },
  followingText: { color: colors.onSurface },
});
