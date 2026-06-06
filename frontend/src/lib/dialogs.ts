import { Alert, Platform } from "react-native";

/**
 * Cross-platform dialog helpers built on React Native's Alert.
 *
 * Why a wrapper?
 *  - `window.confirm` / `window.prompt` work on web only and look like raw
 *    browser dialogs (ugly, inconsistent with the rest of the app).
 *  - On native we want a real, blocking, OS-styled dialog with proper
 *    "Cancel" / confirm actions.
 *
 * Behaviour:
 *  - iOS / Android: uses `Alert.alert` (and `Alert.prompt` on iOS).
 *  - Web (React Native Web): `Alert.alert` is not fully implemented for
 *    multi-button on every RN version, so we fall back to `window.confirm`
 *    / `window.prompt` / `window.alert` to get the same behaviour.
 *  - Android prompt: `Alert.prompt` does not exist on Android. We render a
 *    one-button confirm + prompt fallback to keep behaviour consistent.
 */

export function confirmDialog(
  title: string,
  message: string,
  options: { confirmText?: string; cancelText?: string; destructive?: boolean } = {}
): Promise<boolean> {
  const { confirmText = "OK", cancelText = "Cancel", destructive = false } = options;

  if (Platform.OS === "web") {
    const ok =
      typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(message ? `${title}\n\n${message}` : title)
        : true;
    return Promise.resolve(!!ok);
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelText, style: "cancel", onPress: () => resolve(false) },
        {
          text: confirmText,
          style: destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

export function alertDialog(title: string, message?: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message ? `${title}\n\n${message}` : title);
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    Alert.alert(title, message, [{ text: "OK", onPress: () => resolve() }], {
      cancelable: true,
      onDismiss: () => resolve(),
    });
  });
}

export function promptDialog(
  title: string,
  message: string,
  options: {
    placeholder?: string;
    defaultValue?: string;
    confirmText?: string;
    cancelText?: string;
  } = {}
): Promise<string | null> {
  const {
    placeholder = "",
    defaultValue = "",
    confirmText = "Submit",
    cancelText = "Cancel",
  } = options;

  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && typeof window.prompt === "function") {
      const v = window.prompt(message ? `${title}\n\n${message}` : title, defaultValue);
      return Promise.resolve(v === null ? null : String(v));
    }
    return Promise.resolve(null);
  }

  if (Platform.OS === "ios") {
    return new Promise<string | null>((resolve) => {
      Alert.prompt(
        title,
        message,
        [
          { text: cancelText, style: "cancel", onPress: () => resolve(null) },
          { text: confirmText, onPress: (text?: string) => resolve(text ?? "") },
        ],
        "plain-text",
        defaultValue,
        "default"
      );
    });
  }

  // Android: Alert.prompt does not exist. We resolve to a non-null sentinel
  // so the caller still proceeds (they can capture details via a follow-up
  // screen). Most call sites use this only to gate the action.
  return new Promise<string | null>((resolve) => {
    Alert.alert(
      title,
      `${message}\n\n(${placeholder || "Submit to continue"})`,
      [
        { text: cancelText, style: "cancel", onPress: () => resolve(null) },
        {
          text: confirmText,
          onPress: () => resolve(defaultValue || placeholder || "Submitted"),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(null) }
    );
  });
}
