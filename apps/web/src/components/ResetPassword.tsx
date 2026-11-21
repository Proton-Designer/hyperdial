import { useState } from 'react';
import { Lock, ArrowRight, CheckCircle } from 'lucide-react';
import { AuthSplitLayout } from '@/components/auth/AuthSplitLayout';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

/** Shown when AuthContext.passwordRecovery is true -- supabase-js already turned the recovery
 * link into a real session, so this screen's only job is collecting a new password before the
 * user reaches the normal app (see AuthContext's PASSWORD_RECOVERY handling). */
export function ResetPassword() {
  const { updatePassword, error, clearError, clearPasswordRecovery } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    if (password.length < 6) return;
    if (password !== confirm) return;
    setSubmitting(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch {
      // Error is set in AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthSplitLayout>
      <div className="bg-surface-1 rounded-app-lg p-8 shadow-app-md border border-border-subtle">
        {done ? (
          <>
            <div className="flex justify-center mb-6">
              <div className="w-14 h-14 rounded-full bg-success-soft flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-success" />
              </div>
            </div>
            <h2 className="text-page-title text-text-primary mb-2 text-center">Password updated</h2>
            <p className="text-body text-text-secondary mb-8 text-center">
              Your password has been changed. Continue into HyperDial.
            </p>
            <Button variant="primary" className="w-full h-12" onClick={clearPasswordRecovery}>
              Continue
              <ArrowRight className="w-5 h-5" />
            </Button>
          </>
        ) : (
          <>
            <h2 className="text-page-title text-text-primary mb-2">Set a new password</h2>
            <p className="text-body text-text-secondary mb-8">
              Choose a new password for your account.
            </p>

            {error && (
              <div className="mb-5 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-meta text-text-secondary mb-2 ml-1">
                  New password
                </label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to transition-colors"
                    placeholder="••••••••"
                    required
                    minLength={6}
                  />
                </div>
              </div>
              <div>
                <label className="block text-meta text-text-secondary mb-2 ml-1">
                  Confirm password
                </label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to transition-colors"
                    placeholder="••••••••"
                    required
                    minLength={6}
                  />
                </div>
                {confirm && password !== confirm && (
                  <p className="mt-2 text-xs text-danger">Passwords don't match</p>
                )}
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full h-12"
                disabled={submitting || password.length < 6 || password !== confirm}
                loading={submitting}
              >
                Update password
              </Button>
            </form>
          </>
        )}
      </div>
    </AuthSplitLayout>
  );
}
