import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { VideoCard, VideoCardData } from "@/src/components/VideoCard";
import { api } from "@/src/lib/api";
import { colors, radius, spacing, text } from "@/src/theme";

export default function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<VideoCardData[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  const onSearch = async () => {
    const term = q.trim();
    if (!term) return;
    setLoading(true);
    try {
      const data = await api.get<VideoCardData[]>(`/videos?q=${encodeURIComponent(term)}`);
      setResults(data);
      setSearched(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.searchBox}>
          <Ionicons name="search" color={colors.onSurfaceTertiary} size={18} />
          <TextInput
            testID="search-input"
            placeholder="Search videos, channels..."
            placeholderTextColor={colors.onSurfaceTertiary}
            style={styles.searchInput}
            value={q}
            onChangeText={setQ}
            onSubmitEditing={onSearch}
            returnKeyType="search"
          />
          {q.length > 0 && (
            <Pressable onPress={() => setQ("")} hitSlop={10}>
              <Ionicons name="close-circle" size={18} color={colors.onSurfaceTertiary} />
            </Pressable>
          )}
        </View>
        <Pressable onPress={onSearch} style={styles.goBtn} testID="search-submit">
          <Text style={styles.goText}>{loading ? "..." : "Go"}</Text>
        </Pressable>
      </View>

      {searched && results.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="search-outline" size={56} color={colors.onSurfaceTertiary} />
          <Text style={styles.emptyTitle}>No matches</Text>
          <Text style={styles.emptySub}>Try a different keyword.</Text>
        </View>
      ) : (
        <FlatList
          testID="search-results-list"
          data={results}
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
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: spacing.sm,
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, color: colors.onSurface, fontSize: text.lg, padding: 0 },
  goBtn: { backgroundColor: colors.brand, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md },
  goText: { color: colors.onBrand, fontWeight: "700" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.onSurface, fontSize: text.xl, fontWeight: "700", marginTop: spacing.md },
  emptySub: { color: colors.onSurfaceSecondary, fontSize: text.base, marginTop: spacing.sm },
});
