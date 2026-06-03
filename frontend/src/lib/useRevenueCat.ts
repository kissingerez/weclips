import { useEffect } from "react";
import { Platform } from "react-native";
import { useAuth } from "./auth";
import { isIapAvailable, loadPurchases, RC_IOS_KEY, RC_ANDROID_KEY } from "./iap";

/**
 * Configures RevenueCat once per process, tying the RC `appUserId` to the
 * authenticated JWT user id. No-ops on web / Expo Go.
 */
export function useRevenueCatConfig() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    if (!isIapAvailable()) return;
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
      Purchases.configure({ apiKey, appUserID: user.id });
    } catch (e) {
      console.warn("[RevenueCat] configure failed", e);
    }
  }, [user?.id]);
}
