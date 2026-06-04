import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useAuth } from "@/src/lib/auth";
import { api, ApiError } from "@/src/lib/api";
import { Avatar } from "@/src/components/Avatar";
import { Toast } from "@/src/components/Toast";
import { colors, radius, spacing, text } from "@/src/theme";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const r = (reader.result as string) || "";
      const c = r.indexOf(",");
      resolve(c >= 0 ? r.slice(c + 1) : r);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export default function EditProfile() {
  const { user, refresh } = useAuth();
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [followersHidden, setFollowersHidden] = useState(false);
  const [emailPublic, setEmailPublic] = useState(false);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [avatarVer, setAvatarVer] = useState(0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const pickAvatar = async () => {
    setErr(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErr("Media library permission required.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    let b64 = asset.base64;
    if (!b64) {
      try {
        const resp = await fetch(asset.uri);
        const blob = await resp.blob();
        b64 = await blobToBase64(blob);
      } catch {}
    }
    if (!b64) {
      setErr("Could not read image.");
      return;
    }
    setAvatarBusy(true);
    try {
      await api.put("/auth/me/avatar", { avatar_base64: b64 });
      setAvatarUri(asset.uri);
      setAvatarVer(Date.now());
      await refresh();
      setToast("Profile picture updated");
    } catch (e: any) {
      setErr(e?.message || "Could not upload picture");
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    try {
      await api.del("/auth/me/avatar");
      setAvatarUri(null);
      setAvatarVer(Date.now());
      await refresh();
      setToast("Profile picture removed");
    } catch (e: any) {
      setErr(e?.message || "Could not remove picture");
    } finally {
      setAvatarBusy(false);
    }
  };

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name || "");
      setUsername(user.username || "");
      setBio(user.bio || "");
      setEmail(user.email || "");
      setFollowersHidden(!!user.followers_hidden);
      setEmailPublic(!!user.email_public);
    }
  }, [user]);

  const onSave = async () => {
    setErr(null);

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
    if (bio !== (user?.bio || "")) body.bio = bio;
    if (followersHidden !== !!user?.followers_hidden) body.followers_hidden = followersHidden;
    if (emailPublic !== !!user?.email_public) body.email_public = emailPublic;
    if (trimmedEmail !== user?.email) body.email = trimmedEmail;
    if (wantsPwChange) {
      body.current_password = currentPassword;
      body.new_password = newPassword;
    }

    if (Object.keys(body).length === 0) {
      setToast("No changes to save");
      return;
    }

    setSaving(true);
    try {
      await api.patch("/auth/me", body);
      await refresh();
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setToast("Saved");
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

          <View style={styles.avatarRow}>
            <Avatar
              userId={user?.id}
              displayName={user?.display_name}
              hasAvatar={!!user?.has_avatar}
              size={88}
              version={avatarVer}
              uri={avatarUri}
            />
            <View style={{ flex: 1, marginLeft: spacing.lg }}>
              <Text style={styles.avatarTitle}>Profile picture</Text>
              <Text style={styles.hint}>Square crop. Visible to other users.</Text>
              <View style={styles.avatarBtnRow}>
                <Pressable
                  testID="edit-avatar-pick"
                  onPress={pickAvatar}
                  disabled={avatarBusy}
                  style={[styles.avatarBtn, avatarBusy && { opacity: 0.6 }]}
                >
                  {avatarBusy ? (
                    <ActivityIndicator color={colors.onBrand} size="small" />
                  ) : (
                    <>
                      <Ionicons name="camera" size={14} color={colors.onBrand} />
                      <Text style={styles.avatarBtnText}>
                        {user?.has_avatar ? "Change" : "Upload"}
                      </Text>
                    </>
                  )}
                </Pressable>
                {user?.has_avatar ? (
                  <Pressable
                    testID="edit-avatar-remove"
                    onPress={removeAvatar}
                    disabled={avatarBusy}
                    style={[styles.avatarBtn, styles.avatarBtnGhost]}
                  >
                    <Ionicons name="trash-outline" size={14} color={colors.onSurface} />
                    <Text style={[styles.avatarBtnText, { color: colors.onSurface }]}>
                      Remove
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>

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

          <Text style={styles.label}>Bio</Text>
          <TextInput
            testID="edit-bio"
            style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
            value={bio}
            onChangeText={setBio}
            multiline
            maxLength={300}
            placeholder="Tell people a bit about yourself (max 300 chars)"
            placeholderTextColor={colors.onSurfaceTertiary}
          />

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

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleTitle}>Show my email on my profile</Text>
              <Text style={styles.hint}>
                Off by default. When on, your email is visible to anyone visiting your profile.
              </Text>
            </View>
            <Switch
              testID="edit-show-email"
              value={emailPublic}
              onValueChange={setEmailPublic}
              trackColor={{ true: colors.brand, false: colors.surfaceTertiary }}
              thumbColor={colors.onBrand}
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleTitle}>Hide my followers</Text>
              <Text style={styles.hint}>
                Other users won't see your follower count or list. You can still see your own.
              </Text>
            </View>
            <Switch
              testID="edit-hide-followers"
              value={followersHidden}
              onValueChange={setFollowersHidden}
              trackColor={{ true: colors.brand, false: colors.surfaceTertiary }}
              thumbColor={colors.onBrand}
            />
          </View>

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
      <Toast
        message={toast}
        variant="success"
        durationMs={1500}
        onHide={() => setToast(null)}
        testID="edit-profile-toast"
      />
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
  avatarRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    marginBottom: spacing.md,
  },
  avatarTitle: { color: colors.onSurface, fontSize: text.lg, fontWeight: "800" },
  avatarBtnRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" },
  avatarBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  avatarBtnGhost: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatarBtnText: { color: colors.onBrand, fontWeight: "700", fontSize: text.sm },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.lg,
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  toggleTitle: { color: colors.onSurface, fontSize: text.base, fontWeight: "800" },
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
