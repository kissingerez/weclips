import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, text } from "@/src/theme";

type Props = {
  icon?: keyof typeof Ionicons.glyphMap;
  title?: string;
  message?: string;
  testID?: string;
};

// Shown to guests when they tap an account-based feature. Keeps non-account
// browsing free (Apple 5.1.1) while routing to sign-in for account actions.
export const SignInWall: React.FC<Props> = ({
  icon = "lock-closed-outline",
  title = "Sign in to continue",
  message = "Create a free account or sign in to use this feature.",
  testID = "signin-wall",
}) => {
  const router = useRouter();
  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.iconCircle}>
        <Ionicons name={icon} size={34} color={colors.brand} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      <Pressable
        testID="signin-wall-signin"
        onPress={() => router.push("/(auth)/login")}
        style={[styles.btn, { backgroundColor: colors.brand }]}
      >
        <Text style={styles.btnText}>Sign in</Text>
      </Pressable>
      <Pressable
        testID="signin-wall-signup"
        onPress={() => router.push("/(auth)/signup")}
        style={[styles.btn, styles.btnOutline]}
      >
        <Text style={[styles.btnText, { color: colors.onSurface }]}>Create account</Text>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, backgroundColor: colors.surface },
  iconCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  title: { color: colors.onSurface, fontSize: text.xl, fontWeight: "800", textAlign: "center" },
  message: {
    color: colors.onSurfaceSecondary,
    fontSize: text.base,
    textAlign: "center",
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    maxWidth: 320,
  },
  btn: { width: "100%", maxWidth: 320, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: "center", marginBottom: spacing.sm },
  btnOutline: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  btnText: { color: colors.onBrand, fontWeight: "800", fontSize: text.base },
});
