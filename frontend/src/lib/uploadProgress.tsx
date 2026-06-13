import React, { createContext, useContext, useState } from "react";
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, text } from "@/src/theme";

export type UploadStatus = {
  staging: boolean;
  pct: number;
  staged: boolean;
} | null;

type Ctx = {
  status: UploadStatus;
  setStatus: (s: UploadStatus) => void;
};

const UploadProgressContext = createContext<Ctx | undefined>(undefined);

export function UploadProgressProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<UploadStatus>(null);
  return (
    <UploadProgressContext.Provider value={{ status, setStatus }}>
      {children}
    </UploadProgressContext.Provider>
  );
}

export function useUploadProgress(): Ctx {
  const ctx = useContext(UploadProgressContext);
  if (!ctx) throw new Error("useUploadProgress must be used within UploadProgressProvider");
  return ctx;
}

// Floating pill shown on every screen *except* the Upload tab while a background
// upload is in flight (or finished and waiting to be published). Tapping it
// returns the user to the Upload tab to finish publishing.
export function UploadPill() {
  const { status } = useUploadProgress();
  const router = useRouter();
  const pathname = usePathname();

  if (!status) return null;
  // The Upload screen renders its own progress card — don't double up there.
  if (pathname?.includes("upload")) return null;

  const done = status.staged && !status.staging;

  return (
    <Pressable
      testID="upload-floating-pill"
      onPress={() => router.push("/(tabs)/upload")}
      style={styles.pill}
    >
      {done ? (
        <Ionicons name="checkmark-circle" size={20} color={colors.onBrand} />
      ) : (
        <ActivityIndicator size="small" color={colors.onBrand} />
      )}
      <Text style={styles.pillText} numberOfLines={1}>
        {done ? "Uploaded — tap to publish" : `Uploading your video… ${status.pct}%`}
      </Text>
      <Ionicons name="chevron-forward" size={16} color={colors.onBrand} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: 84,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  pillText: { flex: 1, color: colors.onBrand, fontSize: text.sm, fontWeight: "800" },
});
