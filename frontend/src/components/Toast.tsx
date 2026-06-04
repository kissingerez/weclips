import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, text } from "@/src/theme";

type Variant = "success" | "error" | "info";

type Props = {
  message: string | null;
  variant?: Variant;
  onHide?: () => void;
  durationMs?: number;
  testID?: string;
};

/**
 * Bottom-anchored auto-dismissing toast. Pass `message` as null to hide.
 * Sits inside a SafeAreaView; you can use `pointerEvents="box-none"` on the parent.
 */
export const Toast: React.FC<Props> = ({
  message,
  variant = "success",
  onHide,
  durationMs = 2400,
  testID,
}) => {
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    if (!message) return;
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(slide, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(slide, {
          toValue: 20,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start(() => onHide && onHide());
    }, durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs, onHide, fade, slide]);

  if (!message) return null;

  const palette = {
    success: { bg: colors.success, fg: colors.onBrand, icon: "checkmark-circle" as const },
    error: { bg: colors.error, fg: colors.onBrand, icon: "alert-circle" as const },
    info: { bg: colors.brand, fg: colors.onBrand, icon: "information-circle" as const },
  }[variant];

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <Animated.View
        testID={testID}
        style={[
          styles.toast,
          { backgroundColor: palette.bg, opacity: fade, transform: [{ translateY: slide }] },
        ]}
      >
        <Ionicons name={palette.icon} size={18} color={palette.fg} />
        <Text style={[styles.text, { color: palette.fg }]}>{message}</Text>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: spacing.xl,
    alignItems: "center",
    zIndex: 1000,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    maxWidth: "90%",
  },
  text: { fontSize: text.base, fontWeight: "700" },
});

export default Toast;
