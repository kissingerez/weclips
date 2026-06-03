import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const KEY = "slate_jwt";

export const tokenStorage = {
  async set(token: string) {
    if (Platform.OS === "web") {
      try {
        if (typeof window !== "undefined") localStorage.setItem(KEY, token);
      } catch {}
      return;
    }
    await SecureStore.setItemAsync(KEY, token);
  },
  async get(): Promise<string | null> {
    if (Platform.OS === "web") {
      try {
        if (typeof window !== "undefined") return localStorage.getItem(KEY);
      } catch {}
      return null;
    }
    return await SecureStore.getItemAsync(KEY);
  },
  async clear() {
    if (Platform.OS === "web") {
      try {
        if (typeof window !== "undefined") localStorage.removeItem(KEY);
      } catch {}
      return;
    }
    await SecureStore.deleteItemAsync(KEY);
  },
};
