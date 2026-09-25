import { useState } from 'react';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { OrgProvider } from '@/contexts/OrgContext';
import { PhoneNumbersProvider } from '@/contexts/PhoneNumbersContext';
import { AuthScreen } from './components/AuthScreen';
import { MainApp } from './components/MainApp';
import { InviteLanding } from './components/InviteLanding';
import { ResetPassword } from './components/ResetPassword';

function getInviteTokenFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('invite');
}

function clearInviteTokenFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', url.toString());
}

function AppContent() {
  const { user, loading, passwordRecovery } = useAuth();
  const [inviteToken, setInviteToken] = useState<string | null>(() => getInviteTokenFromUrl());

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0A1628]">
        <div className="text-[#B0BEC5]">Loading…</div>
      </div>
    );
  }

  // A password-recovery link takes priority over everything else -- supabase-js has already
  // turned it into a real session, but the user hasn't chosen a new password yet.
  if (passwordRecovery) {
    return <ResetPassword />;
  }

  if (inviteToken) {
    return (
      <InviteLanding
        token={inviteToken}
        onDone={() => {
          clearInviteTokenFromUrl();
          setInviteToken(null);
        }}
      />
    );
  }

  return <PhoneNumbersProvider>{!user ? <AuthScreen /> : <MainApp />}</PhoneNumbersProvider>;
}

export default function App() {
  return (
    <AuthProvider>
      <OrgProvider>
        <AppContent />
      </OrgProvider>
    </AuthProvider>
  );
}
