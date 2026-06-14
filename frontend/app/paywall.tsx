import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
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

  const [priceLabel, setPriceLabel] = useState<string>("$0.99 / month");
  const [pkg, setPkg] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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
      setErr("Open WeClips on your phone to subscribe.");
      return;
    }
    const Purchases = loadPurchases();
    if (!Purchases || !pkg) {
      setErr("Store not ready — please try again in a moment.");
      return;
    }
    setLoading(true);
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      const active = !!customerInfo?.entitlements?.active?.[RC_ENTITLEMENT];
      if (active) {
        try {
          await api.post("/subscription/sync");
        } catch {}
        await refresh();
        setInfo("You're in! Membership activated.");
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
            {priceLabel.split("/")[0].trim()}
            <Text style={styles.headlineSmall}>
              {priceLabel.includes("/") ? " /" + priceLabel.split("/").slice(1).join("/") : " /month"}
            </Text>
          </Text>

          <View style={styles.bullets}>
            <Bullet text="Zero ads — ever." />
            <Bullet text="100% human-made. No AI." />
            <Bullet text="Family-friendly." />
          </View>
        </View>

        <View style={styles.cta}>
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
            disabled={loading}
            style={({ pressed }) => [styles.primary, (pressed || loading) && { opacity: 0.85 }]}
          >
            {loading ? (
              <ActivityIndicator color={colors.onBrand} />
            ) : (
              <Text style={styles.primaryText}>Subscribe · {priceLabel}</Text>
            )}
          </Pressable>

          <Pressable testID="paywall-restore-button" onPress={restore} hitSlop={8} style={styles.restore}>
            <Text style={styles.restoreText}>Restore purchases</Text>
          </Pressable>

          <Text style={styles.legal}>Auto-renews. Cancel anytime in your store account.</Text>
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
