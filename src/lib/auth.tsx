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
  guestAccess: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  promptLogin: () => void;
  cancelLoginPrompt: () => void;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  permissions: DEFAULT_PERMISSIONS,
  authenticated: false,
  guestAccess: false,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
  promptLogin: () => {},
  cancelLoginPrompt: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [permissions, setPermissions] = useState<AppPermissions>(DEFAULT_PERMISSIONS);
  const [authenticated, setAuthenticated] = useState(false);
  const [guestAccess, setGuestAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loginPrompt, setLoginPrompt] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchAuthMe();
      setUser(data.user);
      setPermissions(data.permissions);
      setAuthenticated(data.authenticated);
      setGuestAccess(Boolean(data.guestAccess));
      if (data.user) setLoginPrompt(false);
    } catch {
      setUser(null);
      setPermissions(DEFAULT_PERMISSIONS);
      setAuthenticated(false);
      setGuestAccess(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      await refresh();
      setLoginPrompt(false);
    }
  }, [refresh]);

  const promptLogin = useCallback(() => {
    setLoginPrompt(true);
  }, []);

  const cancelLoginPrompt = useCallback(() => {
    setLoginPrompt(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider
      value={{
        user,
        permissions,
        authenticated,
        guestAccess,
        loading,
        refresh,
        logout,
        promptLogin,
        cancelLoginPrompt,
      }}
    >
      {children}
      {loginPrompt ? (
        <div className="login-overlay" role="dialog" aria-modal="true" aria-label="Sign in">
          <LoginPage
            onSuccess={() => void refresh()}
            onCancel={() => setLoginPrompt(false)}
          />
        </div>
      ) : null}
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
