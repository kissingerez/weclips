export const colors = {
  surface: "#0D0D0D",
  onSurface: "#F2F2F2",
  surfaceSecondary: "#1A1A1A",
  onSurfaceSecondary: "#B3B3B3",
  surfaceTertiary: "#262626",
  onSurfaceTertiary: "#8C8C8C",
  // Brand: baby blue
  brand: "#89CFF0",
  onBrand: "#0A1929", // dark navy for readable text on baby-blue surfaces
  brandTertiary: "#1F4256",
  onBrandTertiary: "#CFE9F7",
  border: "#333333",
  borderStrong: "#4D4D4D",
  divider: "#1A1A1A",
  success: "#2A9D8F",
  warning: "#E9C46A",
  // Errors stay red regardless of brand color
  error: "#E63946",
  errorBg: "#4D1317",
  onError: "#FFD9DB",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  pill: 999,
};

export const text = {
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
};

// Brand wordmark font — distinct from the system UI font
import { Platform } from "react-native";

export const brandFont = {
  fontFamily: Platform.select({
    ios: "Avenir-Black",
    android: "sans-serif-condensed",
    default: "serif",
  }),
  fontStyle: "italic" as const,
};
