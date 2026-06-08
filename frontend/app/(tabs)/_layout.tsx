import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing } from "@/src/theme";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  // Reserve space below the icons so on-screen Android nav buttons
  // (back/home/recents) don't overlap the tab targets. iOS already has
  // a safe area, but Android edge-to-edge requires us to add `insets.bottom`
  // manually. We also keep a small min-padding so devices without inset
  // (e.g. older Android with physical buttons) still have a comfortable gap.
  const extraBottom = Math.max(insets.bottom, Platform.OS === "android" ? 8 : 0);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.onSurfaceTertiary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 64 + extraBottom,
          paddingBottom: spacing.sm + extraBottom,
          paddingTop: spacing.sm,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
          tabBarTestID: "tab-home",
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: ({ color, size }) => <Ionicons name="search" size={size} color={color} />,
          tabBarTestID: "tab-search",
        }}
      />
      <Tabs.Screen
        name="upload"
        options={{
          title: "Upload",
          tabBarIcon: ({ color, size }) => <Ionicons name="add-circle" size={size + 4} color={color} />,
          tabBarTestID: "tab-upload",
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" size={size} color={color} />,
          tabBarTestID: "tab-profile",
        }}
      />
    </Tabs>
  );
}
