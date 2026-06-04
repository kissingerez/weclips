import { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View, ActivityIndicator, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { api } from "@/src/lib/api";
import { colors, spacing, text, brandFont, radius } from "@/src/theme";

export default function Home() {
  const router = useRouter();
  const [videos, setVideos] = useState<VideoCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);

  const loadUnread = useCallback(async () => {
    try {
      const r = await api.get<{ count: number }>("/notifications/unread-count");
      setUnread(r.count || 0);
    } catch {
      setUnread(0);
    }
  }, []);

  const load = useCallback(async (showSpinner = false) => {
    try {
      if (showSpinner) setLoading(true);
      setErr(null);
      const data = await api.get<VideoCardData[]>("/videos");
      setVideos(data);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      loadUnread();
    }, [load, loadUnread])
  );

  useEffect(() => {
    load(true);
    loadUnread();
  }, [load, loadUnread]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header} testID="home-header">
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>WeClips</Text>
          <Text style={styles.badge}>AD-FREE · CHRISTIAN · CALM</Text>
        </View>
        <Pressable
          testID="home-notifications-button"
          onPress={() => router.push("/notifications")}
          style={styles.bellBtn}
          hitSlop={8}
        >
          <Ionicons name="notifications" size={22} color={colors.brand} />
          {unread > 0 ? (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText} numberOfLines={1}>
                {unread > 99 ? "99+" : unread}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : err ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{err}</Text>
          <Pressable onPress={() => load(true)} style={styles.retryBtn} testID="home-retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : videos.length === 0 ? (
        <View style={styles.center} testID="home-empty">
          <Ionicons name="videocam-outline" size={56} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>No videos yet</Text>
          <Text style={styles.emptySub}>Be the first to upload! Subscribe for $1/month to start.</Text>
        </View>
      ) : (
        <FlatList
          testID="home-video-list"
          data={videos}
          keyExtractor={(v) => v.id}
          renderItem={({ item }) => <VideoCard video={item} />}
          contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xxxl }}
          refreshControl={
            <RefreshControl
              tintColor={colors.brand}
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  brand: { ...brandFont, color: colors.brand, fontSize: 28, fontWeight: "900", letterSpacing: -0.5 },
  badge: {
    color: colors.onSurfaceSecondary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    backgroundColor: colors.surfaceTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 4,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.xl, fontWeight: "700", marginTop: spacing.md },
  emptySub: { color: colors.onSurfaceSecondary, fontSize: text.base, textAlign: "center", marginTop: spacing.sm },
  errorText: { color: colors.error, marginBottom: spacing.md },
  retryBtn: { backgroundColor: colors.brand, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: 8 },
  retryText: { color: colors.onBrand, fontWeight: "700" },
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  bellBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.error,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.surface,
  },
  bellBadgeText: {
    color: colors.onBrand,
    fontSize: 10,
    fontWeight: "800",
  },
});
