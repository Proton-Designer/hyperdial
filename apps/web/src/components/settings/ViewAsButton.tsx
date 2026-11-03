import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { startViewAs, type OrgMember } from '@/lib/api';
import { openViewAsTab, isViewOnly } from '@/lib/viewAs';

/** TASK-H21: owner/admin row action "View as" for an active agent. Opens a view-only tab; the intern is not touched. */
export function ViewAsButton({ member, disabled }: { member: OrgMember; disabled?: boolean }) {
  const [starting, setStarting] = useState(false);
  if (isViewOnly || member.role !== 'agent' || member.status !== 'active') return null;
  const name =
    [member.first_name, member.last_name].filter(Boolean).join(' ') ||
    member.email ||
    'this intern';

  const start = async () => {
    setStarting(true);
    try {
      const r = await startViewAs(member.user_id);
      const tokens = { accessToken: r.accessToken, refreshToken: r.refreshToken };
      const meta = { sessionId: r.sessionId, targetId: r.target.userId, targetName: r.target.name };
      openViewAsTab(tokens, meta);
      // A browser can silently block a tab opened after a network call; this button is a fresh click.
      toast.success(`Viewing as ${r.target.name} in a new tab.`, {
        description: 'Nothing opened? Your browser may have blocked it.',
        duration: 20000,
        action: { label: 'Open it', onClick: () => openViewAsTab(tokens, meta) },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the view');
    } finally {
      setStarting(false);
    }
  };

  return (
    <button
      type="button"
      disabled={disabled || starting}
      onClick={() => void start()}
      title={`View as ${name}`}
      aria-label={`View as ${name}`}
      className="p-2 rounded-app-sm hover:bg-white/5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
    >
      {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
    </button>
  );
}
