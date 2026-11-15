/**
 * Who is signed in. Live builds use the API's own sign-in (A25): the session is restored from the
 * refresh cookie on start, and roles and permissions come from `/api/auth/me`. The hosted demo
 * (`--mode demo`) keeps the role picker and has no real sign-in.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, login, logout, onSessionChange, restoreSession, type AuthGrant, type AuthUser, type NextStep } from "./api";
import { canSee, DEMO_ROLE_PERMISSIONS, V1_ROLES, type Area, type DemoAccount, type V1Role } from "./roles";
import { currentAccount, setCurrentUser } from "./user";

const DEMO = import.meta.env.MODE === "demo";

export interface Account {
  username: string;
  displayName: string;
  email: string;
  /** The first role the user holds, in V1_ROLES order: for labels and front doors only. */
  role: V1Role;
  /** Every role the user holds. Gate on these (`hasRole`, `can`), never on `role` alone. */
  roles: readonly V1Role[];
  permissions: readonly string[];
}

interface Me {
  user: AuthUser & { email?: string | null };
  roles: string[];
  permissions: string[];
  next: NextStep;
}

interface Session {
  account: Account | null;
  /** A first-sign-in step still owed (change the temporary password, set up two-factor). */
  next: NextStep;
  /** Why the user is back at sign-in, in plain words. */
  notice: string | null;
  /** Demo only: sign in as one of the fictional accounts. */
  signIn: (account: DemoAccount) => void;
  signInWithPassword: (input: { username: string; password: string; otp?: string }) => Promise<void>;
  completeStep: (next: NextStep) => void;
  signOut: () => Promise<void>;
  can: (area: Area) => boolean;
  hasRole: (...roles: V1Role[]) => boolean;
  /** Whether the account holds an API permission (e.g. `documents.verify`): show only actions it can perform. */
  allows: (permission: string) => boolean;
}

const fromDemo = (a: DemoAccount | null): Account | null => (a ? { ...a, roles: [a.role], permissions: DEMO_ROLE_PERMISSIONS[a.role] } : null);

const SessionContext = createContext<Session | null>(null);

interface State {
  ready: boolean;
  account: Account | null;
  next: NextStep;
  notice: string | null;
}

/** Renders `fallback` until the session is known, so no screen guesses who is signed in. */
export function SessionProvider({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<State>(() => ({ ready: DEMO, account: DEMO ? fromDemo(currentAccount()) : null, next: null, notice: null }));
  const seq = useRef(0);
  const loading = useRef<Promise<void>>(Promise.resolve());
  const leaving = useRef(false);

  useEffect(() => {
    if (DEMO) return;
    const apply = async (grant: AuthGrant | null) => {
      const mine = ++seq.current;
      if (!grant) {
        const ended = !leaving.current;
        leaving.current = false;
        qc.clear();
        setState((s) => ({ ready: true, account: null, next: null, notice: s.account && ended ? "Your session has ended. Sign in again to carry on." : s.notice }));
        return;
      }
      try {
        const me = await api.get<Me>("/api/auth/me");
        if (mine !== seq.current) return;
        const roles = V1_ROLES.filter((r) => me.roles.includes(r));
        if (!roles.length) {
          setState({ ready: true, account: null, next: null, notice: "Your account has no role yet. Ask the system admin to give you one." });
          leaving.current = true;
          await logout();
          return;
        }
        const { username, displayName, email } = me.user;
        setState({ ready: true, next: me.next, notice: null, account: { username, displayName, email: email ?? "", role: roles[0]!, roles, permissions: me.permissions } });
      } catch {
        if (mine !== seq.current) return;
        setState((s) => ({ ...s, ready: true, notice: s.account ? s.notice : "We couldn't load your account. Check your connection and sign in again." }));
      }
    };
    const off = onSessionChange((grant) => {
      loading.current = apply(grant);
    });
    restoreSession().catch((err: unknown) => {
      // The Cloudflare client demo's Worker names the secrets still missing, or says the API did not start (A32).
      const deployment = err instanceof ApiError && (err.code === "NOT_CONFIGURED" || err.code === "API_NOT_STARTED");
      const notice = deployment ? err.message : "We couldn't reach the server. Check your connection and try again.";
      setState((s) => (s.ready ? s : { ...s, ready: true, notice }));
    });
    return off;
  }, [qc]);

  const signIn = useCallback((a: DemoAccount) => {
    setCurrentUser(a.username);
    setState((s) => ({ ...s, account: fromDemo(a) }));
  }, []);
  const signInWithPassword = useCallback(async (input: { username: string; password: string; otp?: string }) => {
    await login(input);
    await loading.current;
  }, []);
  const completeStep = useCallback((next: NextStep) => setState((s) => ({ ...s, next })), []);
  const signOut = useCallback(async () => {
    if (DEMO) {
      setCurrentUser(null);
      setState((s) => ({ ...s, account: null }));
      return;
    }
    leaving.current = true;
    await logout();
  }, []);

  const { account, next, notice, ready } = state;
  const value = useMemo<Session>(
    () => ({
      account,
      next,
      notice,
      signIn,
      signInWithPassword,
      completeStep,
      signOut,
      can: (area) => !!account && account.roles.some((r) => canSee(r, area)),
      hasRole: (...roles) => !!account && account.roles.some((r) => roles.includes(r)),
      allows: (permission) => !!account && account.permissions.includes(permission),
    }),
    [account, next, notice, signIn, signInWithPassword, completeStep, signOut],
  );
  return <SessionContext.Provider value={value}>{ready ? children : fallback}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside <SessionProvider>");
  return s;
}
