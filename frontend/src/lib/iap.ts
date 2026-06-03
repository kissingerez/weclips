import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Detects whether native in-app purchases (RevenueCat / StoreKit / Play Billing)
 * are usable in the current environment.
 *
 *   - Web: no IAP available.
 *   - Expo Go: native modules aren't bundled, so IAP is not available.
 *   - Custom dev build / production build: IAP available.
 */
export function isIapAvailable(): boolean {
  if (Platform.OS === "web") return false;
  // appOwnership === "expo" means Expo Go; "standalone" or "guest"/undefined means dev/prod build.
  if (Constants.appOwnership === "expo") return false;
  return true;
}

export const RC_IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY || "";
export const RC_ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY || "";
export const RC_ENTITLEMENT = process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID || "premium";
export const RC_MONTHLY_PKG_ID = "$rc_monthly"; // RevenueCat's default monthly package id

/** Safely load the react-native-purchases module only when IAP is available. */
export function loadPurchases(): any | null {
  if (!isIapAvailable()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-purchases");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}
