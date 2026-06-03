import { Redirect } from "expo-router";
import { useAuth } from "@/src/lib/auth";
import { View, ActivityIndicator } from "react-native";
import { colors } from "@/src/theme";

export default function Index() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface, justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }
  return <Redirect href={user ? "/(tabs)/home" : "/(auth)/login"} />;
}
