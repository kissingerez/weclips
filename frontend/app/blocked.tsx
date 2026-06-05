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
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/lib/api";
import { Avatar } from "@/src/components/Avatar";
import { Toast } from "@/src/components/Toast";
import { colors, radius, spacing, text } from "@/src/theme";

type UserRow = {
  id: string;
  display_name: string;
  username?: string | null;
  has_avatar?: boolean;
};

export default function BlockedList() {
  const router = useRouter();
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserRow[]>("/users/me/blocks/list");
      setItems(data || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const unblock = async (uid: string) => {
    try {
      await api.del(`/users/${uid}/block`);
      setItems((prev) => prev.filter((u) => u.id !== uid));
      setToast("Unblocked");
    } catch {
      setToast("Could not unblock");
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="blocked-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Blocked accounts</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="ban-outline" size={48} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>No blocked accounts</Text>
          <Text style={styles.emptySub}>
            Blocking someone hides their videos from your feed.
          </Text>
        </View>
      ) : (
        <FlatList
          testID="blocked-list"
          data={items}
          keyExtractor={(u) => u.id}
          renderItem={({ item }) => (
            <View style={styles.row}>
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
              </View>
              <Pressable
                testID={`unblock-${item.id}`}
                onPress={() => unblock(item.id)}
                style={styles.unblockBtn}
              >
                <Text style={styles.unblockText}>Unblock</Text>
              </Pressable>
            </View>
          )}
        />
      )}

      <Toast
        message={toast}
        variant="success"
        durationMs={1500}
        onHide={() => setToast(null)}
      />
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
  emptySub: { color: colors.onSurfaceSecondary, fontSize: text.sm, textAlign: "center", marginTop: spacing.xs },
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
  unblockBtn: {
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  unblockText: { color: colors.onSurface, fontWeight: "800", fontSize: text.sm },
});
