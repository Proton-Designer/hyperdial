// TASK-N1 fix-forward (eng1 review, item 4): the exact bug class that made
// private.has_available_dial_number/private.pick_and_reserve_dial_number unreachable via
// supabase.rpc(...) -- a name the engine calls that PostgREST can never resolve against public/
// graphql_public -- had no test coverage at all. FakeDb-backed tests mock .rpc() regardless of
// schema, so they can never catch this. This is a cheap, real-filesystem guard instead: every
// literal rpc('<name>', ...) call in the (non-test) function source must have a matching
// `create [or replace] function public.<name>(` somewhere in supabase/migrations -- the one
// schema PostgREST's .rpc() actually resolves against (config.toml's [api].schemas).
//
// Deliberately excludes *.test.ts (fixture/mock rpc names in tests don't need a real function)
// and only checks that the name exists in *some* public function -- it does not check arity or
// argument names, which would require a real Postgres parse.

const REPO_ROOT = new URL('../../../', import.meta.url);
const FUNCTIONS_DIR = new URL('supabase/functions/', REPO_ROOT);
const MIGRATIONS_DIR = new URL('supabase/migrations/', REPO_ROOT);

async function collectFiles(dir: URL, suffix: string): Promise<URL[]> {
  const out: URL[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const childUrl = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir);
    if (entry.isDirectory) {
      out.push(...(await collectFiles(childUrl, suffix)));
    } else if (entry.name.endsWith(suffix)) {
      out.push(childUrl);
    }
  }
  return out;
}

const RPC_CALL_RE = /\.rpc\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
const PUBLIC_FUNCTION_DEF_RE =
  /create\s+(?:or\s+replace\s+)?function\s+public\.([a-zA-Z0-9_]+)\s*\(/gi;

Deno.test('every rpc() call name resolves to a public.* migration function', async () => {
  const sourceFiles = (await collectFiles(FUNCTIONS_DIR, '.ts')).filter(
    (f) => !f.pathname.endsWith('.test.ts')
  );

  const calledNames = new Set<string>();
  for (const file of sourceFiles) {
    const text = await Deno.readTextFile(file);
    for (const match of text.matchAll(RPC_CALL_RE)) {
      calledNames.add(match[1]);
    }
  }

  const migrationFiles = await collectFiles(MIGRATIONS_DIR, '.sql');
  const definedNames = new Set<string>();
  for (const file of migrationFiles) {
    const text = await Deno.readTextFile(file);
    for (const match of text.matchAll(PUBLIC_FUNCTION_DEF_RE)) {
      definedNames.add(match[1]);
    }
  }

  const missing = [...calledNames].filter((name) => !definedNames.has(name)).sort();
  if (missing.length > 0) {
    throw new Error(
      `rpc() called with no matching "create function public.<name>(" in supabase/migrations: ${missing.join(', ')}`
    );
  }
});
