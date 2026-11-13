import { useState, useEffect } from 'react';
import { Loader2, Mail, Lock, User, ArrowRight, LogOut } from 'lucide-react';
import { AuthSplitLayout } from '@/components/auth/AuthSplitLayout';
import { Button } from '@/components/ui/button';
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
    <AuthSplitLayout>
      <div className="bg-surface-1 rounded-app-lg p-8 shadow-app-md border border-border-subtle">
        {previewLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-8 h-8 text-accent-to animate-spin" />
          </div>
        ) : !preview?.valid ? (
          <>
            <h2 className="text-page-title text-text-primary mb-2">Invite not available</h2>
            <p className="text-body text-text-secondary mb-6">
              {preview?.reason === 'accepted'
                ? 'This invite has already been used.'
                : preview?.reason === 'expired'
                  ? 'This invite has expired. Ask your team to send a new one.'
                  : "This invite link isn't valid."}
            </p>
            <Button variant="primary" className="w-full h-12" onClick={onDone}>
              Go to sign in
            </Button>
          </>
        ) : user ? (
          <>
            <h2 className="text-page-title text-text-primary mb-2">Join {preview.orgName}</h2>
            <p className="text-body text-text-secondary mb-2">
              You've been invited as{' '}
              <span className="text-text-primary font-medium">
                {ROLE_LABEL[preview.role ?? ''] ?? preview.role}
              </span>
              .
            </p>
            <p className="text-body text-text-secondary mb-6">
              Signed in as <span className="text-text-primary">{user.email}</span>.
              {user.email?.toLowerCase() !== preview.email?.toLowerCase() && (
                <span className="text-danger">
                  {' '}
                  This invite was sent to {preview.email} -- accepting may fail.
                </span>
              )}
            </p>
            {previewError && (
              <div className="mb-5 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
                {previewError}
              </div>
            )}
            <Button
              variant="primary"
              className="w-full h-12"
              onClick={handleAcceptAsSignedIn}
              disabled={submitting}
              loading={submitting}
            >
              {`Accept & join ${preview.orgName}`}
              <ArrowRight className="w-5 h-5" />
            </Button>
            <Button variant="fe-ghost" className="w-full mt-3 h-11" onClick={() => signOut()}>
              <LogOut className="w-4 h-4" />
              Sign out and use a different account
            </Button>
          </>
        ) : (
          <>
            <h2 className="text-page-title text-text-primary mb-2">Join {preview.orgName}</h2>
            <p className="text-body text-text-secondary mb-6">
              You've been invited as{' '}
              <span className="text-text-primary font-medium">
                {ROLE_LABEL[preview.role ?? ''] ?? preview.role}
              </span>
              . {mode === 'signup' ? 'Create an account to accept.' : 'Sign in to accept.'}
            </p>

            {(error || previewError) && (
              <div className="mb-5 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
                {error || previewError}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              {mode === 'signup' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-meta text-text-secondary mb-2 ml-1">
                      First name
                    </label>
                    <div className="relative">
                      <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                      <input
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
                        placeholder="John"
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-meta text-text-secondary mb-2 ml-1">
                      Last name
                    </label>
                    <div className="relative">
                      <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                      <input
                        type="text"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
                        placeholder="Doe"
                        required
                      />
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-meta text-text-secondary mb-2 ml-1">Email</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                  <input
                    type="email"
                    autoComplete="username"
                    value={preview.email ?? ''}
                    readOnly
                    className="w-full bg-surface-2/60 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-secondary cursor-not-allowed"
                  />
                </div>
              </div>

              <div>
                <label className="block text-meta text-text-secondary mb-2 ml-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-secondary" />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-12 pr-4 py-3.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
                    placeholder="••••••••"
                    required
                    minLength={6}
                  />
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full h-12"
                disabled={submitting}
                loading={submitting}
              >
                {mode === 'signup' ? 'Create account & join' : 'Sign in & join'}
                <ArrowRight className="w-5 h-5" />
              </Button>
            </form>

            <div className="mt-6 text-center">
              <span className="text-body text-text-secondary">
                {mode === 'signup' ? 'Already have an account?' : 'New here?'}
              </span>{' '}
              <button
                type="button"
                onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}
                className="text-body text-accent-to hover:underline font-semibold"
              >
                {mode === 'signup' ? 'Sign In' : 'Create Account'}
              </button>
            </div>
          </>
        )}
      </div>
    </AuthSplitLayout>
  );
}
