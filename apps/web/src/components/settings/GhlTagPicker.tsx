import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { createGhlTag, listGhlTags } from '@/lib/api';

/**
 * TASK-G28: tag input for Settings -> GoHighLevel. Lists the connected GHL location's existing tags (searchable)
 * and lets an owner/admin type a new one -> "Create in GHL" (POST) -> added. `onAdd` receives the tag's stored
 * spelling. If the tag list cannot be loaded (token without the Tags scope, GHL down) the picker still takes a
 * typed tag: saving the settings creates missing tags in GHL as well (the endpoints report what failed).
 */
export function GhlTagPicker({
  selected,
  onAdd,
  inputId,
  placeholder = 'Search or add a tag',
}: {
  selected: string[];
  onAdd: (tag: string) => void;
  inputId: string;
  placeholder?: string;
}) {
  const [location, setLocation] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);

  const load = () => {
    if (requested.current) return;
    requested.current = true;
    setLoading(true);
    listGhlTags()
      .then((tags) => setLocation(tags))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    requested.current = false;
  }, [inputId]);

  const picked = useMemo(() => new Set(selected.map((t) => t.toLowerCase())), [selected]);
  const query = draft.trim();
  const matches = useMemo(
    () =>
      (location ?? [])
        .filter((t) => !picked.has(t.toLowerCase()))
        .filter((t) => !query || t.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 50),
    [location, picked, query]
  );
  const exact = (location ?? []).find((t) => t.toLowerCase() === query.toLowerCase());
  const alreadyPicked = query !== '' && picked.has(query.toLowerCase());
  // offered when the name is not in the location yet (or the location list is unavailable)
  const canCreate = query !== '' && !exact && !alreadyPicked;

  const finish = (tag: string) => {
    onAdd(tag);
    setDraft('');
    setError(null);
    setOpen(false);
  };

  const create = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await createGhlTag(query);
      setLocation((prev) =>
        prev && !prev.some((t) => t.toLowerCase() === res.tag.toLowerCase())
          ? [...prev, res.tag].sort((a, b) => a.localeCompare(b))
          : prev
      );
      finish(res.tag);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  // Enter / the Add button: an existing tag is added as-is; a new name is created in GHL first.
  const submit = () => {
    if (!query || alreadyPicked) {
      setDraft('');
      return;
    }
    if (exact) finish(exact);
    else if (loadError) finish(query);
    else void create();
  };

  return (
    <div className="relative">
      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          value={draft}
          autoComplete="off"
          onFocus={() => {
            setOpen(true);
            load();
          }}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          className="flex-1 min-w-0 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={submit}
          disabled={creating || !query}
          className="px-3 py-2 bg-surface-2 border border-white/10 rounded-lg text-sm text-white hover:bg-surface-3 disabled:opacity-50 flex items-center gap-1.5"
        >
          {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Add
        </button>
      </div>

      {open && (loading || matches.length > 0 || canCreate) && (
        <ul
          role="listbox"
          className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-auto rounded-lg border border-white/10 bg-surface-2 shadow-xl"
        >
          {loading && (
            <li className="px-3 py-2 text-xs text-text-secondary flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading GHL tags...
            </li>
          )}
          {matches.map((t) => (
            <li key={t} role="option" aria-selected="false">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => finish(t)}
                className="w-full text-left px-3 py-2 text-sm text-white hover:bg-white/10"
              >
                {t}
              </button>
            </li>
          ))}
          {canCreate && !loadError && (
            <li role="option" aria-selected="false">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void create()}
                disabled={creating}
                className="w-full text-left px-3 py-2 text-sm text-accent-to hover:bg-white/10 flex items-center gap-2 border-t border-white/10"
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Create “{query}” in GHL</span>
              </button>
            </li>
          )}
        </ul>
      )}

      {loadError && (
        <p className="text-xs text-yellow-400 mt-1">
          Couldn't load your GHL tags ({loadError}). You can still type a tag; saving creates it in
          GHL.
        </p>
      )}
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}
