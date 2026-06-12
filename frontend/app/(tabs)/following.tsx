import { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View, ActivityIndicator, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { api } from "@/src/lib/api";
import { colors, spacing, text, brandFont } from "@/src/theme";

export default function Following() {
  const router = useRouter();
  const [videos, setVideos] = useState<VideoCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = false) => {
    try {
      if (showSpinner) setLoading(true);
      setErr(null);
      const data = await api.get<VideoCardData[]>("/videos/following");
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
    }, [load])
  );

  useEffect(() => {
    load(true);
  }, [load]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header} testID="following-header">
        <Text style={styles.brand}>Following</Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : err ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{err}</Text>
          <Pressable onPress={() => load(true)} style={styles.retryBtn} testID="following-retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : videos.length === 0 ? (
        <View style={styles.center} testID="following-empty">
          <Ionicons name="people-outline" size={56} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>No clips yet</Text>
          <Text style={styles.emptySub}>
            Follow creators to see their latest clips here.
          </Text>
          <Pressable
            testID="following-discover-btn"
            onPress={() => router.push("/home")}
            style={styles.discoverBtn}
          >
            <Text style={styles.discoverText}>Discover creators</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          testID="following-video-list"
          data={videos}
          keyExtractor={(v) => v.id}
          renderItem={({ item }) => (
            <VideoCard
              video={item}
              onDeleted={(id) => setVideos((prev) => prev.filter((v) => v.id !== id))}
            />
          )}
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
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  brand: { ...brandFont, color: colors.brand, fontSize: 28, fontWeight: "900", letterSpacing: -0.5 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.xl, fontWeight: "700", marginTop: spacing.md },
  emptySub: { color: colors.onSurfaceSecondary, fontSize: text.base, textAlign: "center", marginTop: spacing.sm },
  discoverBtn: {
    marginTop: spacing.xl,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  discoverText: { color: colors.onBrand, fontWeight: "800", fontSize: text.base },
  errorText: { color: colors.error, marginBottom: spacing.md },
  retryBtn: { backgroundColor: colors.brand, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: 8 },
  retryText: { color: colors.onBrand, fontWeight: "700" },
});
