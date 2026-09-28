# HyperDial documentation

Human-facing documentation. For AI-agent context, start at
[`../CLAUDE.md`](../CLAUDE.md) and [`../.brain/`](../.brain/).

## Guides — task-oriented walkthroughs

| Guide                                                                         | Read it when                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [deploy-parallel-dialer.md](guides/deploy-parallel-dialer.md)                 | Standing the whole backend up: migrations, functions, secrets                                                                            |
| [deploy-edge-functions.md](guides/deploy-edge-functions.md)                   | Deploying or redeploying Supabase Edge Functions                                                                                         |
| [telnyx-call-control-setup.md](guides/telnyx-call-control-setup.md)           | Configuring Telnyx — **read this before touching connection IDs**                                                                        |
| [csv-import.md](guides/csv-import.md)                                         | Working on contact import and column mapping                                                                                             |
| [inviting-and-assigning-interns.md](guides/inviting-and-assigning-interns.md) | Inviting an intern and setting up their per-campaign caller ID/assignment                                                                |
| [intern-quick-start.md](guides/intern-quick-start.md)                         | You ARE the intern — signing in and dialing, not managing                                                                                |
| [running-your-team.md](guides/running-your-team.md)                           | You're an owner/admin/manager — roles, distribution, supervision, coaching, goals, the shared inbox, and everything else Mission 5 added |

## Reference — lookup material

| Document                                                       | Contains                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| [environment-variables.md](reference/environment-variables.md) | Every env var, where it's read, and what breaks without it |
| [edge-functions.md](reference/edge-functions.md)               | Function inventory, URLs, and auth model                   |

## Validation

| Document                                                                | Contains                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [launch-live-test.md](validation/launch-live-test.md)                   | **The** ordered live-verification runbook — run this before launch |
| [parallel-dialer-checklist.md](validation/parallel-dialer-checklist.md) | Superseded — points to launch-live-test.md                         |

## Other

- [../CONTRIBUTING.md](../CONTRIBUTING.md) — conventions and workflow
