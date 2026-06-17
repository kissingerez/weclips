import { Platform } from "react-native";
import type { Me } from "./auth";

/**
 * TEMPORARY: Android in-app purchases can't be exercised during Google Play's
 * 14-day closed-testing review, so Android clients are granted full access until
 * billing is live. Set this to `false` once Android subscriptions work to restore
 * the paywall. The backend mirrors this via the ANDROID_FREE_ACCESS env flag.
 */
export const ANDROID_FREE_ACCESS = true;

/** Whether the current user should have premium (paywall-free) access. */
export function hasPremiumAccess(user?: Me | null): boolean {
  if (user?.is_subscribed) return true;
  return Platform.OS === "android" && ANDROID_FREE_ACCESS;
}
