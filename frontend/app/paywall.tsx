import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { api } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import {
  isIapAvailable,
  loadPurchases,
  RC_ENTITLEMENT,
  RC_MONTHLY_PKG_ID,
} from "@/src/lib/iap";
import { colors, radius, spacing, text } from "@/src/theme";

const PAYWALL_IMG =
  "https://images.pexels.com/photos/22863010/pexels-photo-22863010.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940";

export default function Paywall() {
  const router = useRouter();
  const { refresh } = useAuth();
  const iapOk = useMemo(() => isIapAvailable(), []);

  const [priceLabel, setPriceLabel] = useState<string>("$0.99 / month");
  const [pkg, setPkg] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Load offerings from RevenueCat
  useEffect(() => {
    if (!iapOk) return;
    const Purchases = loadPurchases();
    if (!Purchases) return;
    (async () => {
      try {
        const offerings = await Purchases.getOfferings();
        const current = offerings?.current;
        const monthly =
          current?.monthly ||
          current?.availablePackages?.find((p: any) => p.identifier === RC_MONTHLY_PKG_ID) ||
          current?.availablePackages?.[0];
        if (monthly) {
          setPkg(monthly);
          setPriceLabel(monthly.product?.priceString || "$0.99 / month");
        }
      } catch (e: any) {
        console.warn("getOfferings failed", e?.message);
      }
    })();
  }, [iapOk]);

  const subscribe = async () => {
    setErr(null);
    setInfo(null);
    if (!iapOk) {
      setErr(
        "In-app purchases aren't available in this preview. Build the app via Emergent's Publish flow and run it on a device to subscribe."
      );
      return;
    }
    const Purchases = loadPurchases();
    if (!Purchases || !pkg) {
      setErr("RevenueCat isn't ready yet. Make sure your iOS/Android SDK keys are set.");
      return;
    }
    setLoading(true);
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      const active = !!customerInfo?.entitlements?.active?.[RC_ENTITLEMENT];
      if (active) {
        // Tell backend to sync now; webhook will reconcile shortly.
        try {
          await api.post("/subscription/sync");
        } catch {}
        await refresh();
        setInfo("You're in! Premium activated.");
        setTimeout(() => router.back(), 800);
      } else {
        setErr("Purchase didn't unlock premium. Try Restore Purchases.");
      }
    } catch (e: any) {
      if (e?.userCancelled) {
        // user cancelled the native sheet - silent
      } else {
        setErr(e?.message ?? "Purchase failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const restore = async () => {
    setErr(null);
    setInfo(null);
    if (!iapOk) {
      setErr("Not available in preview. Build & run on a device.");
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

  const previewActivate = async () => {
    // Preview-only fallback (dev mode) so the rest of the app can be tested.
    setErr(null);
    setInfo(null);
    setLoading(true);
    try {
      const r = await api.post<{ is_subscribed: boolean }>("/subscription/dev-activate");
      if (r.is_subscribed) {
        await refresh();
        setInfo("Subscription activated (preview/dev mode).");
        setTimeout(() => router.back(), 800);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Dev activation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <Image source={{ uri: PAYWALL_IMG }} style={styles.bg} contentFit="cover" />
      <LinearGradient
        colors={["rgba(13,13,13,0.6)", "rgba(13,13,13,0.95)", "#0D0D0D"]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFillObject}
      />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <Pressable testID="paywall-close-button" onPress={() => router.back()} style={styles.close} hitSlop={10}>
          <Ionicons name="close" size={26} color={colors.onSurface} />
        </Pressable>

        <View style={styles.content}>
          <Text style={styles.kicker}>GO PREMIUM</Text>
          <Text style={styles.headline} testID="paywall-headline">
            {priceLabel.split("/")[0].trim()}
            <Text style={styles.headlineSmall}>
              {priceLabel.includes("/") ? "/" + priceLabel.split("/").slice(1).join("/") : "/month"}
            </Text>
          </Text>
          <Text style={styles.sub}>Ad-free. No AI content. Unlimited uploads.</Text>

          <View style={styles.bullets}>
            <Bullet text="Zero ads, ever." />
            <Bullet text="100% human-made content (AI banned)." />
            <Bullet text="Upload your own videos." />
            <Bullet text="Billed by Apple / Google. Cancel anytime." />
          </View>

          {!iapOk && (
            <View style={styles.previewBanner} testID="paywall-preview-banner">
              <Ionicons name="information-circle" size={18} color={colors.onBrandTertiary} />
              <Text style={styles.previewText}>
                In-app purchases require a real device build. In this preview you can activate a 30-day
                test subscription below.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.cta}>
          {err ? <Text style={styles.error} testID="paywall-error">{err}</Text> : null}
          {info ? <Text style={styles.info} testID="paywall-info">{info}</Text> : null}

          {iapOk ? (
            <>
              <Pressable
                testID="paywall-subscribe-button"
                onPress={subscribe}
                disabled={loading}
                style={({ pressed }) => [styles.primary, (pressed || loading) && { opacity: 0.85 }]}
              >
                {loading ? (
                  <ActivityIndicator color={colors.onBrand} />
                ) : (
                  <Text style={styles.primaryText}>Subscribe · {priceLabel}</Text>
                )}
              </Pressable>
              <Pressable testID="paywall-restore-button" onPress={restore} style={styles.secondary}>
                <Text style={styles.secondaryText}>Restore purchases</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              testID="paywall-preview-activate-button"
              onPress={previewActivate}
              disabled={loading}
              style={({ pressed }) => [styles.primary, (pressed || loading) && { opacity: 0.85 }]}
            >
              {loading ? (
                <ActivityIndicator color={colors.onBrand} />
              ) : (
                <Text style={styles.primaryText}>Activate 30-day test subscription</Text>
              )}
            </Pressable>
          )}

          <Text style={styles.legal}>
            By subscribing, your payment will be charged to your {iapOk ? "App Store / Google Play" : "store"} account.
            Subscription auto-renews unless cancelled at least 24 hours before the end of the period.
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const Bullet: React.FC<{ text: string }> = ({ text }) => (
  <View style={styles.bullet}>
    <Ionicons name="checkmark-circle" size={18} color={colors.brand} />
    <Text style={styles.bulletText}>{text}</Text>
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  bg: { ...(StyleSheet.absoluteFillObject as any) },
  safe: { flex: 1, justifyContent: "space-between", paddingHorizontal: spacing.lg },
  close: { alignSelf: "flex-end", padding: spacing.sm, marginTop: spacing.sm },
  content: { flex: 1, justifyContent: "center" },
  kicker: { color: colors.brand, fontWeight: "900", letterSpacing: 3, marginBottom: spacing.sm },
  headline: { color: colors.onSurface, fontSize: 72, fontWeight: "900", lineHeight: 76 },
  headlineSmall: { fontSize: 24, fontWeight: "700", color: colors.onSurfaceSecondary },
  sub: { color: colors.onSurfaceSecondary, fontSize: text.lg, marginTop: spacing.sm, marginBottom: spacing.xl },
  bullets: { gap: spacing.sm, marginTop: spacing.md },
  bullet: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  bulletText: { color: colors.onSurface, fontSize: text.lg },
  previewBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  previewText: { color: colors.onBrandTertiary, flex: 1, fontSize: text.base },
  cta: { paddingBottom: spacing.md, gap: spacing.sm },
  primary: { backgroundColor: colors.brand, borderRadius: radius.md, paddingVertical: spacing.lg, alignItems: "center" },
  primaryText: { color: colors.onBrand, fontWeight: "900", fontSize: text.lg, letterSpacing: 0.5 },
  secondary: { paddingVertical: spacing.md, alignItems: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.onSurface, fontWeight: "700" },
  error: { color: colors.error, backgroundColor: colors.errorBg, padding: spacing.md, borderRadius: radius.sm },
  info: { color: colors.onBrand, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.sm },
  legal: { color: colors.onSurfaceTertiary, fontSize: 11, marginTop: spacing.sm, textAlign: "center", lineHeight: 16 },
});
