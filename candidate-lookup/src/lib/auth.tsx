import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchAuthMe, logoutUser as apiLogout } from "../api";
import { LoginPage } from "../components/LoginPage";
import type { AppPermissions, AppUser } from "../types";

const DEFAULT_PERMISSIONS: AppPermissions = {
  isAdmin: false,
  canAccessData: false,
  canEdit: false,
  canManageUsers: false,
};

type AuthContextValue = {
  user: AppUser | null;
  permissions: AppPermissions;
  authenticated: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  permissions: DEFAULT_PERMISSIONS,
  authenticated: false,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [permissions, setPermissions] = useState<AppPermissions>(DEFAULT_PERMISSIONS);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchAuthMe();
      setUser(data.user);
      setPermissions(data.permissions);
      setAuthenticated(data.authenticated);
    } catch {
      setUser(null);
      setPermissions(DEFAULT_PERMISSIONS);
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setUser(null);
      setPermissions(DEFAULT_PERMISSIONS);
      setAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, permissions, authenticated, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { authenticated, loading, refresh } = useAuth();

  if (loading) {
    return (
      <div className="login-page">
        <p className="loading login-loading">Loading…</p>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onSuccess={() => void refresh()} />;
  }

  return <>{children}</>;
}

export function useAuth() {
  return useContext(AuthContext);
}
