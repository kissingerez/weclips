import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { API_BASE } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { colors, radius, spacing, text } from "@/src/theme";

export type VideoCardData = {
  id: string;
  title: string;
  creator_name: string;
  creator_username?: string | null;
  views: number;
  has_thumbnail: boolean;
  thumbnail_updated_at?: string | null;
  created_at: string;
};

export const VideoCard: React.FC<{ video: VideoCardData }> = ({ video }) => {
  const router = useRouter();
  const { user } = useAuth();
  // Always cache-bust the thumbnail URL. Falls back to created_at when the
  // dedicated thumbnail_updated_at is missing (legacy rows).
  const bust = video.thumbnail_updated_at || video.created_at || "";
  const thumb = video.has_thumbnail
    ? `${API_BASE}/videos/${video.id}/thumbnail?v=${encodeURIComponent(bust)}`
    : null;
  const locked = !user?.is_subscribed;

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
  meta: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  title: { color: colors.onSurface, fontSize: text.lg, fontWeight: "700", marginBottom: spacing.xs },
  sub: { color: colors.onSurfaceSecondary, fontSize: text.sm },
});
