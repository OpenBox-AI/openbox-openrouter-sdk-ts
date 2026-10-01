/**
 * What `onApiError` decides when OpenBox Core cannot be reached (network
 * failure, 5xx, a refused redirect, an unparseable answer — anything surfaced as
 * a SoftGovernanceError). Auth failures (401/403) are not outages and always
 * hard-fail; this module is never consulted for them.
 *
 *   - `fail_open` (default): carry on ungoverned.
 *   - `fail_closed`: stop.
 *   - `fail_closed_destructive`: stop only when the operation being governed
 *     changes something outside the process — a database write, a file write,
 *     or a non-idempotent HTTP request. Reads, idempotent HTTP, and events that
 *     carry no span (workflow, tool and model lifecycle events) carry on.
 *
 * Destructiveness is read from the spans on the evaluate payload, as in the
 * base SDK (`openbox-sdk-ts` 5707738).
 *
 * One deliberate difference: a request to an LLM provider (a span with
 * `gen_ai_system` set — OpenRouter itself, or a provider called directly) is
 * NOT destructive even though it is a POST. Sending a prompt changes nothing
 * the agent's governance protects, and classing it as a write would mean a Core
 * outage stops every model call — `fail_closed` in all but name.
 *
 * Known gap, shared with the base SDK: Redis commands (`SET`, `DEL`, `HSET`, …)
 * are not classified, so a Redis write carries on under this mode.
 */

/** The outage policy for a governance call Core could not answer. */
export type OnApiError = 'fail_open' | 'fail_closed' | 'fail_closed_destructive';

const DESTRUCTIVE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Verbs that start a writing database operation. Matched as a prefix so the
 * Mongo method names the SDK records (`INSERTONE`, `UPDATEMANY`, `DELETEONE`,
 * `REPLACEONE`) classify the same as their SQL counterparts.
 */
const DESTRUCTIVE_DB_VERBS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'UPSERT',
  'MERGE',
  'REPLACE',
  'CREATE',
  'DROP',
  'TRUNCATE',
  'ALTER',
  'GRANT',
  'REVOKE',
];

/** Mongo writes whose names do not start with a writing verb. */
const DESTRUCTIVE_DB_OPERATIONS = new Set([
  'BULKWRITE',
  'FINDONEANDUPDATE',
  'FINDONEANDDELETE',
  'FINDONEANDREPLACE',
  'RENAME',
]);

const DESTRUCTIVE_FILE_OPERATIONS = /write|append/i;

/** True when a governance call Core could not answer must stop the operation. */
export function failsClosedOnOutage(onApiError: OnApiError | undefined, payload: unknown): boolean {
  if (onApiError === 'fail_closed') return true;
  if (onApiError === 'fail_closed_destructive') return payloadHasDestructiveSpan(payload);
  return false;
}

/** True if the evaluate payload carries a span for an operation that changes something. */
export function payloadHasDestructiveSpan(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const spans = (payload as { spans?: unknown }).spans;
  if (!Array.isArray(spans)) return false;
  return spans.some(
    (span) => typeof span === 'object' && span !== null && isDestructiveSpan(span as Record<string, unknown>),
  );
}

export function isDestructiveSpan(span: Record<string, unknown>): boolean {
  switch (span.hook_type) {
    case 'http_request': {
      // A model call is not a write — see the module comment.
      if (span.gen_ai_system != null) return false;
      const method = span.http_method;
      return typeof method === 'string' && DESTRUCTIVE_HTTP_METHODS.has(method.toUpperCase());
    }
    case 'db_query': {
      const op = span.db_operation;
      if (typeof op !== 'string') return false;
      const upper = op.toUpperCase();
      return DESTRUCTIVE_DB_OPERATIONS.has(upper) || DESTRUCTIVE_DB_VERBS.some((verb) => upper.startsWith(verb));
    }
    case 'file_operation': {
      const op = span.file_operation;
      if (typeof op === 'string' && DESTRUCTIVE_FILE_OPERATIONS.test(op)) return true;
      // Write, append and read-write modes: w, a, r+, w+, a+.
      const mode = span.file_mode;
      return typeof mode === 'string' && /[wa+]/i.test(mode);
    }
    default:
      return false;
  }
}
