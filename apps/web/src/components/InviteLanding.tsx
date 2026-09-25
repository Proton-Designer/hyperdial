import { useState, useEffect } from 'react';
import { Loader2, Mail, Lock, User, ArrowRight, LogOut } from 'lucide-react';
import { AnimatedBackground } from './AnimatedBackground';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import { previewOrgInvite, acceptOrgInvite, type InvitePreview } from '@/lib/api';

interface InviteLandingProps {
  token: string;
  /** Called once the invite has been accepted (or the visitor bails to plain sign-in/up). Clears
   * `?invite=` from the URL and lets the normal App flow take over. */
  onDone: () => void;
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', agent: 'Agent' };

export function InviteLanding({ token, onDone }: InviteLandingProps) {
  const { user, signUp, signIn, signOut, error, clearError } = useAuth();
  const { refetch: refetchOrg } = useOrg();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    previewOrgInvite(token)
      .then(setPreview)
      .catch((e) => setPreviewError(String(e)))
      .finally(() => setPreviewLoading(false));
  }, [token]);

  const handleAcceptAsSignedIn = async () => {
    setSubmitting(true);
    setPreviewError(null);
    try {
      await acceptOrgInvite(token);
      // OrgContext only refetches on mount / when `user` changes -- accepting an invite doesn't
      // change `user` (already signed in), so without this, role/orgId would stay whatever they
      // were before the membership existed (null, for a first-ever invite) all the way into
      // MainApp rendering -- exactly the review fix-forward's role-not-yet-confirmed gap.
      await refetchOrg();
      onDone();
    } catch (e) {
      setPreviewError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    if (!preview?.email) return;
    setSubmitting(true);
    try {
      if (mode === 'signup') {
        await signUp({
          email: preview.email,
          password,
          firstName,
          lastName,
          companyName: '',
          inviteToken: token,
        });
      } else {
        await signIn(preview.email, password);
      }
      await acceptOrgInvite(token);
      // See handleAcceptAsSignedIn's comment -- same staleness gap applies to a brand-new signup
      // via this form (a fresh user has no membership at all until this accept call lands it).
      await refetchOrg();
      onDone();
    } catch {
      // Error is set in AuthContext, or acceptOrgInvite threw -- surfaced via previewError below
      // if it wasn't an AuthContext error (acceptOrgInvite doesn't set AuthContext's error state).
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-[#0A1628] overflow-hidden">
      <div className="hidden lg:flex lg:w-[45%] relative overflow-hidden">
        <AnimatedBackground />
      </div>

      <div className="w-full lg:w-[55%] flex items-center justify-center p-8">
        <div className="w-full max-w-[440px]">
          <div className="mb-8 text-center lg:text-left">
            <div className="inline-flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#00D9FF] to-[#0066FF] flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white rounded-full" />
              </div>
              <span className="text-2xl font-bold text-white">HyperDial</span>
            </div>
          </div>

          <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-8 shadow-[0_4px_24px_rgba(0,102,255,0.15)] border border-white/5">
            {previewLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-8 h-8 text-[#00D9FF] animate-spin" />
              </div>
            ) : !preview?.valid ? (
              <>
                <h2 className="text-2xl font-bold text-white mb-2">Invite not available</h2>
                <p className="text-sm text-[#B0BEC5] mb-6">
                  {preview?.reason === 'accepted'
                    ? 'This invite has already been used.'
                    : preview?.reason === 'expired'
                      ? 'This invite has expired. Ask your team to send a new one.'
                      : "This invite link isn't valid."}
                </p>
                <button
                  type="button"
                  onClick={onDone}
                  className="w-full h-12 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold"
                >
                  Go to sign in
                </button>
              </>
            ) : user ? (
              <>
                <h2 className="text-2xl font-bold text-white mb-2">Join {preview.orgName}</h2>
                <p className="text-sm text-[#B0BEC5] mb-2">
                  You've been invited as{' '}
                  <span className="text-white font-medium">
                    {ROLE_LABEL[preview.role ?? ''] ?? preview.role}
                  </span>
                  .
                </p>
                <p className="text-sm text-[#B0BEC5] mb-6">
                  Signed in as <span className="text-white">{user.email}</span>.
                  {user.email?.toLowerCase() !== preview.email?.toLowerCase() && (
                    <span className="text-[#FF3D00]">
                      {' '}
                      This invite was sent to {preview.email} -- accepting may fail.
                    </span>
                  )}
                </p>
                {previewError && (
                  <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                    {previewError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleAcceptAsSignedIn}
                  disabled={submitting}
                  className="w-full h-12 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  <span>{submitting ? 'Joining…' : `Accept & join ${preview.orgName}`}</span>
                  {!submitting && <ArrowRight className="w-5 h-5" />}
                </button>
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="w-full mt-3 h-11 flex items-center justify-center gap-2 text-sm text-[#B0BEC5] hover:text-white transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out and use a different account
                </button>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-bold text-white mb-2">Join {preview.orgName}</h2>
                <p className="text-sm text-[#B0BEC5] mb-6">
                  You've been invited as{' '}
                  <span className="text-white font-medium">
                    {ROLE_LABEL[preview.role ?? ''] ?? preview.role}
                  </span>
                  . {mode === 'signup' ? 'Create an account to accept.' : 'Sign in to accept.'}
                </p>

                {(error || previewError) && (
                  <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                    {error || previewError}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-5">
                  {mode === 'signup' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-[#B0BEC5] mb-2 ml-1">First name</label>
                        <div className="relative">
                          <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#B0BEC5]" />
                          <input
                            type="text"
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                            placeholder="John"
                            required
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-[#B0BEC5] mb-2 ml-1">Last name</label>
                        <div className="relative">
                          <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#B0BEC5]" />
                          <input
                            type="text"
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                            placeholder="Doe"
                            required
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs text-[#B0BEC5] mb-2 ml-1">Email</label>
                    <div className="relative">
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#B0BEC5]" />
                      <input
                        type="email"
                        value={preview.email ?? ''}
                        readOnly
                        className="w-full bg-[#1E2A3A]/60 border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-[#B0BEC5] cursor-not-allowed"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-[#B0BEC5] mb-2 ml-1">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#B0BEC5]" />
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                        placeholder="••••••••"
                        required
                        minLength={6}
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full h-12 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    <span>
                      {submitting
                        ? 'Please wait…'
                        : mode === 'signup'
                          ? 'Create account & join'
                          : 'Sign in & join'}
                    </span>
                    {!submitting && <ArrowRight className="w-5 h-5" />}
                  </button>
                </form>

                <div className="mt-6 text-center">
                  <span className="text-sm text-[#B0BEC5]">
                    {mode === 'signup' ? 'Already have an account?' : 'New here?'}
                  </span>{' '}
                  <button
                    type="button"
                    onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}
                    className="text-sm text-[#00D9FF] hover:underline font-semibold"
                  >
                    {mode === 'signup' ? 'Sign In' : 'Create Account'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
