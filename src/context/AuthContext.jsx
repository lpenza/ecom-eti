import React, { createContext, useContext, useState, useEffect } from 'react';
import { login as apiLogin, verifyToken } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    verifyToken().then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  async function login(email, password) {
    const data = await apiLogin(email, password);
    localStorage.setItem('velinne_token', data.token);
    setUser(data.user);
    return data.user;
  }

  function logout() {
    localStorage.removeItem('velinne_token');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
