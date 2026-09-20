import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';

const USER_KEY = "bb_mock_user";
const AuthContext = createContext(null);

function readUserFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY)) || null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(readUserFromStorage);

  const sync = useCallback(() => {
    setCurrentUser(readUserFromStorage());
  }, []);

  useEffect(() => {
    const onStorage = (e) => {
      if (!e || e.key === USER_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('user_updated', sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('user_updated', sync);
    };
  }, [sync]);

  const login = useCallback((user) => {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      window.dispatchEvent(new Event('user_updated'));
    } catch {
      // ignore
    }
    setCurrentUser(user);
  }, []);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(USER_KEY);
      window.dispatchEvent(new Event('user_updated'));
    } catch {
      // ignore
    }
    setCurrentUser(null);
  }, []);

  const value = useMemo(() => ({
    currentUser,
    login,
    logout,
  }), [currentUser, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
