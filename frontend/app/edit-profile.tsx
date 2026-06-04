import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/lib/auth";
import { api, ApiError } from "@/src/lib/api";
import { colors, radius, spacing, text } from "@/src/theme";

export default function EditProfile() {
  const { user, refresh } = useAuth();
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name || "");
      setUsername(user.username || "");
      setEmail(user.email || "");
    }
  }, [user]);

  const onSave = async () => {
    setErr(null);
    setOk(null);

    const trimmedName = displayName.trim();
    const u = username.trim().replace(/^@/, "").toLowerCase();
    const trimmedEmail = email.trim().toLowerCase();
    const wantsPwChange = newPassword.length > 0 || currentPassword.length > 0;

    if (!trimmedName) {
      setErr("Display name cannot be empty.");
      return;
    }
    if (u && !/^[a-z0-9_]{3,20}$/.test(u)) {
      setErr("Username must be 3-20 lowercase letters, numbers or _.");
      return;
    }
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setErr("Please enter a valid email.");
      return;
    }
    if (wantsPwChange) {
      if (newPassword.length < 6) {
        setErr("New password must be at least 6 characters.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setErr("New password and confirmation do not match.");
        return;
      }
      if (!currentPassword) {
        setErr("Enter your current password to change it.");
        return;
      }
    }

    const body: any = {};
    if (trimmedName !== user?.display_name) body.display_name = trimmedName;
    if (u && u !== user?.username) body.username = u;
    if (trimmedEmail !== user?.email) body.email = trimmedEmail;
    if (wantsPwChange) {
      body.current_password = currentPassword;
      body.new_password = newPassword;
    }

    if (Object.keys(body).length === 0) {
      setOk("No changes to save.");
      return;
    }

    setSaving(true);
    try {
      await api.patch("/auth/me", body);
      await refresh();
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setOk("Profile updated.");
    } catch (e: any) {
      if (e instanceof ApiError) setErr(e.message);
      else setErr(e?.message || "Update failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="edit-back-button">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Edit account</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {err ? (
            <Text style={styles.error} testID="edit-error">
              {err}
            </Text>
          ) : null}
          {ok ? (
            <Text style={styles.success} testID="edit-success">
              {ok}
            </Text>
          ) : null}

          <Text style={styles.label}>Display name</Text>
          <TextInput
            testID="edit-display-name"
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholderTextColor={colors.onSurfaceTertiary}
            maxLength={40}
          />

          <Text style={styles.label}>Username (@handle)</Text>
          <TextInput
            testID="edit-username"
            style={styles.input}
            value={username}
            onChangeText={(v) => setUsername(v.replace(/[^a-zA-Z0-9_@]/g, ""))}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={colors.onSurfaceTertiary}
            maxLength={21}
          />
          <Text style={styles.hint}>
            3-20 lowercase letters, numbers and underscores. Others find you by this handle.
          </Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="edit-email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholderTextColor={colors.onSurfaceTertiary}
          />

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Change password</Text>
            <Text style={styles.hint}>Leave blank to keep your current password.</Text>
          </View>

          <Text style={styles.label}>Current password</Text>
          <TextInput
            testID="edit-current-password"
            style={styles.input}
            value={currentPassword}
            onChangeText={setCurrentPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholder="Required to change password"
            placeholderTextColor={colors.onSurfaceTertiary}
          />

          <Text style={styles.label}>New password</Text>
          <TextInput
            testID="edit-new-password"
            style={styles.input}
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholder="Min 6 characters"
            placeholderTextColor={colors.onSurfaceTertiary}
          />

          <Text style={styles.label}>Confirm new password</Text>
          <TextInput
            testID="edit-confirm-password"
            style={styles.input}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
            placeholderTextColor={colors.onSurfaceTertiary}
          />

          <Pressable
            testID="edit-save-button"
            disabled={saving}
            onPress={onSave}
            style={({ pressed }) => [
              styles.saveBtn,
              (pressed || saving) && { opacity: 0.7 },
            ]}
          >
            {saving ? (
              <ActivityIndicator color={colors.onBrand} />
            ) : (
              <Text style={styles.saveBtnText}>Save changes</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  label: {
    color: colors.onSurfaceSecondary,
    fontSize: text.sm,
    fontWeight: "700",
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: text.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hint: {
    color: colors.onSurfaceTertiary,
    fontSize: text.sm,
    marginTop: spacing.xs,
  },
  section: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  sectionTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  saveBtn: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.xl,
  },
  saveBtnText: { color: colors.onBrand, fontWeight: "800", fontSize: text.lg },
  error: {
    color: colors.error,
    backgroundColor: colors.errorBg,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
  success: {
    color: colors.onBrand,
    backgroundColor: colors.success,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
});
