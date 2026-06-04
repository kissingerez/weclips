import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/lib/auth";
import { api } from "@/src/lib/api";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { colors, radius, spacing, text } from "@/src/theme";
export default function Profile() {
  const { user, logout, refresh } = useAuth();
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
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(user?.display_name?.[0] || "?").toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} testID="profile-name">
            {user?.display_name || "Unknown"}
          </Text>
          <Text style={styles.email}>{user?.email}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusBadge, user?.is_subscribed ? styles.subOn : styles.subOff]}>
              <Ionicons
                name={user?.is_subscribed ? "checkmark-circle" : "lock-closed"}
                size={12}
                color={user?.is_subscribed ? colors.onBrand : colors.onSurfaceSecondary}
              />
              <Text
                testID="profile-subscription-badge"
                style={[
                  styles.statusText,
                  { color: user?.is_subscribed ? colors.onBrand : colors.onSurfaceSecondary },
                ]}
              >
                {user?.is_subscribed ? "Premium · Active" : "Free"}
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
            <Text style={styles.actionText}>Go Premium · $1/mo</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="profile-logout-button"
          onPress={async () => {
            await logout();
            router.replace("/(auth)/login");
          }}
          style={[styles.action, { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border }]}
        >
          <Text style={[styles.actionText, { color: colors.onSurface }]}>Log out</Text>
        </Pressable>
      </View>

      <View style={styles.legalMenu} testID="profile-legal-menu">
        {[
          { key: "guidelines", label: "Community Guidelines" },
          { key: "privacy", label: "Privacy Policy" },
          { key: "terms", label: "Terms of Service" },
          { key: "about", label: "About & Contact" },
        ].map((item) => (
          <Pressable
            key={item.key}
            testID={`profile-legal-${item.key}`}
            onPress={() => router.push({ pathname: "/legal", params: { section: item.key } })}
            style={styles.legalRow}
          >
            <Text style={styles.legalLabel}>{item.label}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceTertiary} />
          </Pressable>
        ))}
        <Pressable
          testID="profile-delete-account"
          onPress={() => {
            if (typeof window !== "undefined" && window.confirm) {
              if (!window.confirm("Delete your account? You have 30 days to change your mind by signing back in and tapping Restore. After 30 days everything is permanently erased.")) return;
            }
            (async () => {
              try {
                await api.del("/auth/me");
                await refresh();
              } catch {}
            })();
          }}
          style={[styles.legalRow, { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.sm }]}
        >
          <Text style={[styles.legalLabel, { color: colors.error, fontWeight: "700" }]}>Delete account</Text>
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
          <Text style={styles.emptySub}>Upload your first video from the Upload tab.</Text>
        </View>
      ) : (
        <FlatList
          testID="profile-video-list"
          data={videos}
          keyExtractor={(v) => v.id}
          renderItem={({ item }) => <VideoCard video={item} />}
          contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xxxl }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
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
  email: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 2 },
  statusRow: { flexDirection: "row", marginTop: spacing.sm },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.pill },
  subOn: { backgroundColor: colors.brand },
  subOff: { backgroundColor: colors.surfaceTertiary },
  statusText: { fontSize: 11, fontWeight: "700" },
  actions: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  action: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: "center" },
  actionText: { color: colors.onBrand, fontWeight: "700" },
  sectionHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  sectionTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700" },
  legalMenu: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  legalRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.md },
  legalLabel: { color: colors.onSurface, fontSize: text.base },
  deletionBanner: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.errorBg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  deletionText: { flex: 1, color: colors.error, fontSize: text.sm, fontWeight: "600" },
  restoreBtn: { backgroundColor: colors.brand, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm },
  restoreText: { color: colors.onBrand, fontWeight: "700", fontSize: text.sm },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700", marginTop: spacing.sm },
  emptySub: { color: colors.onSurfaceSecondary, fontSize: text.base, marginTop: spacing.xs, textAlign: "center" },
});
