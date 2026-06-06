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
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, API_BASE } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { alertDialog, confirmDialog } from "@/src/lib/dialogs";
import { colors, radius, spacing, text } from "@/src/theme";

type AdminReport = {
  id: string;
  target_type: "video" | "user";
  target_id: string;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  created_at: string;
  reporter_id: string;
  reporter_name?: string | null;
  reporter_username?: string | null;
  video_title?: string | null;
  video_thumbnail_url?: string | null;
  video_creator_id?: string | null;
  video_creator_name?: string | null;
  user_display_name?: string | null;
  user_username?: string | null;
  target_missing?: boolean;
  target_user_id?: string | null;
  target_warnings_count?: number;
  target_is_banned?: boolean;
  target_ban_type?: "temporary" | "permanent" | null;
  target_banned_until?: string | null;
};

type StatusFilter = "open" | "resolved" | "dismissed" | "all";

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function AdminReports() {
  const router = useRouter();
  const { user } = useAuth();
  const [items, setItems] = useState<AdminReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("open");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<AdminReport[]>(
        `/admin/reports?status=${filter}`
      );
      setItems(data);
    } catch (e: any) {
      setItems([]);
      if (e?.status === 403) {
        await alertDialog("Founder access only", "This area is restricted.");
        router.back();
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, router]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const dismiss = async (r: AdminReport) => {
    const ok = await confirmDialog(
      "Dismiss this report?",
      "Use this if the report is invalid or the content is fine. Nothing will be deleted.",
      { confirmText: "Dismiss" }
    );
    if (!ok) return;
    setBusyId(r.id);
    try {
      await api.post(`/admin/reports/${r.id}/dismiss`);
      setItems((prev) => prev.filter((x) => x.id !== r.id));
    } catch (e: any) {
      await alertDialog("Failed", e?.message || "Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const moderatedLabel = (r: AdminReport) => {
    if (r.target_type === "video") {
      return r.video_creator_name || "the uploader";
    }
    return (
      r.user_display_name ||
      (r.user_username ? `@${r.user_username}` : "this user")
    );
  };

  const warn = async (r: AdminReport) => {
    const who = moderatedLabel(r);
    const ok = await confirmDialog(
      `Send a warning to ${who}?`,
      'They will receive an in-app notification with the policy reminder. The report will be marked as resolved.',
      { confirmText: "Send warning" }
    );
    if (!ok) return;
    setBusyId(r.id);
    try {
      await api.post(`/admin/reports/${r.id}/warn`, { reason: r.reason });
      await load();
    } catch (e: any) {
      await alertDialog("Failed", e?.message || "Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const suspend = async (r: AdminReport, days: number) => {
    const who = moderatedLabel(r);
    const ok = await confirmDialog(
      `Suspend ${who} for ${days} days?`,
      `They won't be able to use WeClips until the suspension ends. All open reports against them will be resolved.`,
      { confirmText: `Suspend ${days}d`, destructive: true }
    );
    if (!ok) return;
    setBusyId(r.id);
    try {
      await api.post(`/admin/reports/${r.id}/suspend`, {
        days,
        reason: r.reason,
      });
      await load();
    } catch (e: any) {
      await alertDialog("Failed", e?.message || "Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const ban = async (r: AdminReport) => {
    const who = moderatedLabel(r);
    const ok = await confirmDialog(
      `Permanently ban ${who}?`,
      `Their access to WeClips will be revoked immediately and indefinitely. You can lift this later from the admin queue.`,
      { confirmText: "Permanent ban", destructive: true }
    );
    if (!ok) return;
    setBusyId(r.id);
    try {
      await api.post(`/admin/reports/${r.id}/ban`, { reason: r.reason });
      await load();
    } catch (e: any) {
      await alertDialog("Failed", e?.message || "Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const deleteContent = async (r: AdminReport) => {
    const targetLabel =
      r.target_type === "video"
        ? `"${r.video_title || "this video"}"`
        : `${r.user_display_name || r.user_username || "this user"}`;
    if (r.target_type !== "video") {
      await alertDialog(
        "Only video deletion is automated",
        "Reports against users are recorded for review. Use the user's profile to take direct action (block, restrict, etc.)."
      );
      return;
    }
    const ok = await confirmDialog(
      "Delete reported content?",
      `This will permanently remove ${targetLabel} and resolve every open report about it.`,
      { confirmText: "Delete & resolve", destructive: true }
    );
    if (!ok) return;
    setBusyId(r.id);
    try {
      await api.post(`/admin/reports/${r.id}/delete-content`);
      // Refresh in case multiple reports about same target got resolved
      await load();
    } catch (e: any) {
      await alertDialog("Failed", e?.message || "Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  const openTarget = (r: AdminReport) => {
    if (r.target_missing) return;
    if (r.target_type === "video") router.push(`/video/${r.target_id}`);
    else router.push(`/user/${r.target_id}`);
  };

  if (!user?.is_founder) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={48} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>Founder access only</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="admin-reports-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Reports</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.filterRow}>
        {(["open", "resolved", "dismissed", "all"] as StatusFilter[]).map((s) => (
          <Pressable
            key={s}
            testID={`admin-reports-filter-${s}`}
            onPress={() => setFilter(s)}
            style={[styles.filterChip, filter === s && styles.filterChipActive]}
          >
            <Text
              style={[
                styles.filterText,
                filter === s && styles.filterTextActive,
              ]}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="shield-checkmark" size={56} color={colors.brand} />
          <Text style={styles.emptyTitle}>
            {filter === "open" ? "No open reports" : "Nothing here"}
          </Text>
          <Text style={styles.emptySub}>
            {filter === "open"
              ? "Reports filed by community members will appear here."
              : "Switch the filter above to see other reports."}
          </Text>
        </View>
      ) : (
        <FlatList
          testID="admin-reports-list"
          data={items}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingVertical: spacing.md }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          renderItem={({ item }) => (
            <View style={styles.card} testID={`admin-report-${item.id}`}>
              <Pressable onPress={() => openTarget(item)} style={styles.cardHeader}>
                {item.target_type === "video" && item.video_thumbnail_url ? (
                  <Image
                    source={{ uri: `${API_BASE}${item.video_thumbnail_url}` }}
                    style={styles.thumb}
                    contentFit="cover"
                  />
                ) : (
                  <View style={[styles.thumb, styles.thumbFallback]}>
                    <Ionicons
                      name={
                        item.target_type === "video"
                          ? "videocam"
                          : "person-circle"
                      }
                      size={28}
                      color={colors.onSurfaceTertiary}
                    />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <View style={styles.typeRow}>
                    <Text style={styles.typeBadge}>
                      {item.target_type === "video" ? "Video" : "User"}
                    </Text>
                    {item.target_missing ? (
                      <Text style={styles.missingBadge}>· already deleted</Text>
                    ) : null}
                    <View style={{ flex: 1 }} />
                    <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                  </View>
                  <Text style={styles.title} numberOfLines={2}>
                    {item.target_type === "video"
                      ? item.video_title || "(no title)"
                      : item.user_display_name ||
                        (item.user_username
                          ? `@${item.user_username}`
                          : "(unknown user)")}
                  </Text>
                  {item.target_type === "video" && item.video_creator_name ? (
                    <Text style={styles.subtitle}>
                      by {item.video_creator_name}
                    </Text>
                  ) : null}
                </View>
              </Pressable>

              <View style={styles.reasonBox}>
                <Ionicons name="flag" size={14} color="#D97706" />
                <Text style={styles.reasonText}>{item.reason || "(no reason given)"}</Text>
              </View>

              <Text style={styles.reporter}>
                Reported by{" "}
                <Text style={styles.reporterName}>
                  {item.reporter_name || "Unknown"}
                </Text>
                {item.reporter_username ? (
                  <Text style={styles.reporterHandle}>
                    {" "}@{item.reporter_username}
                  </Text>
                ) : null}
              </Text>

              {(item.target_warnings_count && item.target_warnings_count > 0) ||
              item.target_is_banned ? (
                <View style={styles.modPills}>
                  {item.target_warnings_count && item.target_warnings_count > 0 ? (
                    <View
                      style={[styles.modPill, styles.modPillWarn]}
                      testID={`admin-report-${item.id}-warnings`}
                    >
                      <Ionicons name="warning" size={11} color="#78350F" />
                      <Text style={styles.modPillWarnText}>
                        {item.target_warnings_count} warning
                        {item.target_warnings_count === 1 ? "" : "s"}
                      </Text>
                    </View>
                  ) : null}
                  {item.target_is_banned ? (
                    <View
                      style={[styles.modPill, styles.modPillBan]}
                      testID={`admin-report-${item.id}-banned`}
                    >
                      <Ionicons
                        name={
                          item.target_ban_type === "permanent"
                            ? "hand-left"
                            : "time"
                        }
                        size={11}
                        color="#fff"
                      />
                      <Text style={styles.modPillBanText}>
                        {item.target_ban_type === "permanent"
                          ? "Banned"
                          : `Suspended${
                              item.target_banned_until
                                ? ` until ${new Date(
                                    item.target_banned_until
                                  ).toLocaleDateString()}`
                                : ""
                            }`}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {item.status !== "open" ? (
                <View
                  style={[
                    styles.statusBadge,
                    item.status === "resolved"
                      ? styles.statusResolved
                      : styles.statusDismissed,
                  ]}
                >
                  <Ionicons
                    name={
                      item.status === "resolved"
                        ? "checkmark-circle"
                        : "close-circle"
                    }
                    size={14}
                    color="#1A1A1A"
                  />
                  <Text style={styles.statusText}>
                    {item.status === "resolved" ? "Resolved" : "Dismissed"}
                  </Text>
                </View>
              ) : (
                <View style={styles.actionsRow}>
                  <Pressable
                    testID={`admin-report-${item.id}-dismiss`}
                    disabled={busyId === item.id}
                    style={[styles.btn, styles.btnSecondary]}
                    onPress={() => dismiss(item)}
                  >
                    <Ionicons name="close" size={16} color={colors.onSurface} />
                    <Text style={styles.btnSecondaryText}>Dismiss</Text>
                  </Pressable>
                  <Pressable
                    testID={`admin-report-${item.id}-open`}
                    disabled={busyId === item.id || !!item.target_missing}
                    style={[
                      styles.btn,
                      styles.btnSecondary,
                      item.target_missing && { opacity: 0.4 },
                    ]}
                    onPress={() => openTarget(item)}
                  >
                    <Ionicons
                      name="open-outline"
                      size={16}
                      color={colors.onSurface}
                    />
                    <Text style={styles.btnSecondaryText}>
                      {item.target_type === "video" ? "View video" : "View user"}
                    </Text>
                  </Pressable>
                  <Pressable
                    testID={`admin-report-${item.id}-warn`}
                    disabled={busyId === item.id}
                    style={[styles.btn, styles.btnWarn]}
                    onPress={() => warn(item)}
                  >
                    <Ionicons name="warning" size={16} color="#78350F" />
                    <Text style={styles.btnWarnText}>Warn</Text>
                  </Pressable>
                  <Pressable
                    testID={`admin-report-${item.id}-suspend-7`}
                    disabled={busyId === item.id}
                    style={[styles.btn, styles.btnSuspend]}
                    onPress={() => suspend(item, 7)}
                  >
                    <Ionicons name="time" size={16} color="#fff" />
                    <Text style={styles.btnDangerText}>Suspend 7d</Text>
                  </Pressable>
                  <Pressable
                    testID={`admin-report-${item.id}-suspend-30`}
                    disabled={busyId === item.id}
                    style={[styles.btn, styles.btnSuspend]}
                    onPress={() => suspend(item, 30)}
                  >
                    <Ionicons name="time" size={16} color="#fff" />
                    <Text style={styles.btnDangerText}>Suspend 30d</Text>
                  </Pressable>
                  <Pressable
                    testID={`admin-report-${item.id}-ban`}
                    disabled={busyId === item.id}
                    style={[styles.btn, styles.btnDanger]}
                    onPress={() => ban(item)}
                  >
                    <Ionicons name="hand-left" size={16} color="#fff" />
                    <Text style={styles.btnDangerText}>Permanent ban</Text>
                  </Pressable>
                  {item.target_type === "video" ? (
                    <Pressable
                      testID={`admin-report-${item.id}-delete`}
                      disabled={busyId === item.id || !!item.target_missing}
                      style={[
                        styles.btn,
                        styles.btnDanger,
                        (busyId === item.id || item.target_missing) && {
                          opacity: 0.6,
                        },
                      ]}
                      onPress={() => deleteContent(item)}
                    >
                      {busyId === item.id ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <Ionicons name="trash" size={16} color="#fff" />
                      )}
                      <Text style={styles.btnDangerText}>Delete video</Text>
                    </Pressable>
                  ) : null}
                </View>
              )}
            </View>
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
  filterRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  filterText: { color: colors.onSurface, fontSize: 12, fontWeight: "700" },
  filterTextActive: { color: colors.onBrand },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: {
    color: colors.onSurface,
    fontSize: text.lg,
    fontWeight: "700",
    marginTop: spacing.md,
  },
  emptySub: {
    color: colors.onSurfaceSecondary,
    fontSize: text.base,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  card: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  cardHeader: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  thumb: { width: 70, height: 70, borderRadius: radius.md, backgroundColor: colors.divider },
  thumbFallback: { alignItems: "center", justifyContent: "center" },
  typeRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  typeBadge: {
    backgroundColor: colors.brand,
    color: colors.onBrand,
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  missingBadge: { color: colors.onSurfaceTertiary, fontSize: 11 },
  time: { color: colors.onSurfaceTertiary, fontSize: 11 },
  title: { color: colors.onSurface, fontSize: text.base, fontWeight: "700", marginTop: 2 },
  subtitle: { color: colors.onSurfaceSecondary, fontSize: text.sm },
  reasonBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    backgroundColor: "#FEF3C7",
    padding: spacing.sm,
    borderRadius: radius.md,
  },
  reasonText: { color: "#78350F", fontSize: text.sm, flex: 1, lineHeight: 18 },
  reporter: { color: colors.onSurfaceSecondary, fontSize: text.sm },
  reporterName: { color: colors.onSurface, fontWeight: "700" },
  reporterHandle: { color: colors.brand, fontWeight: "700" },
  actionsRow: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  btnSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnSecondaryText: { color: colors.onSurface, fontWeight: "700", fontSize: 13 },
  btnDanger: { backgroundColor: colors.error },
  btnDangerText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  btnWarn: { backgroundColor: "#FEF3C7", borderWidth: 1, borderColor: "#FCD34D" },
  btnWarnText: { color: "#78350F", fontWeight: "800", fontSize: 13 },
  btnSuspend: { backgroundColor: "#D97706" },
  modPills: { flexDirection: "row", gap: spacing.xs, flexWrap: "wrap" },
  modPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  modPillWarn: { backgroundColor: "#FEF3C7", borderWidth: 1, borderColor: "#FCD34D" },
  modPillWarnText: { color: "#78350F", fontSize: 11, fontWeight: "800" },
  modPillBan: { backgroundColor: colors.error },
  modPillBanText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  statusBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  statusResolved: { backgroundColor: "#A7F3D0" },
  statusDismissed: { backgroundColor: "#E5E7EB" },
  statusText: { color: "#1A1A1A", fontSize: 11, fontWeight: "800" },
});
