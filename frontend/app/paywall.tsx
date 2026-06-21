import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { isIapAvailable, loadPurchases, RC_ENTITLEMENT, RC_MONTHLY_PKG_ID } from "@/src/lib/iap";
import { colors, radius, spacing, text } from "@/src/theme";

const PAYWALL_IMG =
  "https://images.pexels.com/photos/22863010/pexels-photo-22863010.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940";

export default function Paywall() {
  const router = useRouter();
  const { refresh } = useAuth();
  const iapOk = useMemo(() => isIapAvailable(), []);

  const [pkg, setPkg] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Free-trial offer details read from the store product (configured in App Store
  // Connect / Google Play). `trialLabel` is e.g. "7-day"; empty when no trial.
  const [trialLabel, setTrialLabel] = useState<string>("");
  const [trialEligible, setTrialEligible] = useState<boolean>(true);
  // Tracks whether the store products are still loading so the Subscribe button
  // never dead-ends with a "Store not ready" error (App Store Guideline 2.1(b)).
  const [offersLoading, setOffersLoading] = useState<boolean>(iapOk);
  const [offersUnavailable, setOffersUnavailable] = useState<boolean>(false);

  /**
   * Loads the monthly package from RevenueCat with retries + backoff. Falls back
   * across the current offering, any offering, and the first available package so
   * a missing "current" offering in the RC dashboard doesn't break the paywall.
   * Returns the package (or null) and also stores it in state for the UI.
   */
  const loadOfferings = useCallback(async (): Promise<any | null> => {
    if (!iapOk) {
      setOffersLoading(false);
      return null;
    }
    const Purchases = loadPurchases();
    if (!Purchases) {
      setOffersLoading(false);
      return null;
    }
    setOffersLoading(true);
    setOffersUnavailable(false);

    const pickMonthly = (offerings: any): any | null => {
      const current = offerings?.current;
      const allPkgs: any[] = Object.values(offerings?.all ?? {}).flatMap(
        (o: any) => o?.availablePackages ?? []
      );
      return (
        current?.monthly ||
        current?.availablePackages?.find((p: any) => p.identifier === RC_MONTHLY_PKG_ID) ||
        current?.availablePackages?.[0] ||
        allPkgs.find((p: any) => p?.identifier === RC_MONTHLY_PKG_ID) ||
        allPkgs[0] ||
        null
      );
    };

    let monthly: any | null = null;
    for (let i = 0; i < 4; i++) {
      try {
        const offerings = await Purchases.getOfferings();
        monthly = pickMonthly(offerings);
        if (monthly) break;
      } catch (e: any) {
        console.warn("getOfferings failed", e?.message);
      }
      if (i < 3) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }

    if (monthly) {
      setPkg(monthly);

      // A configured free trial shows up as an intro offer with price 0.
      const intro = monthly.product?.introPrice;
      if (intro && intro.price === 0 && intro.periodNumberOfUnits > 0) {
        const unit = String(intro.periodUnit || "day").toLowerCase();
        setTrialLabel(`${intro.periodNumberOfUnits}-${unit}`);
        try {
          if (Platform.OS === "ios" && Purchases.checkTrialOrIntroductoryPriceEligibility) {
            const id = monthly.product?.identifier;
            const map = await Purchases.checkTrialOrIntroductoryPriceEligibility([id]);
            const status = map?.[id]?.status;
            // 1 === INELIGIBLE; treat anything else (eligible/unknown) as eligible.
            setTrialEligible(status !== 1);
          }
        } catch {
          setTrialEligible(true);
        }
      }
      setOffersUnavailable(false);
    } else {
      setOffersUnavailable(true);
    }
    setOffersLoading(false);
    return monthly;
  }, [iapOk]);

  useEffect(() => {
    void loadOfferings();
  }, [loadOfferings]);

  const showTrial = !!trialLabel && trialEligible;

  const subscribe = async () => {
    setErr(null);
    setInfo(null);
    if (!iapOk) {
      setErr("Open WeClips on your phone to subscribe.");
      return;
    }
    const Purchases = loadPurchases();
    if (!Purchases) {
      setErr("Open WeClips on your phone to subscribe.");
      return;
    }
    // If offerings weren't ready yet (e.g. slow StoreKit init during review),
    // try to (re)load them now instead of dead-ending with a "Store not ready".
    let purchasePkg = pkg;
    if (!purchasePkg) {
      purchasePkg = await loadOfferings();
    }
    if (!purchasePkg) {
      setErr("Subscriptions are temporarily unavailable. Please try again in a moment.");
      return;
    }
    setLoading(true);
    try {
      const { customerInfo } = await Purchases.purchasePackage(purchasePkg);
      const active = !!customerInfo?.entitlements?.active?.[RC_ENTITLEMENT];
      if (active) {
        try {
          await api.post("/subscription/sync");
        } catch {}
        await refresh();
        setInfo(showTrial ? "Your free trial is active!" : "You're in! Membership activated.");
        setTimeout(() => router.back(), 800);
      } else {
        setErr("Purchase didn't unlock membership. Try Restore.");
      }
    } catch (e: any) {
      if (!e?.userCancelled) setErr(e?.message ?? "Purchase failed");
    } finally {
      setLoading(false);
    }
  };

  const restore = async () => {
    setErr(null);
    setInfo(null);
    if (!iapOk) {
      setErr("Open WeClips on your phone to restore.");
      return;
    }
    const Purchases = loadPurchases();
    if (!Purchases) return;
    setLoading(true);
    try {
      const customerInfo = await Purchases.restorePurchases();
      const active = !!customerInfo?.entitlements?.active?.[RC_ENTITLEMENT];
      if (active) {
        try {
          await api.post("/subscription/sync");
        } catch {}
        await refresh();
        setInfo("Subscription restored.");
        setTimeout(() => router.back(), 800);
      } else {
        setErr("No active subscription found for this account.");
      }
    } catch (e: any) {
      setErr(e?.message ?? "Restore failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <Image source={{ uri: PAYWALL_IMG }} style={styles.bg} contentFit="cover" />
      <LinearGradient
        colors={["rgba(255,255,255,0.35)", "rgba(255,255,255,0.92)", "#FFFFFF"]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFillObject}
      />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <Pressable
          testID="paywall-close-button"
          onPress={() => router.back()}
          style={styles.close}
          hitSlop={10}
        >
          <Ionicons name="close" size={24} color={colors.onSurface} />
        </Pressable>

        <View style={styles.content}>
          <Text style={styles.kicker}>WECLIPS MEMBERSHIP</Text>
          <Text style={styles.headline} testID="paywall-headline">
            Become a member
          </Text>

          {showTrial ? (
            <View style={styles.trialBadge} testID="paywall-trial-badge">
              <Ionicons name="gift-outline" size={16} color={colors.brand} />
              <Text style={styles.trialBadgeText}>
                {trialLabel} free trial included
              </Text>
            </View>
          ) : null}

          <View style={styles.bullets}>
            <Bullet text="Zero ads — ever." />
            <Bullet text="100% human-made. No AI." />
            <Bullet text="Family-friendly." />
          </View>
        </View>

        <View style={styles.cta}>
          {Platform.OS === "web" ? (
            <>
              <View style={styles.comingSoon} testID="paywall-web-coming-soon">
                <Ionicons name="phone-portrait-outline" size={22} color={colors.brand} />
                <Text style={styles.comingSoonText}>
                  Payments through this website coming soon! Please subscribe on your
                  mobile device and then come back.
                </Text>
              </View>
              <Pressable
                testID="paywall-web-close-button"
                onPress={() => router.back()}
                style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.primaryText}>Got it</Text>
              </Pressable>
            </>
          ) : (
            <>
              {err ? (
                <Text style={styles.error} testID="paywall-error">
                  {err}
                </Text>
              ) : null}
              {info ? (
                <Text style={styles.info} testID="paywall-info">
                  {info}
                </Text>
              ) : null}

              <Pressable
                testID="paywall-subscribe-button"
                onPress={subscribe}
                disabled={loading || offersLoading}
                style={({ pressed }) => [
                  styles.primary,
                  (pressed || loading || offersLoading) && { opacity: 0.85 },
                ]}
              >
                {loading || offersLoading ? (
                  <ActivityIndicator color={colors.onBrand} />
                ) : (
                  <Text style={styles.primaryText}>
                    {showTrial ? `Start ${trialLabel} free trial` : "Subscribe"}
                  </Text>
                )}
              </Pressable>

              {offersUnavailable && !offersLoading ? (
                <Pressable
                  testID="paywall-retry-button"
                  onPress={() => loadOfferings()}
                  hitSlop={8}
                  style={styles.restore}
                >
                  <Text style={styles.restoreText}>Tap to retry loading plans</Text>
                </Pressable>
              ) : null}

              <Pressable testID="paywall-restore-button" onPress={restore} hitSlop={8} style={styles.restore}>
                <Text style={styles.restoreText}>Restore purchases</Text>
              </Pressable>
            </>
          )}

          <Text style={styles.legal}>
            {showTrial
              ? `Free for ${trialLabel}, then a recurring auto-renewing subscription. Cancel anytime in your store account before the trial ends.`
              : "Auto-renews. Cancel anytime in your store account."}
          </Text>
          <View style={styles.legalLinks}>
            <Pressable
              testID="paywall-terms-link"
              onPress={() => router.push({ pathname: "/legal", params: { section: "terms" } })}
              hitSlop={8}
            >
              <Text style={styles.legalLink}>Terms of Use</Text>
            </Pressable>
            <Text style={styles.legalDot}>·</Text>
            <Pressable
              testID="paywall-privacy-link"
              onPress={() => router.push({ pathname: "/legal", params: { section: "privacy" } })}
              hitSlop={8}
            >
              <Text style={styles.legalLink}>Privacy Policy</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const Bullet: React.FC<{ text: string }> = ({ text }) => (
  <View style={styles.bullet}>
    <Ionicons name="checkmark-circle" size={20} color={colors.brand} />
    <Text style={styles.bulletText}>{text}</Text>
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  bg: { ...(StyleSheet.absoluteFillObject as any) },
  safe: { flex: 1, justifyContent: "space-between", paddingHorizontal: spacing.lg },
  close: { alignSelf: "flex-end", padding: spacing.sm, marginTop: spacing.sm },
  content: { flex: 1, justifyContent: "center" },
  kicker: { color: colors.brand, fontWeight: "900", letterSpacing: 2, fontSize: text.sm, marginBottom: spacing.sm },
  headline: { color: colors.onSurface, fontSize: 44, fontWeight: "900", lineHeight: 48 },
  headlineSmall: { fontSize: 18, fontWeight: "700", color: colors.onSurfaceSecondary },
  bullets: { gap: spacing.md, marginTop: spacing.xl },
  trialBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    alignSelf: "flex-start",
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  trialBadgeText: { color: colors.onSurface, fontSize: text.sm, fontWeight: "800" },
  bullet: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  bulletText: { color: colors.onSurface, fontSize: text.base, fontWeight: "600" },
  cta: { paddingBottom: spacing.md, gap: spacing.sm },
  primary: {
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    paddingVertical: spacing.lg,
    alignItems: "center",
  },
  primaryText: { color: colors.onBrand, fontWeight: "900", fontSize: text.base, letterSpacing: 0.3 },
  restore: { paddingVertical: spacing.sm, alignItems: "center" },
  comingSoon: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  comingSoonText: { flex: 1, color: colors.onSurface, fontSize: text.sm, fontWeight: "700", lineHeight: 20 },
  restoreText: { color: colors.onSurfaceSecondary, fontWeight: "700", fontSize: text.sm },
  error: { color: colors.error, backgroundColor: colors.errorBg, padding: spacing.md, borderRadius: radius.sm },
  info: { color: colors.onBrand, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.sm },
  legal: { color: colors.onSurfaceTertiary, fontSize: 11, marginTop: spacing.xs, textAlign: "center" },
  legalLinks: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  legalLink: { color: colors.onSurfaceSecondary, fontSize: 11, fontWeight: "700", textDecorationLine: "underline" },
  legalDot: { color: colors.onSurfaceTertiary, fontSize: 11 },
});
