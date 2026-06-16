import { ScrollView, StyleSheet, Text, View, Pressable, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, text } from "@/src/theme";

const SUPPORT_EMAIL = "support@weclips.app";
const TODAY = "February 4, 2026";

// Section content
const SECTIONS: Record<string, { title: string; body: string[] }> = {
  privacy: {
    title: "Privacy Policy",
    body: [
      `Last updated: ${TODAY}`,
      `WeClips ("we", "us") respects your privacy. This Policy explains what we collect, why, and how to control it.`,
      `INFORMATION WE COLLECT`,
      `• Account: email, display name, hashed password.`,
      `• Content: videos and comments you publish, like activity, view counts.`,
      `• Subscription: a token from Apple App Store / Google Play / RevenueCat confirming your subscription status. We never see your card or Apple/Google account details.`,
      `• Technical: device type, app version, IP for abuse prevention.`,
      `HOW WE USE IT`,
      `Operating the service, processing subscriptions, enforcing the Community Guidelines, responding to reports, security, and required legal compliance.`,
      `WHAT WE DO NOT DO`,
      `We do not sell your personal data. We do not show third-party ads. We do not train AI models on your content.`,
      `STORAGE`,
      `Videos are stored on Cloudflare R2 with private access. Account data is stored on MongoDB. Authenticated streaming URLs expire after one hour.`,
      `THIRD PARTIES`,
      `Apple/Google (subscription billing), RevenueCat (subscription validation), Cloudflare (video storage/delivery), SendGrid (password-reset emails). Each acts as a sub-processor under their own privacy terms.`,
      `YOUR RIGHTS`,
      `Access, correct, export, or delete your data at any time. Use Settings → Delete Account, or email ${SUPPORT_EMAIL}.`,
      `CHILDREN`,
      `WeClips is not directed to children under 13. We do not knowingly collect data from children. If you believe a child has provided us data, email ${SUPPORT_EMAIL}.`,
      `CHANGES`,
      `We will post any material changes here and in-app at least 7 days before they take effect.`,
      `CONTACT`,
      `${SUPPORT_EMAIL}`,
    ],
  },
  terms: {
    title: "Terms of Service",
    body: [
      `Last updated: ${TODAY}`,
      `By creating an account or subscribing, you agree to these Terms.`,
      `THE SERVICE`,
      `WeClips is a paid, ad-free video platform. A monthly subscription is required to upload and to watch content. Subscriptions are billed by Apple App Store or Google Play and auto-renew until cancelled at least 24 hours before the renewal date in your store settings.`,
      `YOUR ACCOUNT`,
      `You're responsible for your credentials. You must be at least 13 years old (16 in the EU/UK).`,
      `YOUR CONTENT`,
      `You retain ownership of what you upload. By uploading, you grant WeClips a worldwide, non-exclusive license to host, stream, and display your content within the service. You represent that you own (or have permission to use) all elements of your videos.`,
      `COMMUNITY GUIDELINES (see below)`,
      `You agree to follow them. We may remove content or terminate accounts that violate them.`,
      `NO REFUNDS`,
      `Subscription fees are non-refundable except where required by law. Cancelling stops the next renewal; you keep access until the end of the current period.`,
      `TERMINATION`,
      `You may delete your account at any time (Settings → Delete Account). We may suspend or terminate accounts that violate these Terms.`,
      `DISCLAIMER`,
      `The service is provided "as is" without warranty. We are not liable for indirect or consequential damages to the extent allowed by law.`,
      `GOVERNING LAW`,
      `These Terms are governed by the laws of your country of residence.`,
      `CHANGES`,
      `We will notify users in-app of material changes at least 7 days in advance.`,
      `CONTACT`,
      `${SUPPORT_EMAIL}`,
    ],
  },
  guidelines: {
    title: "Community Guidelines",
    body: [
      `WeClips exists for calm, comprehensible, human-made video. The following content is not allowed:`,
      `• AI-generated content of any kind`,
      `• Videos with two or more music tracks layered at once`,
      `• Videos with excessive audio/video effects (anything intended to overstimulate)`,
      `• Demonic, occult, or content that promotes anti-Christian beliefs`,
      `• Sexual content, gratuitous violence, harassment, hate speech, doxxing, illegal activity, or content that exploits minors`,
      `• Content that infringes copyright, trademark, or other intellectual-property rights — only upload material you own or are licensed to use`,
      `• Spam, scams, or impersonation`,
      `COPYRIGHT`,
      `You must own (or have written permission for) every element of your videos: footage, music, voiceover, and on-screen text. We honor DMCA takedown notices — contact ${SUPPORT_EMAIL} with the URL of the infringing video, proof you hold the rights, and a sworn statement under penalty of perjury.`,
      `ANIME & CARTOONS`,
      `Welcome — provided they do not advocate or promote anti-Christian beliefs.`,
      `REPORTING`,
      `Use the report button on any video or comment. We review reports within 48 hours during business days. Repeat offenders are removed permanently.`,
      `BLOCKING`,
      `You can block any user. Their content disappears from your feed and they cannot comment on your videos.`,
      `ENFORCEMENT`,
      `We may remove content and suspend or terminate accounts at our discretion.`,
      `QUESTIONS`,
      `${SUPPORT_EMAIL}`,
    ],
  },
  about: {
    title: "About & Contact",
    body: [
      `WeClips is an ad-free, $0.99/month video platform built for people who want watchable, comprehensible video.`,
      `Owner & operator: Nixon Kissinger Rodriguez, International.`,
      `Support: ${SUPPORT_EMAIL}`,
      `Subscription billing is handled by Apple App Store and Google Play.`,
      `Video storage and delivery: Cloudflare R2.`,
    ],
  },
};

export default function Legal() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  const router = useRouter();
  const key = (section as string) || "privacy";
  const sec = SECTIONS[key] || SECTIONS.privacy;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="legal-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{sec.title}</Text>
        <View style={{ width: 24 }} />
      </View>
      <View style={styles.tabs}>
        {(["privacy", "terms", "guidelines", "about"] as const).map((k) => (
          <Pressable
            key={k}
            testID={`legal-tab-${k}`}
            onPress={() => router.setParams({ section: k })}
            style={[styles.tab, key === k && styles.tabActive]}
          >
            <Text style={[styles.tabText, key === k && styles.tabTextActive]}>
              {k === "privacy" ? "Privacy" : k === "terms" ? "Terms" : k === "guidelines" ? "Rules" : "About"}
            </Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        {sec.body.map((p, i) => (
          <Text key={i} style={p === p.toUpperCase() && p.length < 50 ? styles.heading : styles.para}>
            {p}
          </Text>
        ))}
        <Pressable
          onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
          style={styles.mailBtn}
          testID="legal-email-button"
        >
          <Ionicons name="mail" size={16} color={colors.onBrand} />
          <Text style={styles.mailText}>Email {SUPPORT_EMAIL}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  tabs: {
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  tab: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceSecondary },
  tabActive: { backgroundColor: colors.brand },
  tabText: { color: colors.onSurfaceSecondary, fontWeight: "700", fontSize: text.sm },
  tabTextActive: { color: colors.onBrand },
  body: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  heading: { color: colors.onSurface, fontWeight: "800", fontSize: text.base, marginTop: spacing.lg, marginBottom: spacing.xs, letterSpacing: 0.5 },
  para: { color: colors.onSurfaceSecondary, fontSize: text.base, lineHeight: 22, marginBottom: spacing.sm },
  mailBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.brand,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.xl,
  },
  mailText: { color: colors.onBrand, fontWeight: "700" },
});
