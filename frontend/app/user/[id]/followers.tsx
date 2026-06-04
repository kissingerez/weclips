import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, ApiError } from "@/src/lib/api";
import { Avatar } from "@/src/components/Avatar";
import { colors, radius, spacing, text } from "@/src/theme";

type UserRow = {
  id: string;
  display_name: string;
  username?: string | null;
  has_avatar?: boolean;
  followers: number;
  followers_hidden?: boolean;
};

export default function FollowersList() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const router = useRouter();
  const initial = tab === "following" ? "following" : "followers";
  const [mode, setMode] = useState<"followers" | "following">(initial);
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const path = mode === "followers" ? "followers" : "following";
      const data = await api.get<UserRow[]>(`/users/${id}/${path}`);
      setItems(data);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 403) {
        setErr("This list is hidden.");
        setItems([]);
      } else {
        setErr(e?.message || "Could not load");
        setItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, [id, mode]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="followers-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>
          {mode === "followers" ? "Followers" : "Following"}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.tabsRow}>
        <Pressable
          testID="followers-tab-followers"
          style={[styles.tabBtn, mode === "followers" && styles.tabBtnActive]}
          onPress={() => setMode("followers")}
        >
          <Text style={[styles.tabText, mode === "followers" && styles.tabTextActive]}>
            Followers
          </Text>
        </Pressable>
        <Pressable
          testID="followers-tab-following"
          style={[styles.tabBtn, mode === "following" && styles.tabBtnActive]}
          onPress={() => setMode("following")}
        >
          <Text style={[styles.tabText, mode === "following" && styles.tabTextActive]}>
            Following
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : err ? (
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={48} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>{err}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={48} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>
            {mode === "followers" ? "No followers yet" : "Not following anyone"}
          </Text>
        </View>
      ) : (
        <FlatList
          testID="followers-list"
          data={items}
          keyExtractor={(u) => u.id}
          renderItem={({ item }) => (
            <Pressable
              testID={`followers-row-${item.id}`}
              style={styles.row}
              onPress={() => router.push(`/user/${item.id}`)}
            >
              <Avatar
                userId={item.id}
                displayName={item.display_name}
                hasAvatar={!!item.has_avatar}
                size={48}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.display_name}
                </Text>
                {item.username ? (
                  <Text style={styles.handle} numberOfLines={1}>
                    @{item.username}
                  </Text>
                ) : null}
                {!item.followers_hidden ? (
                  <Text style={styles.meta}>
                    {item.followers} {item.followers === 1 ? "follower" : "followers"}
                  </Text>
                ) : null}
              </View>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={colors.onSurfaceTertiary}
              />
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  tabsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  tabBtnActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  tabText: { color: colors.onSurfaceSecondary, fontWeight: "700", fontSize: text.sm },
  tabTextActive: { color: colors.onBrand },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.base, fontWeight: "700", marginTop: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  name: { color: colors.onSurface, fontSize: text.base, fontWeight: "800" },
  handle: { color: colors.brand, fontSize: text.sm, fontWeight: "700", marginTop: 1 },
  meta: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 2 },
});
