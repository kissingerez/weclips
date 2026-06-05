import React from "react";
import { Pressable, Share, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { API_BASE } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { colors, radius, spacing, text } from "@/src/theme";

const SHARE_BASE = (process.env.EXPO_PUBLIC_SHARE_BASE_URL ||
  "https://ad-free-video-12.emergent.host").replace(/\/+$/, "");

export async function shareVideo(videoId: string, title?: string) {
  const url = `${SHARE_BASE}/v/${videoId}`;
  const message = title ? `${title} — Watch on WeClips\n${url}` : url;
  try {
    await Share.share({ message, url, title: title || "WeClips" });
  } catch {}
}

export type VideoCardData = {
  id: string;
  title: string;
  creator_id?: string;
  creator_name: string;
  creator_username?: string | null;
  views: number;
  has_thumbnail: boolean;
  thumbnail_updated_at?: string | null;
  created_at: string;
};

export const VideoCard: React.FC<{ video: VideoCardData; onDeleted?: (id: string) => void }> = ({
  video,
  onDeleted,
}) => {
  const router = useRouter();
  const { user } = useAuth();
  // Always cache-bust the thumbnail URL. Falls back to created_at when the
  // dedicated thumbnail_updated_at is missing (legacy rows).
  const bust = video.thumbnail_updated_at || video.created_at || "";
  const thumb = video.has_thumbnail
    ? `${API_BASE}/videos/${video.id}/thumbnail?v=${encodeURIComponent(bust)}`
    : null;
  const locked = !user?.is_subscribed;
  const showFounderDelete =
    !!user?.is_founder && video.creator_id !== user.id;

  const founderDelete = async () => {
    if (typeof window !== "undefined" && window.confirm) {
      if (
        !window.confirm(
          `FOUNDER MODERATION\n\nDelete "${video.title}" from WeClips?\n\nThis cannot be undone.`
        )
      )
        return;
    }
    try {
      const { api } = await import("@/src/lib/api");
      await api.del(`/videos/${video.id}`);
      onDeleted && onDeleted(video.id);
    } catch (e: any) {
      try { alert(e?.message || "Delete failed"); } catch {}
    }
  };

  return (
    <Pressable
      testID={`video-card-${video.id}`}
      onPress={() => {
        if (locked) {
          router.push("/paywall");
        } else {
          router.push(`/video/${video.id}`);
        }
      }}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.thumb}>
        {thumb ? (
          <Image source={{ uri: thumb }} style={styles.image} contentFit="cover" transition={150} />
        ) : (
          <View style={[styles.image, styles.placeholder]}>
            <Ionicons name="play-circle" size={56} color={colors.brand} />
          </View>
        )}
        {locked && (
          <View style={styles.lockOverlay} pointerEvents="none">
            <View style={styles.lockChip}>
              <Ionicons name="lock-closed" size={14} color={colors.onBrand} />
              <Text style={styles.lockChipText}>Members only</Text>
            </View>
          </View>
        )}
        {showFounderDelete && (
          <Pressable
            testID={`videocard-founder-delete-${video.id}`}
            onPress={(e: any) => {
              e?.stopPropagation && e.stopPropagation();
              founderDelete();
            }}
            style={styles.founderChip}
            hitSlop={8}
          >
            <Ionicons name="shield" size={12} color="#1A1A1A" />
            <Text style={styles.founderChipText}>Delete</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={2}>
          {video.title}
        </Text>
        <Text style={styles.sub}>
          {video.creator_username ? `@${video.creator_username}` : video.creator_name} · {video.views} {video.views === 1 ? "view" : "views"}
        </Text>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  card: { marginBottom: spacing.xl },
  thumb: { width: "100%", aspectRatio: 16 / 9, backgroundColor: colors.surfaceSecondary },
  image: { width: "100%", height: "100%" },
  placeholder: { alignItems: "center", justifyContent: "center" },
  lockOverlay: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
  },
  lockChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  lockChipText: { color: colors.onBrand, fontSize: 11, fontWeight: "800" },
  founderChip: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#FFB300",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  founderChipText: { color: "#1A1A1A", fontSize: 11, fontWeight: "800" },
  meta: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  title: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700", marginBottom: spacing.xs },
  sub: { color: colors.onSurfaceSecondary, fontSize: text.sm },
});
