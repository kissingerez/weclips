import React, { useState } from "react";
import { Pressable, Share, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { API_BASE } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { colors, radius, spacing, text } from "@/src/theme";

// Circular creator avatar matching weclips.app. Loads the user's avatar image
// and falls back to a colored initials circle when there's no avatar (404).
const CreatorAvatar: React.FC<{ creatorId?: string; name: string; onPress?: () => void }> = ({
  creatorId,
  name,
  onPress,
}) => {
  const [failed, setFailed] = useState(false);
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const showImage = !!creatorId && !failed;
  return (
    <Pressable onPress={onPress} hitSlop={6} style={styles.avatarWrap}>
      {showImage ? (
        <Image
          source={{ uri: `${API_BASE}/users/${creatorId}/avatar` }}
          style={styles.avatar}
          contentFit="cover"
          transition={120}
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarInitial}>{initial}</Text>
        </View>
      )}
    </Pressable>
  );
};

const SHARE_BASE = (process.env.EXPO_PUBLIC_SHARE_BASE_URL ||
  "https://ad-free-video-12.emergent.host").replace(/\/+$/, "");

// Compact relative time matching the web version (e.g. "22h", "2d", "3w").
function timeAgoShort(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (d < 30) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

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
  duration_sec?: number | null;
  created_at: string;
};

function formatDuration(sec?: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

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
  const durationLabel = formatDuration(video.duration_sec);

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
            <Ionicons name="image-outline" size={42} color={colors.onSurfaceTertiary} />
            <Text style={styles.placeholderText}>No thumbnail</Text>
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
        {durationLabel ? (
          <View style={styles.durationChip} pointerEvents="none">
            <Text style={styles.durationText}>{durationLabel}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.meta}>
        <CreatorAvatar
          creatorId={video.creator_id}
          name={video.creator_name}
          onPress={() => {
            if (video.creator_id) router.push(`/user/${video.creator_id}`);
          }}
        />
        <View style={styles.metaText}>
          <Text style={styles.title} numberOfLines={2}>
            {video.title}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            <Text
              testID={`videocard-creator-${video.id}`}
              style={styles.creatorLink}
              onPress={(e: any) => {
                e?.stopPropagation?.();
                if (video.creator_id) router.push(`/user/${video.creator_id}`);
              }}
            >
              {video.creator_name}
            </Text>
            {video.creator_username ? (
              <Text
                style={styles.creatorHandle}
                onPress={(e: any) => {
                  e?.stopPropagation?.();
                  if (video.creator_id) router.push(`/user/${video.creator_id}`);
                }}
              >
                {` · @${video.creator_username}`}
              </Text>
            ) : null}
          </Text>
          <View style={styles.statsRow}>
            <Ionicons name="eye-outline" size={12} color="#94A3B8" />
            <Text style={styles.stats}>
              {`${video.views} ${video.views === 1 ? "view" : "views"} · ${timeAgoShort(video.created_at)}`}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  card: { marginBottom: spacing.xl, marginHorizontal: spacing.lg },
  thumb: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    overflow: "hidden",
  },
  image: { width: "100%", height: "100%" },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSecondary,
    gap: 6,
  },
  placeholderText: {
    color: colors.onSurfaceTertiary,
    fontSize: text.sm,
    fontWeight: "600",
  },
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
  durationChip: {
    position: "absolute",
    bottom: spacing.sm,
    right: spacing.sm,
    backgroundColor: "rgba(0,0,0,0.78)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  durationText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  meta: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingTop: spacing.md,
  },
  metaText: { flex: 1 },
  avatarWrap: { marginTop: 1 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceSecondary },
  avatarFallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brand,
  },
  avatarInitial: { color: colors.onBrand, fontSize: 16, fontWeight: "800" },
  title: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700", marginBottom: spacing.xs },
  sub: { color: colors.onSurfaceSecondary, fontSize: 12 },
  creatorLink: { color: colors.brand, fontWeight: "500", fontSize: 12 },
  creatorHandle: { color: "#94A3B8", fontWeight: "400", fontSize: 12 },
  statsRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  stats: { color: "#94A3B8", fontSize: 11, fontWeight: "400" },
});
