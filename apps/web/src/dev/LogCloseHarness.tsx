import { LogCloseModal } from '@/components/dialer/LogCloseModal';

/**
 * Dev-only fixture harness for TASK-H03: LogCloseModal with fixture prefill/categories/submit (its test overrides),
 * so the form can be checked with no session, DB or edge function. `?dev_log_close=1` plus
 * `&scenario=` one of: `normal` (default), `nocats` (empty category list), `slow` (categories load slowly),
 * `fail` (first submit fails, second succeeds), `badprefill` (prefill load fails), `notconfigured` / `failed`
 * (the delivery note shown on success). main.tsx only imports this behind `import.meta.env.DEV`.
 */
export function LogCloseHarness() {
  const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'normal';
  let submits = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return (
    <div className="min-h-screen bg-surface-0 p-6 text-text-primary">
      <p>Log close harness — scenario: {scenario}</p>
      <LogCloseModal
        contactId="00000000-0000-4000-8000-000000000001"
        name="Sparkle Window Cleaning"
        phone="+15125550100"
        onClose={() => window.location.reload()}
        loadPrefill={async () => {
          if (scenario === 'badprefill') throw new Error('permission denied');
          return {
            businessName: 'Sparkle Window Cleaning LLC',
            ownerName: 'Pat Doe',
            phone: '+15125550100',
            email: null,
            city: null,
            address: '12 Main St, Austin, TX 78701',
          };
        }}
        loadCategories={async () => {
          if (scenario === 'slow') await wait(60_000);
          return scenario === 'nocats'
            ? []
            : [
                'Window Cleaning',
                'Gutter Cleaning',
                'Pressure Washing',
                'Lawn Care',
                'House Cleaning',
              ];
        }}
        submitClose={async () => {
          await wait(600);
          submits += 1;
          if (scenario === 'fail' && submits === 1) throw new Error('Could not save the close');
          return {
            closeId: 'c1',
            deduped: false,
            deliveryStatus:
              scenario === 'notconfigured'
                ? 'not_configured'
                : scenario === 'failed'
                  ? 'failed'
                  : 'sent',
          };
        }}
      />
    </div>
  );
}
