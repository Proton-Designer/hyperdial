import { useState, useEffect } from 'react';
import { contactHeadline, contactNameMatches, contactSecondaryName } from '@/lib/contactName';
import {
  Search,
  Upload,
  Plus,
  MoreVertical,
  Phone,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Users,
} from 'lucide-react';
import {
  listContacts,
  deleteContact,
  deleteContacts,
  type Contact,
  type ImportFromGhlInput,
} from '@/lib/api';
import { AddContactModal } from '@/components/contacts/AddContactModal';
import { ImportContactsModal } from '@/components/contacts/ImportContactsModal';
import { ImportFromGhlModal } from '@/components/contacts/ImportFromGhlModal';
import { ContactDetailModal } from '@/components/contacts/ContactDetailModal';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import { ListSkeleton, TableSkeleton } from '@/components/app/skeletons';
import { useOrg } from '@/contexts/OrgContext';
import { TapCheckbox } from '@/components/mobile/TapCheckbox';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { cn } from '@/components/ui/utils';

const CATEGORIES = ['All', 'Cold', 'Warm', 'Follow Up', 'Voicemail', 'Booked'] as const;
const CONTACT_STATUSES = ['All', 'No Contact', 'Contacted', 'Closed'] as const;
const CONTACTS_PER_PAGE = 50;

function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium truncate max-w-full',
        tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-text-secondary'
      )}
    >
      {children}
    </span>
  );
}

