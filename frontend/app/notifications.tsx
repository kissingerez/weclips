import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/lib/api";
import { Avatar } from "@/src/components/Avatar";
import { colors, radius, spacing, text } from "@/src/theme";

type Notification = {
  id: string;
  type: "follow" | "comment" | "like" | "report" | "new_video" | "warning" | "suspended" | "banned";
  actor_id: string;
  actor_name: string;
  actor_username?: string | null;
  actor_has_avatar?: boolean;
  video_id?: string | null;
  video_title?: string | null;
  text?: string | null;
  report_id?: string | null;
  report_target_type?: "video" | "user" | null;
  read: boolean;
  created_at: string;
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

const ICONS: Record<Notification["type"], { name: any; color: string }> = {
  follow: { name: "person-add", color: colors.brand },
  comment: { name: "chatbubble", color: colors.brand },
  like: { name: "heart", color: colors.error },
  report: { name: "flag", color: "#D97706" },
  new_video: { name: "videocam", color: colors.brand },
  warning: { name: "warning", color: "#D97706" },
  suspended: { name: "time", color: "#D97706" },
  banned: { name: "hand-left", color: colors.error },
};

const VERBS: Record<Notification["type"], string> = {
  follow: "started following you",
  comment: "commented on your video",
  like: "liked your video",
  report: "filed a report",
  new_video: "posted a new video",
  warning: "sent you a warning",
  suspended: "suspended your account",
  banned: "banned your account",
};

export default function Notifications() {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<Notification[]>("/notifications");
      setItems(data);
      // Mark everything read on view
      await api.post("/notifications/mark-read").catch(() => {});
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const tap = (n: Notification) => {
    if (n.type === "report") router.push("/admin/reports");
    else if (n.type === "warning" || n.type === "suspended" || n.type === "banned") {
      // No deep link — content is in the notification text itself.
    } else if (n.type === "follow") router.push(`/user/${n.actor_id}`);
    else if (n.video_id) router.push(`/video/${n.video_id}`);
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          testID="notifications-back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons
            name="notifications-outline"
            size={56}
            color={colors.onSurfaceTertiary}
          />
          <Text style={styles.emptyTitle}>You're all caught up</Text>
          <Text style={styles.emptySub}>
            Likes, comments and new followers will show up here.
          </Text>
        </View>
      ) : (
        <FlatList
          testID="notifications-list"
          data={items}
          keyExtractor={(n) => n.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          renderItem={({ item }) => (
            <Pressable
              testID={`notification-${item.id}`}
              style={[styles.row, !item.read && styles.rowUnread]}
              onPress={() => tap(item)}
            >
              <View style={styles.iconWrap}>
                <Avatar
                  userId={item.actor_id}
                  displayName={item.actor_name}
                  hasAvatar={!!item.actor_has_avatar}
                  size={40}
                />
                <View
                  style={[styles.iconBadge, { backgroundColor: colors.surface }]}
                >
                  <Ionicons
                    name={ICONS[item.type].name}
                    size={12}
                    color={ICONS[item.type].color}
                  />
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.line} numberOfLines={2}>
                  <Text style={styles.actor}>{item.actor_name}</Text>
                  {item.actor_username ? (
                    <Text style={styles.handle}> @{item.actor_username}</Text>
                  ) : null}
                  <Text style={styles.verb}> {VERBS[item.type]}</Text>
                  {item.video_title ? (
                    <Text style={styles.videoTitle}> "{item.video_title}"</Text>
                  ) : null}
                </Text>
                {item.type === "comment" && item.text ? (
                  <Text style={styles.preview} numberOfLines={2}>
                    “{item.text}”
                  </Text>
                ) : null}
                <Text style={styles.timestamp}>{timeAgo(item.created_at)}</Text>
              </View>
              {!item.read ? <View style={styles.unreadDot} /> : null}
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700", marginTop: spacing.md },
  emptySub: {
    color: colors.onSurfaceSecondary,
    fontSize: text.base,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowUnread: { backgroundColor: colors.surfaceSecondary },
  iconWrap: { position: "relative" },
  iconBadge: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  line: { color: colors.onSurface, fontSize: text.sm, lineHeight: 18 },
  actor: { fontWeight: "800" },
  handle: { color: colors.brand, fontWeight: "700" },
  verb: { color: colors.onSurfaceSecondary },
  videoTitle: { color: colors.onSurface, fontWeight: "700" },
  preview: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 4, fontStyle: "italic" },
  timestamp: { color: colors.onSurfaceTertiary, fontSize: 11, marginTop: 4 },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: colors.brand,
  },
});
