import { useEffect } from "react";
import { useAuth } from "./auth";
import { rcConfigureOnce, rcLogin } from "./iap";

/**
 * Configures RevenueCat exactly once per process (anonymously), then ties the
 * RevenueCat session to the authenticated JWT user id via `Purchases.logIn`
 * whenever a user signs in. Sign-out is handled in `auth.tsx` via `rcLogout`.
 * No-ops on web / Expo Go.
 */
export function useRevenueCatConfig() {
  const { user } = useAuth();

  // Configure once on mount.
  useEffect(() => {
    rcConfigureOnce();
  }, []);

  // Attach identity whenever a user becomes available.
  useEffect(() => {
    if (!user?.id) return;
    rcConfigureOnce(); // safe no-op if already configured
    void rcLogin(user.id);
  }, [user?.id]);
}
