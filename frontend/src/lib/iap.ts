import Constants from "expo-constants";
import { Linking, Platform } from "react-native";

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

let rcConfigured = false;

/**
 * Configure RevenueCat exactly ONCE per process, anonymously (no appUserID).
 * Identity is attached later via rcLogin(). Safe no-op on web / Expo Go.
 */
export function rcConfigureOnce(): void {
  if (rcConfigured) return;
  const Purchases = loadPurchases();
  if (!Purchases) return;

  const apiKey = Platform.OS === "ios" ? RC_IOS_KEY : RC_ANDROID_KEY;
  if (!apiKey) {
    console.warn(
      "[RevenueCat] No SDK key configured for this platform. Set EXPO_PUBLIC_REVENUECAT_IOS_KEY / EXPO_PUBLIC_REVENUECAT_ANDROID_KEY."
    );
    return;
  }

  try {
    Purchases.setLogLevel?.("WARN");
    Purchases.configure({ apiKey });
    rcConfigured = true;
  } catch (e) {
    console.warn("[RevenueCat] configure failed", e);
  }
}

/**
 * Tie the current RevenueCat session to an authenticated user id so a
 * subscription is strictly bound to that account. No-op on web / Expo Go.
 */
export async function rcLogin(userId: string): Promise<void> {
  if (!userId) return;
  const Purchases = loadPurchases();
  if (!Purchases) return;
  try {
    await Purchases.logIn(userId);
  } catch (e) {
    console.warn("[RevenueCat] logIn failed", e);
  }
}

/**
 * Detach the device from the current user (returns RevenueCat to an anonymous
 * id) so the next account that signs in does not inherit this subscription.
 */
export async function rcLogout(): Promise<void> {
  const Purchases = loadPurchases();
  if (!Purchases) return;
  try {
    await Purchases.logOut();
  } catch (e) {
    console.warn("[RevenueCat] logOut failed", e);
  }
}

/**
 * Restore prior purchases via RevenueCat.
 * Returns true/false if it ran (active entitlement?), or null when IAP isn't
 * available in this environment (e.g. web preview / Expo Go).
 */
export async function rcRestore(): Promise<boolean | null> {
  const Purchases = loadPurchases();
  if (!Purchases) return null;
  const info = await Purchases.restorePurchases();
  return !!info?.entitlements?.active?.[RC_ENTITLEMENT];
}

/**
 * Open the OS-native "Manage subscriptions" screen where the user can cancel.
 * Apps cannot cancel store subscriptions directly — they must deep-link here.
 */
export async function manageSubscriptions(): Promise<void> {
  const Purchases = loadPurchases();
  if (Purchases?.showManageSubscriptions) {
    try {
      await Purchases.showManageSubscriptions();
      return;
    } catch {
      // fall through to store URL
    }
  }
  const url =
    Platform.OS === "android"
      ? "https://play.google.com/store/account/subscriptions"
      : "https://apps.apple.com/account/subscriptions";
  try {
    await Linking.openURL(url);
  } catch {
    // no-op
  }
}
