import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, Pencil, Trash2 } from 'lucide-react';
import {
  addContactNote,
  deleteContactNote,
  editContactNote,
  listContactNotes,
  listOrgMembers,
  type ContactNote,
  type OrgMember,
} from '@/lib/api';

const textareaClass =
  'w-full bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-to resize-none';

function memberDisplayName(m: OrgMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.email || 'Member';
}

/** Q1 NIT (G5 follow-up): the composer resolves a mention by checking whether the PICKED
 *  member's display name is still present as a substring in the draft, not by any real id token
 *  in the text -- two active members sharing a display name are indistinguishable by that check,
 *  so picking one, deleting it, and picking the other-same-named one instead could still send
 *  BOTH ids (the stale entry's name substring is still "present," just because of the new pick).
 *  Fix: when 2+ ACTIVE members share a display name, the text actually inserted (and therefore
 *  matched against) is disambiguated with the email, making every person's own mention text
 *  unique -- the common case (no name collision) is completely unaffected. */
function mentionInsertText(member: OrgMember, activeMembers: OrgMember[]): string {
  const name = memberDisplayName(member);
  const isAmbiguous =
    activeMembers.filter((m) => m.user_id !== member.user_id && memberDisplayName(m) === name)
      .length > 0;
  if (!isAmbiguous) return name;
  // Email is the normal disambiguator (always unique per member); fall back to a short id
  // fragment on the rare chance email is also null, so this can never collapse back to a bare,
  // ambiguous name.
  return `${name} (${member.email ?? member.user_id.slice(0, 8)})`;
}

/** MISSION-5 TASK-M5-G5: the contact notes thread, shared between ContactDetailModal's own
 *  "Notes" tab (`compact=false`) and the live call card (`compact=true`, ParallelDialerUI.tsx) --
 *  same component, same RPCs, so an agent adding a note mid-call and an admin reading it later
 *  from the contact record see identical data through identical rules (15-minute edit/self-delete
 *  window, owner/admin delete-any, 5,000-char cap -- all server-enforced, this component only
 *  renders what list_contact_notes already tells it it may do via `canEdit`/`canDelete`).
 *
 *  @mentions: a lightweight client-side heuristic, not a rich token editor -- typing `@` opens a
 *  name-search dropdown (org members, active only) built from `listOrgMembers()` (already fetched
 *  elsewhere in the app for other pickers, no new endpoint); picking one inserts its display name
 *  as plain text and remembers the (id, name) pair. At submit time, only ids whose inserted name
 *  text is STILL present in the draft are actually sent as mentions -- picking a name then
 *  deleting it out of the textarea should not silently notify them. The server is the real
 *  authority regardless (add_contact_note re-validates every id is an ACTIVE org member and drops
 *  anything else), this is just about not sending an id the user visibly removed. */
