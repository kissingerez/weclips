import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { api } from "./api";

// How notifications behave while the app is foregrounded (module scope so it is
// registered exactly once). No-ops harmlessly on web.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  } catch {
    // ignore — channel creation is best-effort
  }
}

/**
 * Request permission (if needed), fetch the native device push token, and
 * register it with the backend so it can be resolved to this account later.
 * Returns true when a token was registered. Safe no-op on web / simulators.
 */
export async function registerForPush(): Promise<boolean> {
  if (Platform.OS === "web" || !Device.isDevice) return false;
  try {
    await ensureAndroidChannel();
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return false;
    const { data } = await Notifications.getDevicePushTokenAsync();
    await api.post("/register-push", {
      platform: Platform.OS,
      device_token: String(data),
    });
    return true;
  } catch (e) {
    console.warn("[push] register failed", e);
    return false;
  }
}
