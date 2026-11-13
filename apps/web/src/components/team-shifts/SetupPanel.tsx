import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { updateShiftSettings, type AdminShiftsOverview } from '@/lib/api';
import { InternList } from './InternList';
import { OpenHoursEditor } from './OpenHoursEditor';
import { PowerWindowsEditor } from './PowerWindowsEditor';
import { SettingsForm } from './SettingsForm';
import { SyncHealth } from './SyncHealth';
import { SetupCard, describeSetupError } from './setupUi';

/** Team Shifts → Setup: on/off, open hours, high leverage windows, settings, interns, GHL sync. */
export function SetupPanel({
  overview,
  canManage,
  onChanged,
  onManagePods,
  onOpenIntegrations,
}: {
  overview: AdminShiftsOverview;
  /** Owner/admin: can switch Shifts off and manage pods. Managers can edit the rest. */
  canManage: boolean;
  onChanged: () => void;
  onManagePods?: () => void;
  onOpenIntegrations?: () => void;
}) {
  const [confirmOff, setConfirmOff] = useState(false);
  const [hoursAffected, setHoursAffected] = useState(0);
  const [busy, setBusy] = useState(false);

  const turnOff = async () => {
    setBusy(true);
    try {
      await updateShiftSettings({ enabled: false });
      toast.success('Shifts is off for your team');
      setConfirmOff(false);
      onChanged();
    } catch (e) {
      toast.error(describeSetupError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {canManage && (
        <SetupCard
          title="Shifts"
          description="When Shifts is off, interns don't see the Shifts tab and nothing syncs to GoHighLevel."
        >
          <label className="flex items-center gap-3 text-body text-text-primary">
            <Switch
              checked={overview.settings.enabled}
              onCheckedChange={(v) => !v && setConfirmOff(true)}
              aria-label="Shifts is on"
            />
            Shifts is on for your team
          </label>
        </SetupCard>
      )}
      <OpenHoursEditor
        key={JSON.stringify(overview.openHours)}
        openHours={overview.openHours}
        onSaved={(affected) => {
          setHoursAffected(affected);
          onChanged();
        }}
      />
      {hoursAffected > 0 && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-app-lg border border-warning/30 bg-warning-soft px-4 py-3"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-body text-text-primary">
            {hoursAffected} scheduled {hoursAffected === 1 ? 'shift now falls' : 'shifts now fall'}{' '}
            outside the new open hours.
            <span className="block text-meta text-text-secondary">
              They stay booked and still count, but the Coverage view only shows open hours. Move or
              cancel them from Coverage.
            </span>
          </p>
          <Button variant="fe-ghost" size="sm" onClick={() => setHoursAffected(0)}>
            Dismiss
          </Button>
        </div>
      )}
      <PowerWindowsEditor windows={overview.powerWindows} onSaved={onChanged} />
      <SettingsForm
        key={JSON.stringify(overview.settings)}
        settings={overview.settings}
        onSaved={onChanged}
      />
      <InternList
        members={overview.members}
        canManagePods={canManage}
        onManagePods={onManagePods}
        onSaved={onChanged}
      />
      <SyncHealth
        health={overview.syncHealth}
        onRetried={onChanged}
        onOpenIntegrations={canManage ? onOpenIntegrations : undefined}
      />

      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent className="hd-touch border-border-subtle bg-surface-1 text-text-primary">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn Shifts off?</AlertDialogTitle>
            <AlertDialogDescription className="text-text-secondary">
              Interns lose the Shifts tab and nothing more syncs to GoHighLevel. Existing shifts are
              kept, and you can turn it back on any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void turnOff();
              }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