export function ContactNotesPanel({
  contactId,
  compact = false,
}: {
  contactId: string;
  compact?: boolean;
}) {
  const [notes, setNotes] = useState<ContactNote[] | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null);
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map());
  const [posting, setPosting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = () => {
    listContactNotes(contactId)
      .then(setNotes)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load notes'));
  };

  useEffect(() => {
    load();
    // TASK-Q3F: kept silent -- best-effort only, the @mention autocomplete just won't suggest
    // names if this fails; notes still load/post/edit/delete fully without it.
    listOrgMembers()
      .then(setMembers)
      .catch(() => {});
    setDraft('');
    setMentioned(new Map());
    setEditingId(null);
    // contactId is the only real dependency -- load()/listOrgMembers are stable module functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const activeMembers = useMemo(() => members.filter((m) => m.status === 'active'), [members]);

  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    if (q === '') return activeMembers.slice(0, 6);
    return activeMembers
      .filter(
        (m) =>
          memberDisplayName(m).toLowerCase().includes(q) ||
          (m.email ?? '').toLowerCase().includes(q)
      )
      .slice(0, 6);
  }, [mentionQuery, activeMembers]);

  const handleDraftChange = (value: string, caret: number) => {
    setDraft(value);
    const upToCaret = value.slice(0, caret);
    const match = /@([\w .'-]{0,30})$/.exec(upToCaret);
    setMentionQuery(match ? { query: match[1], start: caret - match[1].length - 1 } : null);
  };

  const pickMention = (member: OrgMember) => {
    if (!mentionQuery) return;
    const name = mentionInsertText(member, activeMembers);
    const before = draft.slice(0, mentionQuery.start);
    const after = draft.slice(mentionQuery.start + 1 + mentionQuery.query.length);
    setDraft(`${before}@${name} ${after}`);
    setMentioned((prev) => new Map(prev).set(member.user_id, name));
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setError(null);
    try {
      const ids = [...mentioned.entries()]
        .filter(([, name]) => body.includes(`@${name}`))
        .map(([id]) => id);
      await addContactNote(contactId, body, ids);
      setDraft('');
      setMentioned(new Map());
      setMentionQuery(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add note');
    } finally {
      setPosting(false);
    }
  };

  const startEdit = (n: ContactNote) => {
    setEditingId(n.id);
    setEditDraft(n.body);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setBusyId(editingId);
    setError(null);
    try {
      await editContactNote(editingId, editDraft);
      setEditingId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save note');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await deleteContactNote(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete note');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      {!compact && (
        <h3 className="text-section-title text-text-primary mb-2 flex items-center gap-2">
          <MessageSquare className="w-4 h-4" />
          Notes
        </h3>
      )}
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      <div className={`space-y-2 overflow-y-auto pr-1 ${compact ? 'max-h-32' : 'max-h-64'}`}>
        {notes === null && <p className="text-xs text-text-secondary">Loading…</p>}
        {notes !== null && notes.length === 0 && (
          <p className="text-xs text-text-secondary">No notes yet.</p>
        )}
        {notes?.map((n) => (
          <div key={n.id} className="text-xs border-b border-white/5 pb-2 last:border-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-white font-medium">
                {n.authorName}
                {n.authorRemoved && ' (removed)'}
              </span>
              <span className="text-text-secondary">{new Date(n.createdAt).toLocaleString()}</span>
            </div>
            {editingId === n.id ? (
              <div className="mt-1 space-y-1">
                <textarea
                  className={textareaClass}
                  rows={2}
                  maxLength={5000}
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={busyId === n.id || !editDraft.trim()}
                    className="text-accent-to hover:underline disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="text-text-secondary hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-text-secondary whitespace-pre-wrap mt-1 break-words">
                {n.body}
                {n.editedAt && <span className="text-text-secondary/50"> (edited)</span>}
              </p>
            )}
            {editingId !== n.id && (n.canEdit || n.canDelete) && (
              <div className="flex gap-3 mt-1">
                {n.canEdit && (
                  <button
                    type="button"
                    onClick={() => startEdit(n)}
                    className="flex items-center gap-1 text-text-secondary hover:text-white"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                  </button>
                )}
                {n.canDelete && (
                  <button
                    type="button"
                    onClick={() => handleDelete(n.id)}
                    disabled={busyId === n.id}
                    className="flex items-center gap-1 text-danger/80 hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="relative mt-2">
        {mentionQuery && mentionSuggestions.length > 0 && (
          <div className="absolute z-10 bottom-full mb-1 left-0 w-56 rounded-lg border border-white/10 bg-surface-2 shadow-lg max-h-40 overflow-y-auto">
            {mentionSuggestions.map((m) => (
              <button
                key={m.user_id}
                type="button"
                onClick={() => pickMention(m)}
                className="block w-full text-left px-3 py-1.5 text-xs text-white hover:bg-white/10"
              >
                {mentionInsertText(m, activeMembers)}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={textareaClass}
          rows={compact ? 2 : 3}
          maxLength={5000}
          value={draft}
          onChange={(e) =>
            handleDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }
          placeholder="Add a note... type @ to mention someone"
        />
        <div className="flex justify-end mt-1">
          <button
            type="button"
            onClick={submit}
            disabled={posting || !draft.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-accent-from to-accent-to text-white disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            Post
          </button>
        </div>
      </div>
    </div>
  );
}
