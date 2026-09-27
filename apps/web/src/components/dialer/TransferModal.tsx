import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listOrgMembers, type OrgMember } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface TransferModalProps {
  onClose: () => void;
  onStart: (args: {
    type: 'cold' | 'warm';
    targetKind: 'member' | 'external';
    targetUserId?: string;
    targetNumber?: string;
  }) => Promise<void>;
}

function memberName(m: OrgMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.email || m.user_id;
}

/** TASK-T4: picks cold/warm + a teammate (WebRTC) or a plain E.164 number, then calls
 *  `startTransfer` (via `onStart`). Dismissible (unlike WrapUpModal) -- starting a transfer is
 *  never mandatory. */
export function TransferModal({ onClose, onStart }: TransferModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  const [type, setType] = useState<'cold' | 'warm'>('warm');
  const [targetKind, setTargetKind] = useState<'member' | 'external'>('member');
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [targetUserId, setTargetUserId] = useState('');
  const [targetNumber, setTargetNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listOrgMembers()
      .then((all) => setMembers(all.filter((m) => m.status === 'active')))
      .catch((e) => setMembersError(e instanceof Error ? e.message : 'Failed to load teammates'));
  }, []);

  const handleSubmit = async () => {
    setError(null);
    if (targetKind === 'member' && !targetUserId) {
      setError('Pick a teammate to transfer to.');
      return;
    }
    if (targetKind === 'external' && !/^\+[1-9]\d{6,14}$/.test(targetNumber)) {
      setError('Enter a valid number in E.164 format (e.g. +15551234567).');
      return;
    }
    setSubmitting(true);
    try {
      await onStart({
        type,
        targetKind,
        targetUserId: targetKind === 'member' ? targetUserId : undefined,
        targetNumber: targetKind === 'external' ? targetNumber : undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the transfer');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      ref={modalRef}
      className="fixed inset-0 flex items-center justify-center p-4 outline-none"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-title"
      tabIndex={-1}
    >
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" onClick={onClose} />
      <div className="relative z-[1] w-full max-w-sm rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md">
        <div className="border-b border-border-subtle p-4">
          <h2 id="transfer-title" className="text-page-title text-text-primary">
            Transfer call
          </h2>
        </div>
        <div className="p-4 space-y-4">
          {error && (
            <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
              {error}
            </div>
          )}
          <div>
            <p className="text-meta text-text-secondary mb-1.5">Type</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={type === 'warm' ? 'fe-secondary' : 'fe-ghost'}
                onClick={() => setType('warm')}
              >
                Warm (talk first)
              </Button>
              <Button
                type="button"
                size="sm"
                variant={type === 'cold' ? 'fe-secondary' : 'fe-ghost'}
                onClick={() => setType('cold')}
              >
                Cold (hand off)
              </Button>
            </div>
          </div>
          <div>
            <p className="text-meta text-text-secondary mb-1.5">Send to</p>
            <div className="flex gap-2 mb-2">
              <Button
                type="button"
                size="sm"
                variant={targetKind === 'member' ? 'fe-secondary' : 'fe-ghost'}
                onClick={() => setTargetKind('member')}
              >
                Teammate
              </Button>
              <Button
                type="button"
                size="sm"
                variant={targetKind === 'external' ? 'fe-secondary' : 'fe-ghost'}
                onClick={() => setTargetKind('external')}
              >
                Phone number
              </Button>
            </div>
            {targetKind === 'member' ? (
              membersError ? (
                <p className="text-meta text-danger">{membersError}</p>
              ) : (
                <select
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                  className="w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary focus:outline-none focus:border-accent-to"
                >
                  <option value="">Choose a teammate…</option>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {memberName(m)}
                    </option>
                  ))}
                </select>
              )
            ) : (
              <input
                type="tel"
                placeholder="+15551234567"
                value={targetNumber}
                onChange={(e) => setTargetNumber(e.target.value)}
                className="w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
              />
            )}
          </div>
        </div>
        <div className="border-t border-border-subtle p-4 flex justify-end gap-2">
          <Button type="button" variant="fe-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Starting…' : 'Start transfer'}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
