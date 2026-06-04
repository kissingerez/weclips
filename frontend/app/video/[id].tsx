import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { Ionicons } from "@expo/vector-icons";
import { api, API_BASE, ApiError } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { tokenStorage } from "@/src/lib/tokenStorage";
import { colors, radius, spacing, text } from "@/src/theme";

type VideoDetail = {
  id: string;
  title: string;
  description: string;
  creator_id: string;
  creator_name: string;
  creator_username?: string | null;
  views: number;
  likes: number;
  created_at: string;
};
type Comment = {
  id: string;
  user_id: string;
  user_name: string;
  text: string;
  likes?: number;
  liked?: boolean;
  created_at: string;
};

export default function VideoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(0);
  const [newComment, setNewComment] = useState("");
  const [streamUrl, setStreamUrl] = useState<string>("");
  const [following, setFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const videoRef = useRef<any>(null);

  // Resolve a stream URL for the player:
  //  - For R2-backed videos this is a presigned Cloudflare URL with Range support.
  //  - For legacy disk videos the backend returns a relative path; we append our JWT.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!id) return;
      try {
        const tok = await tokenStorage.get();
        const resp = await api.get<{ stream_url: string; legacy?: boolean }>(
          `/videos/${id}/stream-url`
        );
        if (cancelled) return;
        let url = resp.stream_url;
        if (resp.legacy && tok) {
          const sep = url.includes("?") ? "&" : "?";
          url = `${url}${sep}token=${encodeURIComponent(tok)}`;
          if (url.startsWith("/")) url = `${API_BASE.replace(/\/api$/, "")}${url}`;
        }
        setStreamUrl(url);
      } catch (e: any) {
        if (e instanceof ApiError && e.status === 402) {
          router.replace("/paywall");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  const player = useVideoPlayer(streamUrl || null, (p) => {
    p.loop = false;
    if (streamUrl) p.play();
  });

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    // Load video metadata and comments independently so a failure in one
    // does not prevent the other from rendering.
    try {
      const v = await api.get<VideoDetail>(`/videos/${id}`);
      setVideo(v);
      setLikes(v.likes);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 402) {
        router.replace("/paywall");
        return;
      }
      setVideo(null);
    } finally {
      setLoading(false);
    }
    try {
      const cs = await api.get<Comment[]>(`/videos/${id}/comments`);
      setComments(cs);
    } catch {
      setComments([]);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleLike = async () => {
    if (!user) return router.push("/(auth)/login");
    try {
      const r = await api.post<{ liked: boolean; likes: number }>(`/videos/${id}/like`);
      setLiked(r.liked);
      setLikes(r.likes);
    } catch {}
  };

  const postComment = async () => {
    if (!user) return router.push("/(auth)/login");
    if (!newComment.trim()) return;
    try {
      const c = await api.post<Comment>(`/videos/${id}/comments`, { text: newComment.trim() });
      setComments([c, ...comments]);
      setNewComment("");
    } catch {}
  };

  const deleteComment = async (commentId: string) => {
    const prev = comments;
    setComments(comments.filter((c) => c.id !== commentId));
    try {
      await api.del(`/videos/${id}/comments/${commentId}`);
    } catch (e) {
      // Revert on failure
      setComments(prev);
    }
  };

  // Load follow status when video metadata is available
  useEffect(() => {
    if (!video?.creator_id || !user || video.creator_id === user.id) return;
    (async () => {
      try {
        const r = await api.get<{ following: boolean; followers: number }>(
          `/users/${video.creator_id}/follow-status`
        );
        setFollowing(r.following);
        setFollowerCount(r.followers);
      } catch {}
    })();
  }, [video?.creator_id, user]);

  const toggleFollow = async () => {
    if (!user || !video) return;
    try {
      if (following) {
        const r = await api.del<{ following: boolean; followers: number }>(
          `/users/${video.creator_id}/follow`
        );
        setFollowing(r.following);
        setFollowerCount(r.followers);
      } else {
        const r = await api.post<{ following: boolean; followers: number }>(
          `/users/${video.creator_id}/follow`
        );
        setFollowing(r.following);
        setFollowerCount(r.followers);
      }
    } catch {}
  };

  const goFullscreen = () => {
    try {
      videoRef.current?.enterFullscreen?.();
    } catch {}
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!video) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <Text style={styles.errText}>Video not found</Text>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.playerWrap}>
          <VideoView
            testID="video-player"
            ref={videoRef}
            style={styles.player}
            player={player}
            fullscreenOptions={{ enable: true }}
            allowsPictureInPicture
            nativeControls
            contentFit="contain"
          />
          <Pressable testID="video-back-button" onPress={() => router.back()} style={styles.backIcon} hitSlop={10}>
            <Ionicons name="arrow-back" size={26} color="#ffffff" />
          </Pressable>
          <Pressable
            testID="video-fullscreen-button"
            onPress={() => {
              try {
                if (videoRef.current?.enterFullscreen) {
                  videoRef.current.enterFullscreen();
                } else if (typeof document !== "undefined") {
                  // Web fallback — request fullscreen on the player element
                  const el: any = document.querySelector('[data-testid="video-player"]') || document.querySelector("video");
                  if (el?.requestFullscreen) el.requestFullscreen();
                  else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen();
                }
              } catch {}
            }}
            style={styles.fsIcon}
            hitSlop={10}
          >
            <Ionicons name="expand" size={24} color="#ffffff" />
          </Pressable>
        </View>

        <FlatList
          ListHeaderComponent={
            <View style={styles.meta}>
              <Text style={styles.title} testID="video-title">{video.title}</Text>
              <Text style={styles.sub}>
                {video.creator_username ? `@${video.creator_username}` : video.creator_name} · {video.views} {video.views === 1 ? "view" : "views"}
              </Text>

              {user && video.creator_id !== user.id ? (
                <Pressable testID="video-follow-button" onPress={toggleFollow} style={[styles.followBtn, following && styles.followingBtn]}>
                  <Ionicons name={following ? "checkmark" : "person-add"} size={14} color={following ? colors.onSurface : colors.onBrand} />
                  <Text style={[styles.followText, following && styles.followingText]}>
                    {following ? "Following" : "Follow"}
                  </Text>
                  {followerCount > 0 ? <Text style={[styles.followCount, following && styles.followingText]}>· {followerCount}</Text> : null}
                </Pressable>
              ) : null}

              <View style={styles.actionRow}>
                <Pressable testID="video-like-button" onPress={toggleLike} style={styles.actionBtn}>
                  <Ionicons name={liked ? "heart" : "heart-outline"} size={20} color={liked ? colors.brand : colors.onSurface} />
                  <Text style={styles.actionLabel}>{likes}</Text>
                </Pressable>
                {user?.is_founder && video.creator_id !== user.id ? (
                  <Pressable
                    testID="video-founder-delete"
                    onPress={() => {
                      if (typeof window !== "undefined" && window.confirm) {
                        if (
                          !window.confirm(
                            `FOUNDER ACTION\n\nDelete "${video.title}" from WeClips?\n\nThis cannot be undone.`
                          )
                        )
                          return;
                      }
                      (async () => {
                        try {
                          await api.del(`/videos/${video.id}`);
                          router.back();
                        } catch (e: any) {
                          // best-effort feedback
                          alert(e?.message || "Delete failed");
                        }
                      })();
                    }}
                    style={styles.founderDeleteBtn}
                  >
                    <Ionicons name="shield" size={14} color={colors.onBrand} />
                    <Text style={styles.founderDeleteText}>Founder · Delete</Text>
                  </Pressable>
                ) : null}
              </View>

              {video.description ? (
                <Text style={styles.desc}>{video.description}</Text>
              ) : null}

              <View style={styles.commentInputRow}>
                <TextInput
                  testID="video-comment-input"
                  value={newComment}
                  onChangeText={setNewComment}
                  placeholder="Add a comment..."
                  placeholderTextColor={colors.onSurfaceTertiary}
                  style={styles.commentInput}
                />
                <Pressable testID="video-comment-submit" onPress={postComment} style={styles.commentBtn}>
                  <Ionicons name="send" size={18} color={colors.onBrand} />
                </Pressable>
              </View>
            </View>
          }
          data={comments}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => {
            const canDelete = !!user && (item.user_id === user.id || video?.creator_id === user.id || !!user.is_founder);
            return (
              <View style={styles.commentItem}>
                <View style={styles.commentHead}>
                  <Text style={styles.commentAuthor}>{item.user_name}</Text>
                  {canDelete && (
                    <Pressable
                      testID={`comment-delete-${item.id}`}
                      onPress={() => deleteComment(item.id)}
                      hitSlop={10}
                      style={styles.commentDelete}
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.onSurfaceSecondary} />
                    </Pressable>
                  )}
                </View>
                <Text style={styles.commentText}>{item.text}</Text>
                <Pressable
                  testID={`comment-like-${item.id}`}
                  onPress={async () => {
                    try {
                      const r = await api.post<{ liked: boolean; likes: number }>(
                        `/videos/${id}/comments/${item.id}/like`
                      );
                      setComments((prev) =>
                        prev.map((c) =>
                          c.id === item.id
                            ? { ...c, liked: r.liked, likes: r.likes }
                            : c
                        )
                      );
                    } catch {}
                  }}
                  style={styles.commentLikeBtn}
                  hitSlop={8}
                >
                  <Ionicons
                    name={item.liked ? "heart" : "heart-outline"}
                    size={14}
                    color={item.liked ? colors.brand : colors.onSurfaceSecondary}
                  />
                  <Text
                    style={[
                      styles.commentLikeText,
                      item.liked && { color: colors.brand, fontWeight: "800" },
                    ]}
                  >
                    {item.likes ?? 0}
                  </Text>
                </Pressable>
              </View>
            );
          }}
          contentContainerStyle={{ paddingBottom: spacing.xxxl }}
          ListEmptyComponent={
            <Text style={styles.noComments}>No comments yet. Be the first.</Text>
          }
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  playerWrap: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000" },
  player: { width: "100%", height: "100%" },
  backIcon: { position: "absolute", top: spacing.sm, left: spacing.sm, padding: spacing.sm, backgroundColor: "rgba(0,0,0,0.7)", borderRadius: radius.pill, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  fsIcon: { position: "absolute", top: spacing.sm, right: spacing.sm, padding: spacing.sm, backgroundColor: "rgba(0,0,0,0.7)", borderRadius: radius.pill, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  followBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.brand, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, alignSelf: "flex-start", marginTop: spacing.sm },
  followingBtn: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  followText: { color: colors.onBrand, fontWeight: "700", fontSize: text.sm },
  followingText: { color: colors.onSurface },
  followCount: { color: colors.onBrand, fontSize: text.sm, fontWeight: "600", marginLeft: 4 },
  meta: { padding: spacing.lg },
  title: { color: colors.onSurface, fontSize: text.xl, fontWeight: "800" },
  sub: { color: colors.onSurfaceSecondary, fontSize: text.sm, marginTop: 4 },
  actionRow: { flexDirection: "row", marginTop: spacing.md, gap: spacing.lg },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surfaceSecondary, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  founderDeleteBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FFB300", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill },
  founderDeleteText: { color: "#1A1A1A", fontWeight: "800", fontSize: text.sm },
  actionLabel: { color: colors.onSurface, fontWeight: "700" },
  desc: { color: colors.onSurfaceSecondary, marginTop: spacing.md, fontSize: text.base, lineHeight: 20 },
  commentInputRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  commentInput: { flex: 1, backgroundColor: colors.surfaceSecondary, color: colors.onSurface, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border },
  commentBtn: { backgroundColor: colors.brand, paddingHorizontal: spacing.lg, justifyContent: "center", borderRadius: radius.md },
  commentItem: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.divider },
  commentHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 2 },
  commentAuthor: { color: colors.onSurface, fontWeight: "700" },
  commentDelete: { padding: 4 },
  commentText: { color: colors.onSurfaceSecondary, fontSize: text.base },
  commentLikeBtn: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: spacing.xs, alignSelf: "flex-start", paddingVertical: 2 },
  commentLikeText: { color: colors.onSurfaceSecondary, fontSize: 12, fontWeight: "600" },
  noComments: { color: colors.onSurfaceTertiary, padding: spacing.lg, textAlign: "center" },
  errText: { color: colors.onSurface, fontSize: text.lg, marginBottom: spacing.md },
  backBtn: { backgroundColor: colors.brand, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md },
  backBtnText: { color: colors.onBrand, fontWeight: "700" },
});
