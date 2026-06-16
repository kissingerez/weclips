import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { tokenStorage } from "./tokenStorage";
import { rcLogout } from "./iap";

export type Me = {
  id: string;
  email: string;
  display_name: string;
  username?: string | null;
  bio?: string | null;
  has_avatar?: boolean;
  is_founder?: boolean;
  email_public?: boolean;
  followers_hidden?: boolean;
  followers?: number;
  following?: number;
  is_subscribed: boolean;
  subscription_status: string;
  created_at: string;
  deletion_pending?: boolean;
  deletion_expires_at?: string | null;
  warnings_count?: number;
  is_banned?: boolean;
  banned_until?: string | null;
  ban_reason?: string | null;
  ban_type?: "temporary" | "permanent" | null;
};

type AuthCtx = {
  user: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (
    email: string,
    password: string,
    display_name: string,
    username?: string
  ) => Promise<{ verificationRequired: boolean }>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const tok = await tokenStorage.get();
      if (!tok) {
        setUser(null);
        return;
      }
      const me = await api.get<Me>("/auth/me");
      setUser(me);
    } catch {
      await tokenStorage.clear();
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const { access_token } = await api.post<{ access_token: string }>("/auth/login", {
      email,
      password,
    });
    await tokenStorage.set(access_token);
    await refresh();
  };

  const signup = async (email: string, password: string, display_name: string, username?: string) => {
    const body: any = { email, password, display_name };
    if (username && username.trim()) body.username = username.trim();
    const res = await api.post<any>("/auth/signup", body);
    if (res?.access_token) {
      // Backwards-compatible: if the API ever returns a token, log straight in.
      await tokenStorage.set(res.access_token);
      await refresh();
      return { verificationRequired: false };
    }
    return { verificationRequired: true };
  };

  const verifyEmail = async (email: string, code: string) => {
    const { access_token } = await api.post<{ access_token: string }>("/auth/verify-email", {
      email,
      code,
    });
    await tokenStorage.set(access_token);
    await refresh();
  };

  const resendVerification = async (email: string) => {
    await api.post("/auth/resend-verification", { email });
  };

  const logout = async () => {
    // Detach RevenueCat first so the next account on this device cannot inherit
    // the prior user's subscription state.
    await rcLogout();
    await tokenStorage.clear();
    setUser(null);
  };

  return (
    <Ctx.Provider
      value={{ user, loading, login, signup, verifyEmail, resendVerification, logout, refresh }}
    >
      {children}
    </Ctx.Provider>
  );
};

export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
};
