import { corsHeaders } from './cors.ts';

/**
 * Parses a request body as JSON, or returns a ready-to-send 400 Response when the body is
 * not valid JSON. Hoist this call OUT of any broader try/catch that maps business-logic
 * error-message substrings to specific status codes: a JSON SyntaxError matches none of
 * those substrings and would otherwise fall through to a raw 500 with the parser's own
 * exception text (B1-011, all 7 dialer-session-* write endpoints).
 */
export async function readJsonBody<T>(
  req: Request
): Promise<{ body: T; errorResponse?: undefined } | { body?: undefined; errorResponse: Response }> {
  try {
    return { body: (await req.json()) as T };
  } catch {
    return {
      errorResponse: new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }
}
