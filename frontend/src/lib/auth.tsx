import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { tokenStorage } from "./tokenStorage";

export type Me = {
  id: string;
  email: string;
  display_name: string;
  username?: string | null;
  bio?: string | null;
  has_avatar?: boolean;
  followers_hidden?: boolean;
  followers?: number;
  following?: number;
  is_subscribed: boolean;
  subscription_status: string;
  created_at: string;
  deletion_pending?: boolean;
  deletion_expires_at?: string | null;
};

type AuthCtx = {
  user: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, display_name: string, username?: string) => Promise<void>;
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
    const { access_token } = await api.post<{ access_token: string }>("/auth/signup", body);
    await tokenStorage.set(access_token);
    await refresh();
  };

  const logout = async () => {
    await tokenStorage.clear();
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, loading, login, signup, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
};

export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
};
