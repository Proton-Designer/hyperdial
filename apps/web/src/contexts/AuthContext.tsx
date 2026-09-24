import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export interface SignUpInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
  /** Present only on the invite-accept signup path (TASK-P1-03). When set, the
   * on_auth_user_created trigger creates just a profile -- no new org -- so the invite can be
   * accepted into the inviting org instead. See supabase/migrations/20260924000100's trigger
   * comment for the full contract. */
  inviteToken?: string;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  signUp: (input: SignUpInput) => Promise<{ emailConfirmationSent: boolean }>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  /** True from the moment supabase-js detects a password-recovery link in the URL until the
   * user either sets a new password or signs out. App.tsx uses this to show the reset screen
   * instead of the normal signed-in app, even though a recovery link does carry a real session. */
  passwordRecovery: boolean;
  clearPasswordRecovery: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  const clearError = useCallback(() => setError(null), []);
  const clearPasswordRecovery = useCallback(() => setPasswordRecovery(false), []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      // Supabase-js fires this when it parses a `type=recovery` link from the URL fragment on
      // load -- the session it creates is real, but the user hasn't chosen a new password yet
      // and shouldn't land in the normal app until they do.
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = useCallback(async (input: SignUpInput) => {
    setError(null);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: {
          first_name: input.firstName,
          last_name: input.lastName,
          company_name: input.companyName,
          ...(input.inviteToken ? { invite_token: input.inviteToken } : {}),
        },
      },
    });
    if (signUpError) {
      setError(signUpError.message);
      throw signUpError;
    }
    // No session until email is confirmed when Supabase "Confirm email" is enabled
    const emailConfirmationSent = !!data?.user && !data?.session;
    return { emailConfirmationSent };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      const isUnconfirmed =
        signInError.message?.toLowerCase().includes('email not confirmed') ||
        signInError.message?.toLowerCase().includes('confirm your email');
      setError(
        isUnconfirmed
          ? "Your email hasn't been confirmed yet. Please check your inbox and click the confirmation link."
          : signInError.message
      );
      throw signInError;
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    await supabase.auth.signOut();
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (resetError) {
      setError(resetError.message);
      throw resetError;
    }
  }, []);

  const updatePassword = useCallback(async (newPassword: string) => {
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) {
      setError(updateError.message);
      throw updateError;
    }
  }, []);

  const value: AuthContextValue = {
    user,
    session,
    loading,
    error,
    clearError,
    signUp,
    signIn,
    signOut,
    requestPasswordReset,
    updatePassword,
    passwordRecovery,
    clearPasswordRecovery,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
