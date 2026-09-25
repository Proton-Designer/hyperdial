import { useState } from 'react';
import { Lock, ArrowRight, CheckCircle } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
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
    <div className="min-h-screen flex items-center justify-center bg-[#0A1628] p-8">
      <div className="w-full max-w-[440px]">
        <div className="mb-8 flex justify-center">
          <Logo size={40} wordmarkClassName="text-2xl" />
        </div>

        <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-8 shadow-[0_4px_24px_rgba(0,102,255,0.15)] border border-white/5">
          {done ? (
            <>
              <div className="flex justify-center mb-6">
                <div className="w-14 h-14 rounded-full bg-[#00E676]/20 flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-[#00E676]" />
                </div>
              </div>
              <h2 className="text-2xl font-bold text-white mb-2 text-center">Password updated</h2>
              <p className="text-sm text-[#B0BEC5] mb-8 text-center">
                Your password has been changed. Continue into HyperDial.
              </p>
              <button
                type="button"
                onClick={clearPasswordRecovery}
                className="w-full h-12 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold flex items-center justify-center gap-2"
              >
                <span>Continue</span>
                <ArrowRight className="w-5 h-5" />
              </button>
            </>
          ) : (
            <>
              <h2 className="text-3xl font-bold text-white mb-2">Set a new password</h2>
              <p className="text-sm text-[#B0BEC5] mb-8">Choose a new password for your account.</p>

              {error && (
                <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="block text-xs text-[#B0BEC5] mb-2 ml-1">New password</label>
                  <div className="relative">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#B0BEC5]" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF] transition-colors"
                      placeholder="••••••••"
                      required
                      minLength={6}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#B0BEC5] mb-2 ml-1">Confirm password</label>
                  <div className="relative">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#B0BEC5]" />
                    <input
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF] transition-colors"
                      placeholder="••••••••"
                      required
                      minLength={6}
                    />
                  </div>
                  {confirm && password !== confirm && (
                    <p className="mt-2 text-xs text-[#FF3D00]">Passwords don't match</p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={submitting || password.length < 6 || password !== confirm}
                  className="w-full h-12 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span>{submitting ? 'Updating…' : 'Update password'}</span>
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
