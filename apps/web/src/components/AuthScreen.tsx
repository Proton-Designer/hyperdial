import { useState } from 'react';
import { Mail, Lock, ArrowRight, Eye, EyeOff, CheckCircle } from 'lucide-react';
import { AuthSplitLayout } from '@/components/auth/AuthSplitLayout';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

// Invite-only (TASK-L4 / ADM-3): this screen is sign-in + password reset only. The only way to
// create an account is via an invite link (?invite=<token>), which routes to InviteLanding.tsx
// instead of here -- see App.tsx. The on_auth_user_created trigger enforces this server-side
// (20260925000300_invite_only_signup.sql) regardless of what this UI does or doesn't expose.
export function AuthScreen() {
  const { signIn, requestPasswordReset, error, clearError, loading } = useAuth();
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch {
      // Error is set in AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setForgotSubmitting(true);
    try {
      await requestPasswordReset(forgotEmail);
      setForgotSent(true);
    } catch {
      // Error is set in AuthContext
    } finally {
      setForgotSubmitting(false);
    }
  };

  return (
    <AuthSplitLayout>
      <div className="bg-surface-1 rounded-app-lg p-8 shadow-app-md border border-border-subtle">
        {showForgotPassword ? (
          forgotSent ? (
            <>
              <div className="flex justify-center mb-6">
                <div className="w-14 h-14 rounded-full bg-success-soft flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-success" />
                </div>
              </div>
              <h2 className="text-page-title text-text-primary mb-2 text-center">
                Check your email
              </h2>
              <p className="text-body text-text-secondary mb-8 text-center">
                If an account exists for{' '}
                <span className="text-text-primary font-medium">{forgotEmail}</span>, a password
                reset link has been sent.
              </p>
              <Button
                variant="primary"
                className="w-full h-12"
                onClick={() => {
                  setShowForgotPassword(false);
                  setForgotSent(false);
                }}
              >
                Back to sign in
                <ArrowRight className="w-5 h-5" />
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-page-title text-text-primary mb-2">Reset your password</h2>
              <p className="text-body text-text-secondary mb-8">
                Enter your email and we'll send you a reset link.
              </p>
              {error && (
                <div className="mb-5 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
                  {error}
                </div>
              )}
              <form onSubmit={handleForgotPasswordSubmit} className="space-y-5">
                <div>
                  <label className="block text-meta text-text-secondary mb-2 ml-1">Email</label>
                  <div className="relative">
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                    <input
                      type="email"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to transition-colors"
                      placeholder="you@company.com"
                      required
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  className="w-full h-12"
                  disabled={forgotSubmitting}
                  loading={forgotSubmitting}
                >
                  Send reset link
                </Button>
              </form>
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    setShowForgotPassword(false);
                  }}
                  className="text-body text-accent-to hover:underline font-semibold"
                >
                  Back to sign in
                </button>
              </div>
            </>
          )
        ) : (
          <>
            <h2 className="text-page-title text-text-primary mb-2">Welcome back</h2>
            <p className="text-body text-text-secondary mb-8">Sign in to continue dialing</p>

            {error && (
              <div className="mb-5 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-meta text-text-secondary mb-2 ml-1">Email</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to transition-colors"
                    placeholder="you@company.com"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-meta text-text-secondary mb-2 ml-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-12 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to transition-colors"
                    placeholder="••••••••"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-border-subtle bg-surface-2 accent-[var(--accent-to)]"
                  />
                  <span className="text-body text-text-secondary group-hover:text-text-primary transition-colors">
                    Remember me
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    setForgotEmail(email);
                    setShowForgotPassword(true);
                  }}
                  className="text-body text-accent-to hover:underline"
                >
                  Forgot password?
                </button>
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full h-12 group"
                disabled={loading || submitting}
                loading={submitting}
              >
                Sign In
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Button>
            </form>

            <div className="mt-6 text-center">
              <span className="text-body text-text-secondary">
                New here? Ask your team owner or admin for an invite link.
              </span>
            </div>
          </>
        )}
      </div>
    </AuthSplitLayout>
  );
}
