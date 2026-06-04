import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { API_BASE } from "@/src/lib/api";
import { colors } from "@/src/theme";

type Props = {
  userId?: string | null;
  displayName?: string | null;
  hasAvatar?: boolean;
  size?: number;
  // optional cache buster to force refetch after upload
  version?: number | string;
  uri?: string | null; // explicit override (used by edit preview)
};

export const Avatar: React.FC<Props> = ({
  userId,
  displayName,
  hasAvatar,
  size = 64,
  version,
  uri,
}) => {
  const dim = { width: size, height: size, borderRadius: size / 2 } as const;
  let src: string | null = null;
  if (uri) src = uri;
  else if (hasAvatar && userId) {
    const sep = version ? `?v=${encodeURIComponent(String(version))}` : "";
    src = `${API_BASE}/users/${userId}/avatar${sep}`;
  }
  if (src) {
    return (
      <Image
        source={{ uri: src }}
        style={[styles.img, dim]}
        resizeMode="cover"
      />
    );
  }
  return (
    <View style={[styles.fallback, dim]}>
      <Text style={[styles.letter, { fontSize: Math.round(size * 0.45) }]}>
        {(displayName?.[0] || "?").toUpperCase()}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  img: { backgroundColor: colors.surfaceTertiary },
  fallback: {
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  letter: { color: colors.onBrand, fontWeight: "900" },
});
