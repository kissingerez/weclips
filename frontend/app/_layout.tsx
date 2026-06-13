import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { useAppFonts } from "@/src/hooks/use-app-fonts";
import { applyGlobalFont } from "@/src/lib/applyGlobalFont";
import { AuthProvider, useAuth } from "@/src/lib/auth";
import { UploadProgressProvider, UploadPill } from "@/src/lib/uploadProgress";
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
    // Guests are allowed to browse non-account features (Apple 5.1.1). We only
    // redirect: logged-in users away from the auth screens, and banned users to
    // the banned screen. Guests are never forced to log in.
    if (user && inAuth) {
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
      <UploadProgressProvider>
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
        <UploadPill />
      </UploadProgressProvider>
    </AuthProvider>
  );
}
