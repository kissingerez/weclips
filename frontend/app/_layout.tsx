import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { useAppFonts } from "@/src/hooks/use-app-fonts";
import { applyGlobalFont } from "@/src/lib/applyGlobalFont";
import { AuthProvider, useAuth } from "@/src/lib/auth";
import { useRevenueCatConfig } from "@/src/lib/useRevenueCat";

SplashScreen.preventAutoHideAsync();
applyGlobalFont();

function AuthGate() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  useRevenueCatConfig();

  useEffect(() => {
    if (loading) return;
    const inAuth = segments[0] === "(auth)";
    const onBannedScreen = segments[0] === "banned";
    if (!user && !inAuth) {
      router.replace("/(auth)/login");
    } else if (user && inAuth) {
      router.replace("/(tabs)/home");
    } else if (user?.is_banned && !onBannedScreen) {
      router.replace("/banned");
    } else if (user && !user.is_banned && onBannedScreen) {
      router.replace("/(tabs)/home");
    }
  }, [user, loading, segments, router]);

  return null;
}

export default function RootLayout() {
  const [iconsLoaded, iconErr] = useIconFonts();
  const [appFontsLoaded, appFontErr] = useAppFonts();
  const loaded = iconsLoaded && appFontsLoaded;
  const error = iconErr || appFontErr;

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <AuthGate />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#FFFFFF" } }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="video/[id]" options={{ presentation: "card" }} />
        <Stack.Screen name="paywall" options={{ presentation: "modal" }} />
        <Stack.Screen name="legal" options={{ presentation: "card" }} />
        <Stack.Screen name="banned" options={{ presentation: "card", gestureEnabled: false }} />
      </Stack>
    </AuthProvider>
  );
}
