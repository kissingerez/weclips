import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { registerForPush } from "./push";

/**
 * Registers this device for push once an authenticated user is present (and has
 * not disabled notifications), and routes notification taps to the right screen
 * via each notification's `action_url`. Safe no-op on web.
 */
export function usePushNotifications(userId?: string | null, enabled?: boolean) {
  const router = useRouter();
  const lastHandled = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || enabled === false) return;
    void registerForPush();
  }, [userId, enabled]);

  useEffect(() => {
    if (Platform.OS === "web") return; // expo-notifications response API not available on web
    function go(url?: unknown) {
      if (typeof url !== "string" || !url) return;
      if (lastHandled.current === url) return;
      lastHandled.current = url;
      try {
        router.push(url as never);
      } catch {
        // ignore unknown routes
      }
    }

    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      go((resp.notification.request.content.data as Record<string, unknown>)?.action_url);
    });

    // Cold start: app launched by tapping a notification.
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      go((resp?.notification.request.content.data as Record<string, unknown> | undefined)?.action_url);
    });

    return () => sub.remove();
  }, [router]);
}