export function Contacts({ onNavigateToDialer }: { onNavigateToDialer?: () => void } = {}) {
  const { role } = useOrg();
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  // TASK-L4 / UI-4: agents get a read-only contacts UI -- import/add/edit/delete/bulk actions are
  // owner/admin only. Row-level RLS already scopes which contacts an agent sees; this only hides
  // the management affordances for whichever contacts they can see.
  const canManage = role === 'owner' || role === 'admin';
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('All');
  const [contactStatusFilter, setContactStatusFilter] = useState<string>('All');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [ghlModalOpen, setGhlModalOpen] = useState(false);
  const [ghlModalAutoSubmit, setGhlModalAutoSubmit] = useState(false);
  const [lastGhlImport, setLastGhlImport] = useState<ImportFromGhlInput | null>(null);
  const [detailContact, setDetailContact] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  const fetchContacts = () => {
    setLoading(true);
    listContacts()
      .then(setContacts)
      .catch(() => setContacts([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchContacts();
  }, []);

  useEffect(() => {
    setCurrentPage(0);
  }, [searchQuery, categoryFilter, contactStatusFilter]);

  // Backlog #1: Prev/Next sits at the bottom of a long list -- clicking it left the viewport
  // exactly where it was, silently showing a different page's rows while still scrolled to the
  // bottom (easy to miss the page actually changed). MainApp.tsx's <main> is the real scroll
  // container (h-screen layout, main has overflow-auto; window itself doesn't scroll here).
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentPage]);

  const filteredContacts = contacts.filter((contact) => {
    const matchesSearch = contactNameMatches(contact, searchQuery);
    const cat = contact.category ?? 'Cold';
    const status = contact.contact_status ?? 'No Contact';
    const matchesCategory = categoryFilter === 'All' || cat === categoryFilter;
    const matchesStatus = contactStatusFilter === 'All' || status === contactStatusFilter;
    return matchesSearch && matchesCategory && matchesStatus;
  });

  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / CONTACTS_PER_PAGE));
  const pageStart = currentPage * CONTACTS_PER_PAGE;
  const paginatedContacts = filteredContacts.slice(pageStart, pageStart + CONTACTS_PER_PAGE);

  useEffect(() => {
    setCurrentPage((p) => (p >= totalPages && totalPages > 0 ? totalPages - 1 : p));
  }, [totalPages]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllOnPage = () => {
    const pageIds = new Set(paginatedContacts.map((c) => c.id));
    const allOnPageSelected =
      paginatedContacts.length > 0 && paginatedContacts.every((c) => selectedIds.has(c.id));
    if (allOnPageSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const handleDeleteOne = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('Delete this contact?')) return;
    setDeleting(true);
    try {
      await deleteContact(id);
      setDetailContact((prev) => (prev?.id === id ? null : prev));
      fetchContacts();
    } finally {
      setDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    const n = selectedIds.size;
    if (n === 0 || !window.confirm(`Delete ${n} contact${n === 1 ? '' : 's'}?`)) return;
    setDeleting(true);
    try {
      await deleteContacts(Array.from(selectedIds));
      setSelectedIds(new Set());
      setDetailContact(null);
      fetchContacts();
    } finally {
      setDeleting(false);
    }
  };

  const allOnPageSelected =
    paginatedContacts.length > 0 && paginatedContacts.every((c) => selectedIds.has(c.id));

  const importActions = canManage && (
    <>
      {lastGhlImport && (
        <Button
          variant="fe-secondary"
          size="sm"
          onClick={() => {
            setGhlModalAutoSubmit(true);
            setGhlModalOpen(true);
          }}
          title={`Re-sync "${lastGhlImport.value}" (${lastGhlImport.mode === 'tag' ? 'by tag' : 'by search'})`}
        >
          <RefreshCw className="w-4 h-4" />
          Re-sync
        </Button>
      )}
      <Button
        variant="fe-secondary"
        size="sm"
        onClick={() => {
          setGhlModalAutoSubmit(false);
          setGhlModalOpen(true);
        }}
      >
        <Download className="w-4 h-4" />
        Import from GHL
      </Button>
      <Button variant="fe-secondary" size="sm" onClick={() => setImportModalOpen(true)}>
        <Upload className="w-4 h-4" />
        Import
      </Button>
      <Button variant="primary" size="sm" onClick={() => setAddModalOpen(true)}>
        <Plus className="w-4 h-4" />
        Add contact
      </Button>
    </>
  );

  // Mobile: the 4 management actions collapse into one "Add" menu (task spec).
  const mobileActions = canManage && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="primary" size="sm" className="touch:min-h-11">
          <Plus className="w-4 h-4" />
          Add
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setAddModalOpen(true)}>Add contact</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setImportModalOpen(true)}>Import CSV</DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setGhlModalAutoSubmit(false);
            setGhlModalOpen(true);
          }}
        >
          Import from GHL
        </DropdownMenuItem>
        {lastGhlImport && (
          <DropdownMenuItem
            onClick={() => {
              setGhlModalAutoSubmit(true);
              setGhlModalOpen(true);
            }}
          >
            Re-sync GHL import
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="hd-touch p-4 sm:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title="Contacts"
        description="Manage your contact database"
        actions={isDesktop ? importActions : mobileActions}
      />

      {/* Toolbar: search + filter chips in one row. */}
      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 mb-6">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex-1 min-w-[240px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search contacts..."
              className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-9 pr-3 py-2 text-body touch:min-h-11 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to transition-colors"
            />
          </div>
          <div className="flex flex-wrap gap-1.5 items-center max-lg:w-full max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:pb-1">
            <span className="text-[12px] uppercase tracking-wide text-text-muted mr-0.5 max-lg:shrink-0">
              Category
            </span>
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={cn(
                  'px-2.5 py-1.5 rounded-app-sm text-[13px] font-medium transition-colors touch:min-h-11 touch:min-w-11 max-lg:px-3 max-lg:shrink-0',
                  categoryFilter === cat
                    ? 'bg-accent-from/20 text-accent-to'
                    : 'bg-surface-2 text-text-secondary hover:bg-surface-3'
                )}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 items-center max-lg:w-full max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:pb-1">
            <span className="text-[12px] uppercase tracking-wide text-text-muted mr-0.5 max-lg:shrink-0">
              Status
            </span>
            {CONTACT_STATUSES.map((status) => (
              <button
                key={status}
                onClick={() => setContactStatusFilter(status)}
                className={cn(
                  'px-2.5 py-1.5 rounded-app-sm text-[13px] font-medium transition-colors touch:min-h-11 touch:min-w-11 max-lg:px-3 max-lg:shrink-0',
                  contactStatusFilter === status
                    ? 'bg-accent-from/20 text-accent-to'
                    : 'bg-surface-2 text-text-secondary hover:bg-surface-3'
                )}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      </div>

      {canManage && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-4 px-3 py-2 rounded-app-md bg-surface-2 border border-border-subtle">
          <span className="text-body text-text-secondary">{selectedIds.size} selected</span>
          <Button variant="danger-ghost" size="sm" onClick={handleBulkDelete} disabled={deleting}>
            <Trash2 className="w-4 h-4" />
            Delete selected
          </Button>
          <Button variant="fe-ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {loading ? (
        isDesktop ? (
          <TableSkeleton rows={8} columns={5} />
        ) : (
          <ListSkeleton rows={8} />
        )
      ) : filteredContacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No contacts found"
          body="Try adjusting your search or import contacts from a CSV."
        />
      ) : isDesktop ? (
        <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-surface-1">
                <TableRow className="border-border-subtle hover:bg-transparent">
                  {canManage && (
                    <TableHead className="w-10">
                      <TapCheckbox
                        checked={allOnPageSelected}
                        onChange={toggleSelectAllOnPage}
                        aria-label="Select all on page"
                      />
                    </TableHead>
                  )}
                  <TableHead className="text-text-secondary">Name</TableHead>
                  <TableHead className="text-text-secondary">Phone</TableHead>
                  <TableHead className="text-text-secondary">Status</TableHead>
                  <TableHead className="text-text-secondary">Added</TableHead>
                  <TableHead className="text-right text-text-secondary">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedContacts.map((contact) => {
                  const name = contactHeadline(contact);
                  const person = contactSecondaryName(contact);
                  const businessType =
                    [person, contact.business_type].filter(Boolean).join(' · ') || '—';
                  const phone = contact.phone_number ?? '—';
                  const category = contact.category ?? 'Cold';
                  const contactStatus = contact.contact_status ?? 'No Contact';
                  const isDnc = contact.dnc;
                  const isSelected = selectedIds.has(contact.id);
                  return (
                    <TableRow
                      key={contact.id}
                      onClick={() => setDetailContact(contact)}
                      className="border-border-subtle hover:bg-surface-2 cursor-pointer group"
                    >
                      {canManage && (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <TapCheckbox
                            checked={isSelected}
                            onChange={() => toggleSelect(contact.id)}
                            aria-label={`Select ${name}`}
                          />
                        </TableCell>
                      )}
                      <TableCell className="max-w-[260px]">
                        <div className="font-medium text-text-primary truncate" title={name}>
                          {name}
                        </div>
                        <div
                          className="text-meta text-text-secondary truncate"
                          title={businessType}
                        >
                          {businessType}
                        </div>
                      </TableCell>
                      <TableCell className="text-body text-text-secondary">{phone}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Pill>{category}</Pill>
                          <Pill>{contactStatus}</Pill>
                          {isDnc && <Pill tone="danger">Do not call</Pill>}
                        </div>
                      </TableCell>
                      <TableCell className="text-meta text-text-secondary whitespace-nowrap">
                        {new Date(contact.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="fe-secondary"
                            size="sm"
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Phone className="w-3.5 h-3.5" />
                            Call
                          </Button>
                          {canManage && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button className="w-8 h-8 rounded-app-sm bg-surface-2 hover:bg-surface-3 flex items-center justify-center text-text-secondary/70 hover:text-text-primary transition-colors">
                                  <MoreVertical className="w-4 h-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={(e) =>
                                    handleDeleteOne(e as unknown as React.MouseEvent, contact.id)
                                  }
                                  disabled={deleting}
                                >
                                  <Trash2 className="w-4 h-4" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {canManage && (
            <div
              className="flex items-center gap-2 text-meta text-text-secondary px-1 pb-1 cursor-pointer"
              onClick={toggleSelectAllOnPage}
            >
              <TapCheckbox
                checked={allOnPageSelected}
                onChange={toggleSelectAllOnPage}
                stopRowClick
              />
              Select all on page
            </div>
          )}
          {paginatedContacts.map((contact) => {
            const name = contactHeadline(contact);
            const person = contactSecondaryName(contact);
            const phone = contact.phone_number ?? '—';
            const category = contact.category ?? 'Cold';
            const contactStatus = contact.contact_status ?? 'No Contact';
            const isDnc = contact.dnc;
            const isSelected = selectedIds.has(contact.id);
            return (
              <div
                key={contact.id}
                onClick={() => setDetailContact(contact)}
                className="flex items-center gap-3 rounded-app-lg border border-border-subtle bg-surface-1 p-3 cursor-pointer"
              >
                {canManage && (
                  <TapCheckbox
                    checked={isSelected}
                    onChange={() => toggleSelect(contact.id)}
                    stopRowClick
                    aria-label={`Select ${name}`}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-text-primary truncate">{name}</div>
                  {person && <div className="text-meta text-text-secondary truncate">{person}</div>}
                  <div className="text-meta text-text-secondary truncate">{phone}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Pill>{category}</Pill>
                    <Pill>{contactStatus}</Pill>
                    {isDnc && <Pill tone="danger">Do not call</Pill>}
                  </div>
                </div>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="w-9 h-9 touch:w-11 touch:h-11 rounded-full bg-accent-to/15 text-accent-to flex items-center justify-center flex-shrink-0"
                  aria-label="Call"
                >
                  <Phone className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!loading && filteredContacts.length > CONTACTS_PER_PAGE && (
        <div className="flex items-center justify-between gap-4 mt-6 py-4 px-2 border-t border-border-subtle">
          <span className="text-meta text-text-secondary">
            Showing {pageStart + 1}–
            {Math.min(pageStart + CONTACTS_PER_PAGE, filteredContacts.length)} of{' '}
            {filteredContacts.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="fe-secondary"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0}
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </Button>
            <span className="text-meta text-text-secondary px-2">
              Page {currentPage + 1} of {totalPages}
            </span>
            <Button
              variant="fe-secondary"
              size="sm"
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage >= totalPages - 1}
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      <ImportContactsModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchContacts}
      />
      <ImportFromGhlModal
        open={ghlModalOpen}
        onClose={() => setGhlModalOpen(false)}
        onSuccess={fetchContacts}
        initialInput={ghlModalAutoSubmit ? (lastGhlImport ?? undefined) : undefined}
        autoSubmit={ghlModalAutoSubmit}
        onImported={setLastGhlImport}
      />
      <AddContactModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onSuccess={fetchContacts}
      />
      <ContactDetailModal
        contact={detailContact}
        open={detailContact != null}
        onClose={() => setDetailContact(null)}
        onNavigateToDialer={onNavigateToDialer}
        onUpdated={(updated) => {
          setDetailContact(updated);
          setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        }}
      />
    </div>
  );
}
