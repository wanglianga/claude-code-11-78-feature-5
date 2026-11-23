import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { UserRole } from '../core/types';

export interface SessionUser {
  name: string;
  role: UserRole;
}

const ACCOUNTS: Array<SessionUser & { password: string }> = [
  { name: '王监管', role: 'supervisor', password: 'supervisor123' },
  { name: '张巡检', role: 'inspector', password: 'inspector123' },
  { name: '陈审计', role: 'auditor', password: 'auditor123' },
];

const ROLE_LABEL: Record<UserRole, string> = {
  supervisor: '监管主管',
  inspector: '巡检员',
  auditor: '审计员',
};

interface AuthCtx {
  user: SessionUser | null;
  login: (name: string, password: string) => string | null;
  logout: () => void;
  roleLabel: (r?: UserRole) => string;
}

const Ctx = createContext<AuthCtx | null>(null);
const STORAGE_KEY = 'gas-consistency-session';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  });

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      login: (name, password) => {
        const hit = ACCOUNTS.find((a) => a.name === name && a.password === password);
        if (!hit) return '账号或密码错误';
        const next = { name: hit.name, role: hit.role };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setUser(next);
        return null;
      },
      logout: () => {
        localStorage.removeItem(STORAGE_KEY);
        setUser(null);
      },
      roleLabel: (r) => ROLE_LABEL[r ?? user?.role ?? 'auditor'],
    }),
    [user],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

export { ROLE_LABEL };
