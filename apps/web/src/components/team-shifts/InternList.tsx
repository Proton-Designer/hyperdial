import { useState } from 'react';
import { Search, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Pill } from '../shifts/pills';
import {
  findGhlContact,
  upsertShiftMember,
  type AdminShiftMember,
  type AdminShiftsOverview,
} from '@/lib/api';
import { SetupCard, describeSetupError } from './setupUi';
import { displayName } from '../shifts/shiftFormat';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  agent: 'Intern',
};

/** Who takes part in Shifts, and which GHL contact each person is. Pods are managed in Settings;
 *  this list only shows them. */
export function InternList({
  members,
  canManagePods,
  onManagePods,
  onSaved,
}: {
  members: AdminShiftsOverview['members'];
  canManagePods: boolean;
  onManagePods?: () => void;
  onSaved: () => void;
}) {
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <SetupCard
      title="Interns"
      description="Choose who takes part in Shifts and link each person to their GoHighLevel contact so appointments, notes and tags reach the right record."
      actions={
        canManagePods && onManagePods ? (
          <Button variant="fe-secondary" size="sm" onClick={onManagePods}>
            <UsersRound /> Manage pods
          </Button>
        ) : undefined
      }
    >
      {sorted.length === 0 ? (
        <p className="text-body text-text-secondary">No team members yet.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {sorted.map((m) => (
            <li key={m.userId}>
              <MemberRow member={m} onSaved={onSaved} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-meta text-text-muted">
        Managers only see the interns in the pods they manage; the server decides who each person
        can see.
      </p>
    </SetupCard>
  );
}

function MemberRow({ member: m, onSaved }: { member: AdminShiftMember; onSaved: () => void }) {
  const [contact, setContact] = useState(m.ghlContactId ?? '');
  const [busy, setBusy] = useState<null | 'toggle' | 'contact' | 'find'>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ id: string; name: string; email: string }[] | null>(null);

  const contactDirty = contact.trim() !== (m.ghlContactId ?? '');

  const run = async (kind: 'toggle' | 'contact', body: Parameters<typeof upsertShiftMember>[0]) => {
    setBusy(kind);
    setError(null);
    try {
      await upsertShiftMember(body);
      toast.success(kind === 'toggle' ? 'Updated' : 'GHL contact saved');
      onSaved();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(null);
    }
  };

  const find = async () => {
    setBusy('find');
    setError(null);
    try {
      const { contacts } = await findGhlContact(m.email);
      setFound(contacts);
      if (contacts.length === 0) setError(`No GHL contact found for ${m.email}.`);
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 basis-52 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-body font-medium text-text-primary" title={m.name}>
              {displayName(m.name)}
            </span>
            <Pill>{ROLE_LABEL[m.role] ?? m.role}</Pill>
            {m.podName && <Pill tone="accent">{m.podName}</Pill>}
          </div>
          <div className="truncate text-meta text-text-muted">{m.email}</div>
        </div>
        <label className="flex items-center gap-2 text-meta text-text-secondary">
          <Switch
            checked={m.participates}
            disabled={busy !== null}
            onCheckedChange={(v) => void run('toggle', { userId: m.userId, participates: v })}
            aria-label={`${displayName(m.name)} takes part in Shifts`}
          />
          Takes part
        </label>
        <div className="flex min-w-0 flex-1 basis-72 items-center gap-2">
          <Input
            value={contact}
            onChange={(e) => {
              setContact(e.target.value);
              setError(null);
            }}
            placeholder="GHL contact ID"
            aria-label={`GHL contact ID for ${displayName(m.name)}`}
            className="h-8 min-w-0 flex-1"
          />
          {contactDirty ? (
            <Button
              variant="primary"
              size="sm"
              loading={busy === 'contact'}
              disabled={busy !== null}
              onClick={() =>
                void run('contact', { userId: m.userId, ghlContactId: contact.trim() || null })
              }
            >
              Save
            </Button>
          ) : (
            <Button
              variant="fe-secondary"
              size="sm"
              loading={busy === 'find'}
              disabled={busy !== null}
              onClick={() => void find()}
            >
              {busy !== 'find' && <Search />} Find in GHL
            </Button>
          )}
        </div>
      </div>
      {found && found.length > 0 && (
        <ul className="mt-2 divide-y divide-border-subtle rounded-app-md border border-border-subtle bg-surface-2">
          {found.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body text-text-primary">{c.name || c.email}</div>
                <div className="truncate text-meta text-text-muted">{c.email}</div>
              </div>
              <Button
                variant="fe-secondary"
                size="sm"
                onClick={() => {
                  setContact(c.id);
                  setFound(null);
                }}
              >
                Use this contact
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
