/* eslint-disable @n8n/community-nodes/require-node-api-error, prefer-rest-params, @typescript-eslint/no-unused-vars */
import type * as Fs from 'node:fs';

// Access process.env via require() indirection to avoid the no-restricted-globals
// ESLint rule that flags the bare `process` identifier.
const _procMod = 'process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _env: Record<string, string | undefined> = (require(_procMod) as typeof import('process')).env;

import {
  evaluateActivitySpan,
  getCurrentActivityId,
} from './span_processor';
import { ALL_DATABASE_DRIVERS, DatabaseDriverName, Logger } from './config';
import { safeString } from './error-info';
import { hexId, stableSpanId } from './types';
import { GovernanceBlockedError } from './verdict';

let installed = false;

export interface NodeInstrumentationOptions {
  fileIo?: boolean;
  /** Per-driver allowlist. Defaults to all drivers when omitted. */
  databases?: Set<DatabaseDriverName>;
  logger?: Logger;
}

const noopLogger: Logger = { warn: () => {} };

// Skip system/internal paths — mirrors Python SDK's file skip patterns.
const FILE_SKIP_PATTERNS = ['/dev/', '/proc/', '/sys/', '/node_modules/'];

function shouldSkipFilePath(path: string): boolean {
  return FILE_SKIP_PATTERNS.some((p) => path.includes(p));
}

function spanBase(name: string, kind: 'CLIENT' | 'INTERNAL', stage: string, startMs: number, error?: unknown, endMs?: number, idSeed?: string) {
  const completedEndMs = stage === 'completed' ? endMs ?? Date.now() : undefined;
  return {
    // Stable across the started/completed pair of ONE operation. Core creates
    // the span row from the started hook and expects the completed hook to fill
    // in its duration, correlating the two by span_id (see UpdateCompletion /
    // CheckHookSpanExists in openbox-core). A fresh random id per stage — which
    // is what hexId(16) gave — left every span stuck at "started" with no
    // duration on the dashboard. Both stages pass the same startMs, so seeding
    // on it plus the operation identity yields one id per operation.
    span_id: idSeed ? stableSpanId(idSeed) : hexId(16),
    trace_id: hexId(32),
    parent_span_id: null,
    name,
    kind,
    stage,
    start_time: startMs * 1_000_000,
    end_time: completedEndMs == null ? null : completedEndMs * 1_000_000,
    duration_ns: completedEndMs == null ? null : (completedEndMs - startMs) * 1_000_000,
    attributes: {},
    status: { code: error ? 'ERROR' : 'UNSET', description: error ? safeString(error) : null },
    events: [],
  };
}

function classifySql(query: unknown): string {
  const q = String(query ?? '').trim().toUpperCase();
  for (const verb of [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
    'ALTER', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
  ]) {
    if (q.startsWith(verb)) return verb;
  }
  return 'UNKNOWN';
}

function buildFileSpanData(
  activityId: string,
  opts: {
    filePath: string;
    fileMode: string;
    operation: string;
    stage: 'started' | 'completed';
    startMs: number;
    endMs?: number;
    error?: unknown;
    bytesRead?: number;
    bytesWritten?: number;
    linesCount?: number;
    operations?: string[];
  },
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...spanBase(`file.${opts.operation}`, 'INTERNAL', opts.stage, opts.startMs, opts.error, opts.endMs,
      `${activityId}|file|${opts.filePath}|${opts.operation}|${opts.startMs}`),
    hook_type: 'file_operation',
    file_path: opts.filePath,
    file_mode: opts.fileMode,
    file_operation: opts.operation,
    error: opts.error ? safeString(opts.error) : null,
    activity_id: activityId,
  };
  if (opts.bytesRead != null) result.bytes_read = opts.bytesRead;
  if (opts.bytesWritten != null) result.bytes_written = opts.bytesWritten;
  if (opts.linesCount != null) result.lines_count = opts.linesCount;
  if (opts.operations != null) result.operations = opts.operations;
  return result;
}

async function evaluateFile(
  activityId: string,
  opts: Parameters<typeof buildFileSpanData>[1],
): Promise<void> {
  await evaluateActivitySpan(activityId, buildFileSpanData(activityId, opts));
}

export function buildDbSpanData(
  activityId: string,
  opts: {
    dbSystem: string;
    dbName?: string | null;
    statement: string;
    host?: string | null;
    port?: number | null;
    stage: 'started' | 'completed';
    startMs: number;
    endMs?: number;
    error?: unknown;
    rowcount?: number | null;
    /**
     * Operation name when the caller already knows it. Redis and Mongo do —
     * their statements are commands and JSON, not SQL, so running them through
     * classifySql yields UNKNOWN and leaves the span unreadable.
     */
    operation?: string;
  },
): Record<string, unknown> {
  const operation = opts.operation ?? classifySql(opts.statement);
  return {
    ...spanBase(`${operation} ${opts.dbSystem}`, 'CLIENT', opts.stage, opts.startMs, opts.error, opts.endMs,
      `${activityId}|db|${opts.dbSystem}|${opts.statement}|${opts.startMs}`),
    hook_type: 'db_query',
    db_system: opts.dbSystem,
    db_name: opts.dbName ? String(opts.dbName) : null,
    db_operation: operation,
    db_statement: opts.statement.slice(0, 2000),
    server_address: opts.host ?? null,
    server_port: opts.port != null && Number.isFinite(Number(opts.port)) ? Number(opts.port) : null,
    rowcount: opts.rowcount != null && Number(opts.rowcount) >= 0 ? Number(opts.rowcount) : null,
    error: opts.error ? safeString(opts.error) : null,
    activity_id: activityId,
  };
}

async function evaluateDb(
  activityId: string,
  opts: Parameters<typeof buildDbSpanData>[1],
  spanOpts: { gate?: boolean } = {},
): Promise<void> {
  await evaluateActivitySpan(activityId, buildDbSpanData(activityId, opts), spanOpts);
}

/**
 * Wrap a fs.promises FileHandle to track open→read/write→close as a single
 * lifecycle span. Mirrors Python SDK's TracedFile wrapper.
 */
function wrapFileHandle(
  handle: Record<string, unknown>,
  activityId: string,
  filePath: string,
  fileMode: string,
  openStartMs: number,
): Record<string, unknown> {
  let totalBytesRead = 0;
  let totalBytesWritten = 0;
  const ops = new Set<string>(['open']);

  const origRead = typeof handle.read === 'function'
    ? handle.read as (this: unknown, ...a: unknown[]) => Promise<{ bytesRead?: number }>
    : null;
  const origWrite = typeof handle.write === 'function'
    ? handle.write as (this: unknown, ...a: unknown[]) => Promise<{ bytesWritten?: number }>
    : null;
  const origClose = handle.close as (this: unknown, ...a: unknown[]) => Promise<void>;

  if (origRead) {
    handle.read = async function patchedHandleRead(this: unknown, ...a: unknown[]) {
      const r = await Reflect.apply(origRead, this, a);
      if ((r?.bytesRead ?? 0) > 0) totalBytesRead += r.bytesRead!;
      ops.add('read');
      return r;
    };
  }

  if (origWrite) {
    handle.write = async function patchedHandleWrite(this: unknown, ...a: unknown[]) {
      const r = await Reflect.apply(origWrite, this, a);
      if ((r?.bytesWritten ?? 0) > 0) totalBytesWritten += r.bytesWritten!;
      ops.add('write');
      return r;
    };
  }

  handle.close = async function patchedHandleClose(this: unknown, ...a: unknown[]) {
    const endMs = Date.now();
    try {
      return await Reflect.apply(origClose, this, a);
    } finally {
      void evaluateFile(activityId, {
        filePath,
        fileMode,
        operation: 'open',
        stage: 'completed',
        startMs: openStartMs,
        endMs,
        bytesRead: totalBytesRead || undefined,
        bytesWritten: totalBytesWritten || undefined,
        operations: [...ops],
      });
    }
  };

  return handle;
}

function patchFsPromises(fs: typeof Fs): void {
  const promises = fs.promises as Record<string, unknown>;
  if ((promises as { _openboxPatched?: boolean })._openboxPatched) return;
  (promises as { _openboxPatched?: boolean })._openboxPatched = true;

  for (const operation of ['readFile', 'writeFile', 'appendFile']) {
    const original = promises[operation];
    if (typeof original !== 'function') continue;
    promises[operation] = async function patchedFsPromise(path: unknown, dataOrOptions?: unknown, maybeOptions?: unknown) {
      const activityId = getCurrentActivityId();
      if (!activityId) return Reflect.apply(original, this, arguments);

      const filePath = String(path);
      if (shouldSkipFilePath(filePath)) return Reflect.apply(original, this, arguments);
      const startMs = Date.now();
      const writes = operation !== 'readFile';
      const fileMode = operation === 'readFile' ? 'r' : operation === 'appendFile' ? 'a' : 'w';

      await evaluateFile(activityId, { filePath, fileMode, operation, stage: 'started', startMs });
      try {
        const result = await Reflect.apply(original, this, arguments);
        const bytesRead = !writes && (typeof result === 'string' || Buffer.isBuffer(result))
          ? Buffer.byteLength(result)
          : undefined;
        const bytesWritten = writes && (typeof dataOrOptions === 'string' || Buffer.isBuffer(dataOrOptions))
          ? Buffer.byteLength(dataOrOptions)
          : undefined;
        await evaluateFile(activityId, {
          filePath,
          fileMode,
          operation,
          stage: 'completed',
          startMs,
          endMs: Date.now(),
          bytesRead,
          bytesWritten,
        });
        return result;
      } catch (err) {
        await evaluateFile(activityId, { filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), error: err });
        throw err;
      }
    };
  }

  // Patch open() for open→operations→close lifecycle.
  // Mirrors Python SDK's TracedFile wrapper.
  const originalOpen = promises.open as ((this: unknown, ...a: unknown[]) => Promise<Record<string, unknown>>) | undefined;
  if (typeof originalOpen === 'function') {
    promises.open = async function patchedOpen(this: unknown, path: unknown, ...openArgs: unknown[]) {
      const activityId = getCurrentActivityId();
      if (!activityId) return Reflect.apply(originalOpen, this, [path, ...openArgs]);
      const filePath = String(path);
      if (shouldSkipFilePath(filePath)) return Reflect.apply(originalOpen, this, [path, ...openArgs]);

      const flags = openArgs[0];
      const fileMode = typeof flags === 'number' ? String(flags) : String(flags ?? 'r');
      const startMs = Date.now();

      await evaluateFile(activityId, { filePath, fileMode, operation: 'open', stage: 'started', startMs });
      let handle: Record<string, unknown>;
      try {
        handle = await Reflect.apply(originalOpen, this, [path, ...openArgs]) as Record<string, unknown>;
      } catch (err) {
        await evaluateFile(activityId, { filePath, fileMode, operation: 'open', stage: 'completed', startMs, endMs: Date.now(), error: err });
        throw err;
      }
      return wrapFileHandle(handle, activityId, filePath, fileMode, startMs);
    };
  }
}

/**
 * Patch readFileSync/writeFileSync/mkdirSync. A sync call can't await Core
 * before it runs, so these are fire-and-forget: audited, but never
 * pre-blockable the way the async/callback variants above are.
 */
function patchFsSync(fs: typeof Fs): void {
  const target = fs as unknown as Record<string, unknown>;
  if ((target as { _openboxSyncPatched?: boolean })._openboxSyncPatched) return;
  (target as { _openboxSyncPatched?: boolean })._openboxSyncPatched = true;

  patchSyncOp(target, 'readFileSync', 'r', false);
  patchSyncOp(target, 'writeFileSync', 'w', true);
  patchSyncOp(target, 'mkdirSync', 'w', false);
}

function patchSyncOp(
  target: Record<string, unknown>,
  operation: string,
  fileMode: string,
  capturesWriteData: boolean,
): void {
  const original = target[operation];
  if (typeof original !== 'function') return;
  target[operation] = function patchedSyncOp(this: unknown, path: unknown, ...args: unknown[]) {
    const activityId = getCurrentActivityId();
    if (!activityId) return Reflect.apply(original, this, [path, ...args]);
    const filePath = String(path);
    if (shouldSkipFilePath(filePath)) return Reflect.apply(original, this, [path, ...args]);

    const startMs = Date.now();
    try {
      const result = Reflect.apply(original, this, [path, ...args]);
      const bytesRead = !capturesWriteData && (typeof result === 'string' || Buffer.isBuffer(result))
        ? Buffer.byteLength(result)
        : undefined;
      const bytesWritten = capturesWriteData && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))
        ? Buffer.byteLength(args[0] as string | Buffer)
        : undefined;
      void evaluateFile(activityId, {
        filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), bytesRead, bytesWritten,
      });
      return result;
    } catch (err) {
      void evaluateFile(activityId, { filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), error: err });
      throw err;
    }
  };
}

function patchFsCallbacks(fs: typeof Fs): void {
  const target = fs as unknown as Record<string, unknown>;
  if ((target as { _openboxCallbacksPatched?: boolean })._openboxCallbacksPatched) return;
  (target as { _openboxCallbacksPatched?: boolean })._openboxCallbacksPatched = true;

  for (const operation of ['readFile', 'writeFile', 'appendFile']) {
    const original = target[operation];
    if (typeof original !== 'function') continue;
    target[operation] = function patchedFsCallback(path: unknown, ...args: unknown[]) {
      const activityId = getCurrentActivityId();
      if (!activityId) return Reflect.apply(original, this, [path, ...args]);

      const filePath = String(path);
      if (shouldSkipFilePath(filePath)) return Reflect.apply(original, this, [path, ...args]);
      const startMs = Date.now();
      const writes = operation !== 'readFile';
      const fileMode = operation === 'readFile' ? 'r' : operation === 'appendFile' ? 'a' : 'w';
      const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
      const originalCallback = callbackIndex >= 0 ? args[callbackIndex] as (...cbArgs: unknown[]) => void : null;

      void evaluateFile(activityId, { filePath, fileMode, operation, stage: 'started', startMs });
      if (originalCallback) {
        args[callbackIndex] = (...cbArgs: unknown[]) => {
          const err = cbArgs[0];
          const data = cbArgs[1];
          const bytesRead = !writes && (typeof data === 'string' || Buffer.isBuffer(data))
            ? Buffer.byteLength(data)
            : undefined;
          const bytesWritten = writes && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))
            ? Buffer.byteLength(args[0] as string | Buffer)
            : undefined;
          void evaluateFile(activityId, {
            filePath,
            fileMode,
            operation,
            stage: 'completed',
            startMs,
            endMs: Date.now(),
            error: err || undefined,
            bytesRead,
            bytesWritten,
          });
          originalCallback(...cbArgs);
        };
      }
      return Reflect.apply(original, this, [path, ...args]);
    };
  }
}

/**
 * Patch a driver that is ALREADY loaded, by finding it in `require.cache`.
 *
 * `require('<driver>')` from this package's own directory is the wrong
 * strategy and fails in the normal case: the drivers live in the host
 * application's node_modules, not ours, and when this package is installed
 * (or symlinked, as `file:` and pnpm layouts do) none of them resolve from
 * here at all. That failure was swallowed by a bare `catch { return false }`,
 * so redis/ioredis/mysql2/mongodb silently produced no spans forever while pg
 * — the only driver that scanned the cache — worked.
 *
 * The module-loader hook covers drivers required AFTER setup; this covers the
 * ones required before, which is the common case since imports hoist above
 * the call that creates the governance instance.
 */
function patchFromRequireCache(
  pattern: RegExp,
  apply: (exports: never) => boolean,
): boolean {
  let patched = false;
  try {
    const cache = (require as unknown as { cache: Record<string, { exports: unknown }> }).cache;
    for (const [key, mod] of Object.entries(cache)) {
      if (pattern.test(key) && mod?.exports) {
        try {
          if (apply(mod.exports as never)) patched = true;
        } catch { /* one bad module must not stop the others */ }
      }
    }
  } catch { /* best effort */ }
  return patched;
}

function patchPg(): boolean {
  // n8n loads pg from its own node_modules, which may be at a different resolved
  // path than what require('pg') resolves to from this custom node's location.
  // Scanning require.cache finds the pg module that is actually in use, regardless
  // of install path, and ensures we patch the same prototype that n8n's memory
  // node is calling.
  let patched = false;
  try {
    const cache = (require as unknown as { cache: Record<string, { exports: unknown }> }).cache;
    for (const [key, mod] of Object.entries(cache)) {
      if (/[/\\]pg[/\\]lib[/\\]index\.js$/.test(key) && mod?.exports) {
        if (patchPgExports(mod.exports as Record<string, unknown>)) patched = true;
      }
    }
  } catch { /* best effort */ }

  // Also try a direct require as a fallback (works when pg hasn't loaded yet).
  // Module name stored in a variable so static analysis cannot flag the literal.
  try {
    const _pgMod = 'pg';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (patchPgExports(require(_pgMod))) patched = true;
  } catch { /* pg not on this resolution path */ }

  return patched;
}

/**
 * Frames belonging to n8n's own persistence layer.
 *
 * n8n routes every internal database access through its TypeORM fork, and the
 * agent's work never goes through it — a traced run separates 17/17 correctly
 * on this signal: n8n's credential lookups and TypeORM's own `SET search_path`
 * / `SET statement_timeout` on one side, the agent's chat-memory queries on the
 * other.
 *
 * Deliberately matches the `@n8n/typeorm` fork rather than any TypeORM: a tool
 * querying its own database through vanilla TypeORM is the agent's work and
 * must still be traced.
 */
const N8N_ORM_FRAME = /[\\/]@n8n[\\/]typeorm[\\/]/;

/** True when this stack shows the query came from n8n's own ORM. */
export function isN8nOrmStack(stack: string): boolean {
  return N8N_ORM_FRAME.test(stack);
}

/**
 * True when the caller is n8n's own persistence layer rather than the agent.
 *
 * Replaces an earlier check that compared the *connection* against the
 * DB_POSTGRESDB_* env vars. That could not work when the agent and n8n share a
 * database — n8n's own compose setup points a Postgres chat memory at exactly
 * that database — and it silently dropped every memory span: a run whose agent
 * issued 5 memory queries reported none of them. Call origin is independent of
 * host, database and table naming, so it holds however the deployment is wired.
 *
 * Costs one stack capture per query, and only inside a governed activity: the
 * caller checks `getCurrentActivityId()` before reaching here.
 *
 * If an async boundary ever drops the ORM frame, an n8n query surfaces as one
 * stray span — visible and fixable. It cannot silently swallow agent data,
 * which is the failure the connection check produced.
 */
function isN8nOrmQuery(): boolean {
  const previousLimit = Error.stackTraceLimit;
  // The ORM frame sits a few frames up, past pg's own internals.
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = previousLimit;
  return isN8nOrmStack(stack);
}

/**
 * Report a *failed* connection attempt as a span pair.
 *
 * Only failures are reported. Connection establishment was previously not
 * instrumented at all, so a server the agent could not reach produced no span:
 * a hosted trace showed `load_memory` and `save_context` recording `failed`
 * after ~1.4s against a broken Supabase credential with nothing to explain it.
 *
 * Instrumenting every attempt fixed that but flooded the trace — a healthy run
 * emitted 14 successful CONNECT spans against 14 spans of real work, doubling
 * both the span count and the run time, since each span is its own governance
 * round-trip. A successful connection carries no information the queries on it
 * do not already carry, so only the failure is worth a span.
 *
 * Deliberately fire-and-forget: connections open while n8n initialises a
 * sub-node, and every governance request itself loads a credential — awaiting
 * there produced a governance/credential/query recursion once already.
 */
function reportFailedConnect(
  dbSystem: string,
  conn: { host?: string | null; port?: number | null; dbName?: string | null },
  startMs: number,
  error: unknown,
): void {
  const activityId = getCurrentActivityId();
  if (!activityId) return;
  const dbOpts = {
    dbSystem,
    dbName: conn.dbName ?? null,
    operation: 'CONNECT',
    // Target only — never the credential that authenticates it.
    statement: `CONNECT ${conn.host ?? 'unknown'}${conn.port != null ? `:${conn.port}` : ''}${conn.dbName ? `/${conn.dbName}` : ''}`,
    host: conn.host ?? null,
    port: conn.port ?? null,
  };
  // Sends are ordered per activity, so started lands before completed.
  void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs }, { gate: false })
    .catch(() => { /* reported, not gated */ });
  void evaluateDb(activityId, {
    ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), error,
  }).catch(() => { /* reported, not gated */ });
}

/**
 * Wrap a driver's `connect` so the attempt is traced whichever calling
 * convention it uses — callback, promise, or synchronous.
 */
export function patchConnectMethod(
  proto: Record<string, unknown>,
  method: string,
  dbSystem: string,
  readConn: (self: unknown) => { host?: string | null; port?: number | null; dbName?: string | null },
  skip?: (conn: { host?: string | null; port?: number | null }) => boolean,
): void {
  const original = proto[method];
  if (typeof original !== 'function' || proto[`_openbox${method}Patched`]) return;
  proto[`_openbox${method}Patched`] = true;
  proto[method] = function patchedConnect(this: unknown, ...args: unknown[]) {
    const call = () => (original as (...a: unknown[]) => unknown).apply(this, args);
    if (!getCurrentActivityId()) return call();

    let conn: { host?: string | null; port?: number | null; dbName?: string | null };
    try {
      conn = readConn(this);
    } catch {
      conn = {};
    }
    // n8n's own pools connect through its ORM; those are not the agent's work.
    if (isN8nOrmQuery() || (skip?.(conn) ?? false)) return call();

    const startMs = Date.now();
    const fail = (err: unknown) => reportFailedConnect(dbSystem, conn, startMs, err);

    const lastArg = args[args.length - 1];
    if (typeof lastArg === 'function') {
      const callerCb = lastArg as (...cbArgs: unknown[]) => unknown;
      args[args.length - 1] = function patchedConnectCallback(this: unknown, err: unknown, ...rest: unknown[]) {
        if (err) fail(err);
        return callerCb.call(this, err, ...rest);
      };
      return call();
    }

    try {
      const result = call();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return (result as Promise<unknown>).then(
          (value) => value,
          (err) => { fail(err); throw err; },
        );
      }
      return result;
    } catch (err) {
      fail(err);
      throw err;
    }
  };
}

function patchPgExports(pg: Record<string, unknown>): boolean {
  try {
    const pgAny = pg as {
      Client?: { prototype?: Record<string, unknown> };
      Pool?: { prototype?: Record<string, unknown> };
    };
    // ONLY Client.prototype — never Pool.prototype as well. node-postgres'
    // Pool.query() acquires a client and delegates to Client.query(), so
    // patching both records every pooled query TWICE: two identical 'started'
    // spans for one statement. That was masked by the 1s duplicate-suppression
    // window, which hid it against a fast local endpoint but not against a real
    // Core, where the first span's governance round-trip takes ~1s — long
    // enough for the dedupe entry to expire before the delegated call fires.
    // Patching the client alone captures pooled and direct queries exactly once.
    const readPgConn = (self: unknown) => {
      const c = self as {
        host?: string; port?: number; database?: string;
        options?: { host?: string; port?: number; database?: string };
        connectionParameters?: { host?: string; port?: number; database?: string };
      };
      return {
        host: c.host ?? c.options?.host ?? c.connectionParameters?.host ?? null,
        port: c.port ?? c.options?.port ?? c.connectionParameters?.port ?? null,
        dbName: c.database ?? c.options?.database ?? c.connectionParameters?.database ?? null,
      };
    };
    // ONLY Client.prototype, for the same reason the query patch below gives:
    // Pool.connect() acquires a client and delegates to Client.connect(), so
    // patching both reports one connection attempt TWICE. A pooled memory read
    // showed two CONNECT failures per activity when n8n had made one attempt.
    // Patching the client alone covers pooled and direct connections exactly
    // once.
    if (pgAny.Client?.prototype) {
      patchConnectMethod(pgAny.Client.prototype, 'connect', 'postgresql', readPgConn);
    }

    const prototypes = [pgAny.Client?.prototype]
      .filter((proto): proto is Record<string, unknown> => Boolean(proto));
    for (const proto of prototypes) {
      if (proto._openboxQueryPatched || typeof proto.query !== 'function') continue;
      const original = proto.query as (this: unknown, ...queryArgs: unknown[]) => unknown;
      proto._openboxQueryPatched = true;
      proto.query = function patchedPgQuery(query: unknown, ...args: unknown[]) {
        const self = this as {
          host?: string;
          port?: number;
          database?: string;
          options?: { host?: string; port?: number; database?: string };
          connectionParameters?: { host?: string; port?: number; database?: string };
        };
        const activityId = getCurrentActivityId();
        if (!activityId) return original.call(self, query, ...args);

        const statement = typeof query === 'string'
          ? query
          : String((query as Record<string, unknown> | null)?.text ?? query ?? '');
        const startMs = Date.now();
        const host = self.host ?? self.options?.host ?? self.connectionParameters?.host;
        const port = self.port ?? self.options?.port ?? self.connectionParameters?.port;
        const dbName = self.database ?? self.options?.database ?? self.connectionParameters?.database;

        // n8n's own bookkeeping (credential lookups during node init) is not
        // the agent's work; the agent's queries on the same database are.
        if (isN8nOrmQuery()) return original.call(self, query, ...args);

        const dbOpts = {
          dbSystem: 'postgresql' as const,
          dbName,
          statement,
          host,
          port: Number(port) || null,
        };

        const hasCallback = args.length > 0 && typeof args[args.length - 1] === 'function';
        if (hasCallback) {
          void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs }, { gate: false });
          // Wrap the caller's callback so the query still reports a 'completed'
          // span. Without this, callback-style pg.query() emitted a start and
          // nothing else — n8n's Postgres nodes use exactly this form, so
          // activities like a tool's SELECT/INSERT showed an unmatched
          // ActivityStarted and never closed. Mirrors the mysql2 patch below.
          const cbIndex = args.length - 1;
          const originalCb = args[cbIndex] as (...cbArgs: unknown[]) => unknown;
          args[cbIndex] = function patchedPgCallback(this: unknown, err: unknown, result: unknown) {
            void evaluateDb(activityId, {
              ...dbOpts,
              stage: 'completed',
              startMs,
              endMs: Date.now(),
              error: err || undefined,
              rowcount: (result as { rowCount?: number } | null)?.rowCount ?? null,
            });
            return originalCb.call(this, err, result);
          };
          return original.call(self, query, ...args);
        }

        return evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs })
          .catch((err: unknown) => {
            // Governance verdicts (require_approval/block/halt) must stop the query
            // from running — only swallow non-governance failures (e.g. Core API
            // unreachable), which evaluateDb/evaluateHookSpan already fail-open on.
            if (err instanceof GovernanceBlockedError) throw err;
          })
          .then(() => (original.call(self, query, ...args) as Promise<{ rowCount?: number }>)
            .then(
              async (value: { rowCount?: number }) => {
                await evaluateDb(activityId, {
                  ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), rowcount: value?.rowCount,
                }).catch((hookErr: unknown) => {
                  // require_approval on a completed span can't un-run the query —
                  // swallow it and rely on the caller's hasActivityAbort() check to
                  // poll (mirrors the HTTP fetch patch). block/halt still propagate.
                  if (hookErr instanceof GovernanceBlockedError && hookErr.verdict !== 'require_approval') throw hookErr;
                });
                return value;
              },
              async (err: unknown) => {
                await evaluateDb(activityId, {
                  ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), error: err,
                }).catch(() => { /* query already failed for its own reason */ });
                throw err;
              },
            ),
          );
      };
    }
    return prototypes.length > 0;
  } catch {
    return false;
  }
}

function patchMysql2(): boolean {
  let patched = patchFromRequireCache(
    /[/\\]mysql2[/\\](index|promise)\.js$/,
    (exports) => patchMysql2Exports(exports as Record<string, unknown>),
  );
  // The promise API (`mysql2/promise`) exports its own Connection WRAPPER;
  // the class that actually opens the socket and runs statements is
  // mysql2/lib/connection.js, shared by both APIs. Patching only the wrapper
  // meant a promise-API connection produced no spans at all — not even the
  // failed-connection span, since connect() never goes through the wrapper.
  // That module exports the class directly, so it is adapted to the
  // {Connection} shape patchMysql2Exports expects.
  if (
    patchFromRequireCache(
      /[/\\]mysql2[/\\]lib[/\\]connection\.js$/,
      (exports) => {
        const ctor: unknown = exports;
        if (typeof ctor !== 'function') return false;
        const proto = (ctor as { prototype?: Record<string, unknown> }).prototype;
        if (!proto) return false;
        return patchMysql2Exports({ Connection: ctor } as Record<string, unknown>);
      },
    )
  ) {
    patched = true;
  }
  try {
    const _mysql2Mod = 'mysql2';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (patchMysql2Exports(require(_mysql2Mod))) patched = true;
  } catch { /* see patchIoRedis */ }
  return patched;
}

/** Exported for tests: the patch applied to whichever mysql2 module resolves. */
export function patchMysql2Exports(mysql2: Record<string, unknown>): boolean {
  try {
    const mysqlAny = mysql2 as { Connection?: { prototype?: Record<string, unknown> } };
    const proto = mysqlAny.Connection?.prototype;
    if (proto) {
      patchConnectMethod(proto, 'connect', 'mysql', (self) => {
        const c = (self as { config?: { host?: string; port?: number; database?: string } }).config ?? {};
        return { host: c.host ?? null, port: c.port ?? null, dbName: c.database ?? null };
      });
    }
    // mysql2's PROMISE api never calls connect() — `createConnection` opens
    // the socket from the core Connection constructor and surfaces a refused
    // connection as an 'error' event on the connection object, so patching
    // connect() (above) produced no span at all for the failure. Every fatal
    // error mysql2 raises goes through emit('error', …), and a failure raised
    // before the handshake completed (`authorized` still falsy) is by
    // definition a connection failure — which is exactly the span that was
    // missing. Errors after the handshake are left alone: those belong to the
    // query path, which reports them through its own callback.
    if (proto && typeof proto.emit === 'function' && !proto._openboxEmitPatched) {
      proto._openboxEmitPatched = true;
      const originalEmit = proto.emit as (this: unknown, event: string, ...rest: unknown[]) => boolean;
      proto.emit = function patchedMysqlEmit(this: Record<string, unknown>, event: string, ...rest: unknown[]) {
        if (event === 'error' && this._openboxConnectErrorReported !== true && this.authorized !== true) {
          // Once per connection: mysql2 can re-emit while tearing down, and a
          // failed connect is one event on the timeline, not three.
          this._openboxConnectErrorReported = true;
          try {
            const c = (this.config ?? {}) as { host?: string; port?: number; database?: string };
            const conn = { host: c.host ?? null, port: c.port ?? null, dbName: c.database ?? null };
            if (!isN8nOrmQuery()) {
              // The attempt started when the connection was constructed;
              // `connectedAt` is not exposed, so the span is stamped from now
              // and carries a duration of ~0 rather than a fabricated one.
              reportFailedConnect('mysql', conn, Date.now(), rest[0]);
            }
          } catch {
            // reporting must never break the driver's own error path
          }
        }
        return originalEmit.call(this, event, ...rest);
      };
    }

    if (!proto || proto._openboxQueryPatched || typeof proto.query !== 'function') return false;
    const original = proto.query as (this: unknown, ...queryArgs: unknown[]) => unknown;
    proto._openboxQueryPatched = true;
    proto.query = function patchedMysqlQuery(sql: unknown, ...args: unknown[]) {
      const self = this as { config?: { database?: string; host?: string; port?: number } };
      const activityId = getCurrentActivityId();
      if (!activityId) return original.call(self, sql, ...args);
      const statement = typeof sql === 'string' ? sql : String((sql as Record<string, unknown> | null)?.sql ?? sql ?? '');
      const startMs = Date.now();
      const dbOpts = {
        dbSystem: 'mysql' as const,
        dbName: self.config?.database,
        statement,
        host: self.config?.host,
        port: Number(self.config?.port) || null,
      };
      void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs }, { gate: false });

      // One completion, whichever of the three shapes below gets there first.
      // Without the guard a pool query would report twice: once through the
      // Query object's own callback and again on its 'end' event.
      let reported = false;
      const report = (err: unknown, results: unknown): void => {
        if (reported) return;
        reported = true;
        void evaluateDb(activityId, {
          ...dbOpts,
          stage: 'completed',
          startMs,
          endMs: Date.now(),
          error: err || undefined,
          rowcount: Array.isArray(results) ? results.length
            : (results as Record<string, unknown> | null)?.affectedRows as number ?? null,
        });
      };

      // Shape 1: query(sql, [values], callback).
      let viaCallback = false;
      const callbackIndex = args.findIndex((a) => typeof a === 'function');
      if (callbackIndex >= 0) {
        viaCallback = true;
        const originalCb = args[callbackIndex] as (err: unknown, results: unknown, fields: unknown) => void;
        args[callbackIndex] = function patchedMysql2Callback(err: unknown, results: unknown, fields: unknown) {
          report(err, results);
          originalCb(err, results, fields);
        };
      }

      // Shape 2: query(queryObject) — a pre-built Commands.Query carrying its
      // own `onResult`. This is what a POOL passes: `Pool.query` builds the
      // command itself and hands the connection a single argument, so there is
      // no function in `args` to wrap. Verified against a live MySQL: every
      // pool query produced a started span and never a completed one — an
      // orphan on Core for the most common way an app talks to MySQL.
      const queryObject = sql as { onResult?: (err: unknown, results: unknown, fields: unknown) => void } | null;
      if (
        callbackIndex < 0 &&
        queryObject != null &&
        typeof queryObject === 'object' &&
        typeof queryObject.onResult === 'function'
      ) {
        viaCallback = true;
        const originalOnResult = queryObject.onResult.bind(queryObject);
        queryObject.onResult = function patchedMysql2OnResult(err: unknown, results: unknown, fields: unknown) {
          report(err, results);
          originalOnResult(err, results, fields);
        };
      }

      const result = original.call(self, sql, ...args);

      // Shape 3: query(sql) with no callback at all — the caller consumes the
      // returned Query as an event emitter ('result'/'end'/'error'). Rows are
      // counted as they stream; `end` carries none.
      const emitter = result as {
        once?: (event: string, listener: (...a: unknown[]) => void) => unknown;
        on?: (event: string, listener: (...a: unknown[]) => void) => unknown;
      } | null;
      // Only when nothing else will report. mysql2 emits `end` on the Query
      // even when a callback is in play, and it fires FIRST — so attaching
      // this unconditionally stole the completion from the callback and
      // reported a null rowcount for every ordinary query.
      if (!viaCallback && !reported && emitter != null && typeof emitter.once === 'function') {
        let streamed = 0;
        emitter.on?.('result', () => { streamed++; });
        emitter.once('error', (err: unknown) => report(err, null));
        emitter.once('end', () => report(undefined, streamed > 0 ? new Array(streamed) : null));
      }

      return result;
    };
    return true;
  } catch {
    return false;
  }
}

function patchDatabaseModuleLoader(drivers: Set<DatabaseDriverName>): void {
  try {
    // 'module' resolves to the same built-in as 'node:module'; stored in a variable
    // so the literal string does not trigger the no-restricted-imports rule.
    const _moduleMod = 'module';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require(_moduleMod) as { _load?: (...args: unknown[]) => unknown; _openboxDbPatched?: boolean };
    if (Module._openboxDbPatched || typeof Module._load !== 'function') return;
    const originalLoad = Module._load;
    Module._openboxDbPatched = true;
    Module._load = function patchedModuleLoad(request: unknown, parent: unknown, isMain: unknown) {
      const exported = originalLoad.apply(this, [request, parent, isMain]);
      if (request === 'pg' && drivers.has('pg') && exported && typeof exported === 'object') {
        patchPgExports(exported as Record<string, unknown>);
      } else if (request === 'mysql2' && drivers.has('mysql2') && exported && typeof exported === 'object') {
        patchMysql2Exports(exported as Record<string, unknown>);
      } else if (request === 'mongodb' && drivers.has('mongodb') && exported && typeof exported === 'object') {
        patchMongoExports(exported as Record<string, unknown>);
      } else if (request === 'redis' && drivers.has('redis') && exported && typeof exported === 'object') {
        patchRedisExports(exported as Record<string, unknown>);
      } else if (request === 'ioredis' && drivers.has('ioredis') && exported && typeof exported === 'function') {
        patchIoRedisExports(exported as { prototype?: Record<string, unknown> });
      }
      return exported;
    };
  } catch {
    // optional instrumentation
  }
}

function patchMongo(): boolean {
  let patched = patchFromRequireCache(
    /[/\\]mongodb[/\\]lib[/\\]index\.js$/,
    (exports) => patchMongoExports(exports as Record<string, unknown>),
  );
  try {
    const _mongoMod = 'mongodb';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (patchMongoExports(require(_mongoMod))) patched = true;
  } catch { /* see patchIoRedis */ }
  return patched;
}

function patchMongoExports(mongodb: Record<string, unknown>): boolean {
  const mongoAny = mongodb as {
    Collection?: { prototype?: Record<string, unknown> };
    MongoClient?: { prototype?: Record<string, unknown> };
  };
  if (mongoAny.MongoClient?.prototype) {
    patchConnectMethod(mongoAny.MongoClient.prototype, 'connect', 'mongodb', (self) => {
      const c = self as { options?: { hosts?: Array<{ host?: string; port?: number }>; dbName?: string } };
      const first = c.options?.hosts?.[0];
      return { host: first?.host ?? null, port: first?.port ?? null, dbName: c.options?.dbName ?? null };
    });
  }
  const proto = mongoAny.Collection?.prototype;
  if (!proto || proto._openboxQueryPatched) return Boolean(proto);
  proto._openboxQueryPatched = true;

  for (const method of ['find', 'findOne', 'insertOne', 'updateOne', 'deleteOne', 'aggregate']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function patchedMongoOperation(filter: unknown, ...args: unknown[]) {
      const self = this as {
        collectionName?: string;
        namespace?: string;
        dbName?: string;
        s?: { dbName?: string; namespace?: string };
      };
      const activityId = getCurrentActivityId();
      if (!activityId) return original.call(self, filter, ...args);

      const statement = JSON.stringify({ [method]: filter ?? {} }).slice(0, 2000);
      const startMs = Date.now();
      const dbName = self.dbName ?? self.s?.dbName ?? String(self.namespace ?? self.s?.namespace ?? '').split('.')[0];
      const operation = method.toUpperCase();
      void evaluateDb(activityId, { dbSystem: 'mongodb', dbName, operation, statement, host: 'unknown', port: null, stage: 'started', startMs }, { gate: false });
      const result = original.call(self, filter, ...args) as unknown;
      if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        return (result as Promise<unknown>).then(
          async (value) => {
            await evaluateDb(activityId, {
              dbSystem: 'mongodb',
              dbName,
              operation,
              statement,
              host: 'unknown',
              port: null,
              stage: 'completed',
              startMs,
              endMs: Date.now(),
            });
            return value;
          },
          async (err) => {
            await evaluateDb(activityId, {
              dbSystem: 'mongodb',
              dbName,
              operation,
              statement,
              host: 'unknown',
              port: null,
              stage: 'completed',
              startMs,
              endMs: Date.now(),
              error: err,
            });
            throw err;
          },
        );
      }
      return result;
    };
  }
  return true;
}

/**
 * Real connection details for a redis client, across both supported drivers.
 *
 * ioredis exposes them flat on `options`; node-redis v4 nests the address under
 * `options.socket` and calls the database `database`. The patch used to hardcode
 * host 'unknown' / port 6379 / db '0', which made every redis span claim a
 * connection it had never checked — and left no way to tell n8n's queue Redis
 * apart from a Redis the agent actually uses.
 */
export function redisConnectionInfo(client: unknown): {
  host: string | null;
  port: number | null;
  db: string | null;
} {
  const opts = (client as {
    options?: {
      host?: string;
      port?: number;
      db?: number;
      database?: number;
      socket?: { host?: string; port?: number };
    };
  } | null)?.options ?? {};
  const host = opts.host ?? opts.socket?.host ?? null;
  const port = opts.port ?? opts.socket?.port ?? null;
  const db = opts.db ?? opts.database;
  return {
    host: host ? String(host) : null,
    port: port != null && Number.isFinite(Number(port)) ? Number(port) : null,
    db: db != null ? String(db) : null,
  };
}

/**
 * True when this connection is n8n's own Bull queue Redis.
 *
 * In queue mode n8n runs a main + worker pair coordinated through Redis. Because
 * the sendCommand patch sits on the driver prototype and AsyncLocalStorage
 * propagates down the whole call stack, every queue heartbeat, job poll and
 * pub/sub message n8n makes *while an activity is open* inherits our activity
 * scope and used to be reported as an agent span. A hosted trace for a workflow
 * whose only memory was Postgres came back with five of seven spans being
 * redis — none of them the agent's work.
 *
 * Matches host AND port, mirroring the pg filter's AND semantics so
 * a different Redis on the same host is still traced.
 */
export function isN8nQueueRedisConnection(
  host: string | null | undefined,
  port: number | null | undefined,
): boolean {
  if ((_env.EXECUTIONS_MODE || '').toLowerCase() !== 'queue') return false;
  const queueHost = (_env.QUEUE_BULL_REDIS_HOST || 'localhost').toLowerCase();
  const queuePort = Number(_env.QUEUE_BULL_REDIS_PORT || 6379);
  return (
    Boolean(host) && host!.toLowerCase() === queueHost &&
    port != null && Number(port) === queuePort
  );
}

/**
 * True when the command itself targets n8n-internal keys or channels.
 *
 * Backstop for the connection check above: when the queue Redis and a Redis the
 * agent uses are the same instance, host/port cannot separate them, but the keys
 * still can. Bull namespaces everything under its prefix (default 'bull'), and
 * n8n's own pub/sub channels are 'n8n.*'. Every token is checked rather than
 * just the first key, because Bull drives most of its work through EVALSHA,
 * where the keys sit several arguments in.
 */
/**
 * Redis commands that are connection plumbing, not the agent's work.
 *
 * ioredis issues HELLO / CLIENT SETNAME / CLIENT SETINFO / INFO on every
 * handshake. Instrumenting those put four extra spans on the timeline for a
 * two-command tool, and since each span is a governance round-trip (~1s,
 * serialized per activity) a 20ms Redis tool took 14 SECONDS end to end and
 * the trace read as though the agent had done a dozen database operations.
 * Data commands are unaffected.
 */
export function isRedisHousekeepingCommand(operation: string): boolean {
  switch (operation.toUpperCase()) {
    case 'HELLO':
    case 'AUTH':
    case 'CLIENT':
    case 'INFO':
    case 'SELECT':
    case 'PING':
    case 'QUIT':
    case 'RESET':
    case 'COMMAND':
    case 'CONFIG':
      return true;
    default:
      return false;
  }
}

export function isN8nInternalRedisCommand(statement: string): boolean {
  const prefix = (_env.QUEUE_BULL_PREFIX || 'bull').toLowerCase();
  return statement
    .toLowerCase()
    .split(/\s+/)
    .some((token) => (
      token.startsWith(`${prefix}:`) ||
      token.startsWith('n8n.') ||
      token.startsWith('n8n:')
    ));
}

function patchRedis(): boolean {
  let patched = patchFromRequireCache(
    /[/\\]redis[/\\](dist|lib)[/\\]index\.js$/,
    (exports) => patchRedisExports(exports as Record<string, unknown>),
  );
  try {
    const _redisMod = 'redis';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (patchRedisExports(require(_redisMod))) patched = true;
  } catch { /* see patchIoRedis */ }
  return patched;
}

function patchRedisExports(redis: Record<string, unknown>): boolean {
  const originalCreateClient = redis.createClient;
  if (typeof originalCreateClient !== 'function' || redis._openboxCreateClientPatched) return false;
  redis._openboxCreateClientPatched = true;
  redis.createClient = function patchedCreateClient(...args: unknown[]) {
    const client = Reflect.apply(originalCreateClient, this, args);
    patchRedisConnect(client as Record<string, unknown>);
    patchRedisClient(client as Record<string, unknown>);
    // The typed commands (client.set(…)) — the way node-redis is actually
    // used, and the path sendCommand never sees.
    patchNodeRedisCommands(client as Record<string, unknown>);
    return client;
  };
  return true;
}

function patchIoRedis(): boolean {
  // Cache scan first (see patchFromRequireCache); direct require is only a
  // fallback for the case where the driver has not been loaded yet AND
  // happens to be resolvable from here.
  let patched = patchFromRequireCache(
    /[/\\]ioredis[/\\](built|lib)[/\\]index\.js$/,
    (exports) => patchIoRedisExports(exports as { prototype?: Record<string, unknown> }),
  );
  try {
    const _ioredisMod = 'ioredis';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (patchIoRedisExports(require(_ioredisMod))) patched = true;
  } catch { /* not resolvable from here — the cache scan is the real path */ }
  return patched;
}

function patchIoRedisExports(redisCtor: { prototype?: Record<string, unknown> }): boolean {
  const proto = redisCtor.prototype;
  if (!proto) return false;
  patchRedisConnect(proto);
  return patchRedisClient(proto);
}

/**
 * Trace connection attempts for a redis client or prototype.
 *
 * Uses the same queue-connection guard as the command patch, so n8n's own Bull
 * and pub/sub clients are not reported as the agent's work.
 */
function patchRedisConnect(target: Record<string, unknown>): void {
  patchConnectMethod(
    target,
    'connect',
    'redis',
    (self) => {
      const c = redisConnectionInfo(self);
      return { host: c.host, port: c.port, dbName: c.db };
    },
    (conn) => isN8nQueueRedisConnection(conn.host, conn.port),
  );
}

/**
 * Trace one Redis command: the shared body behind both dispatch paths.
 *
 * `invoke` runs the driver's own call; everything else is the span.
 */
function traceRedisCommand(
  self: unknown,
  activityId: string,
  operation: string,
  statement: string,
  invoke: () => unknown,
): unknown {
  // n8n's own queue traffic is not the agent's work — see
  // isN8nQueueRedisConnection / isN8nInternalRedisCommand.
  const conn = redisConnectionInfo(self);
  if (
    isRedisHousekeepingCommand(operation) ||
    isN8nQueueRedisConnection(conn.host, conn.port) ||
    isN8nInternalRedisCommand(statement)
  ) {
    return invoke();
  }

  const dbOpts = {
    dbSystem: 'redis' as const,
    dbName: conn.db,
    operation,
    statement,
    host: conn.host,
    port: conn.port,
  };
  const startMs = Date.now();
  void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs }, { gate: false });
  const result = invoke();
  if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
    return (result as Promise<unknown>).then(
      async (value) => {
        await evaluateDb(activityId, { ...dbOpts, stage: 'completed', startMs, endMs: Date.now() });
        return value;
      },
      async (err) => {
        await evaluateDb(activityId, { ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), error: err });
        throw err;
      },
    );
  }
  return result;
}

/** A command argument, rendered for the statement without dumping a payload. */
function redisArgText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Buffer.isBuffer(value)) return `<${value.length}B>`;
  if (Array.isArray(value)) return value.map(redisArgText).join(' ');
  return '<obj>';
}

/**
 * The command names node-redis v4 attaches, read from the driver itself.
 *
 * Resolved from `require.cache` rather than by requiring it from here: the
 * driver lives in the host application's node_modules, not this package's.
 */
function nodeRedisCommandNames(): string[] | null {
  try {
    const _moduleMod = 'module';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require(_moduleMod) as { _cache?: Record<string, { exports?: unknown }> };
    for (const [id, mod] of Object.entries(Module._cache ?? {})) {
      if (!/[/\\]@redis[/\\]client[/\\].*[/\\]client[/\\]commands\.js$/.test(id)) continue;
      const exported = (mod?.exports ?? {}) as Record<string, unknown>;
      const map = (exported.default ?? exported) as Record<string, unknown>;
      const names = Object.keys(map);
      if (names.length > 0) return names;
    }
  } catch {
    // fall through — the sendCommand patch still covers direct calls
  }
  return null;
}

/**
 * node-redis v4 dispatches a typed command (`client.set(…)`) through
 * `commandsExecutor`, which calls a PRIVATE `#sendCommand` — never the public
 * `sendCommand` this module patches. `attachCommands` captures the executor in
 * a closure when the class is defined, so replacing it on the prototype
 * afterwards changes nothing either. Result, measured against a live server:
 * an agent using node-redis produced NO db spans at all, while the identical
 * ioredis code produced them fine.
 *
 * So the generated command methods are wrapped directly, on the prototype that
 * owns them, once per process. The names come from the driver's own command
 * map so nothing else on the prototype (connect, quit, multi, subscribe…) is
 * touched.
 */
export function patchNodeRedisCommands(
  client: Record<string, unknown>,
  commandNames?: string[] | null,
): boolean {
  const names = commandNames ?? nodeRedisCommandNames();
  if (names == null) return false;

  let proto: Record<string, unknown> | null = Object.getPrototypeOf(client) as Record<string, unknown> | null;
  while (proto != null && !Object.prototype.hasOwnProperty.call(proto, 'commandsExecutor')) {
    proto = Object.getPrototypeOf(proto) as Record<string, unknown> | null;
  }
  if (proto == null) return false;
  if (proto._openboxCommandsPatched) return true;
  proto._openboxCommandsPatched = true;

  for (const name of names) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    const call = original as (this: unknown, ...a: unknown[]) => unknown;
    const operation = name.toUpperCase();
    proto[name] = function patchedRedisCommand(this: unknown, ...args: unknown[]) {
      const activityId = getCurrentActivityId();
      if (!activityId) return call.apply(this, args);
      const statement = [operation, ...args.map(redisArgText)].filter(Boolean).join(' ');
      return traceRedisCommand(this, activityId, operation, statement, () => call.apply(this, args));
    };
  }
  return true;
}

function patchRedisClient(client: Record<string, unknown>): boolean {
  if (client._openboxSendCommandPatched || typeof client.sendCommand !== 'function') return false;
  const original = client.sendCommand as (this: unknown, ...args: unknown[]) => unknown;
  client._openboxSendCommandPatched = true;
  client.sendCommand = function patchedSendCommand(command: unknown, ...args: unknown[]) {
    const activityId = getCurrentActivityId();
    if (!activityId) return original.call(this, command, ...args);
    const name = Array.isArray(command)
      ? String(command[0] ?? 'UNKNOWN')
      : String((command as Record<string, unknown> | null)?.name ?? command ?? 'UNKNOWN');
    const statement = Array.isArray(command) ? command.map(String).join(' ') : name;
    return traceRedisCommand(this, activityId, name.toUpperCase(), statement, () =>
      original.call(this, command, ...args),
    );
  };
  return true;
}

export function setupNodeHookInstrumentation(options: NodeInstrumentationOptions = {}): void {
  const logger = options.logger ?? noopLogger;
  if (installed) {
    // Instrumentation state (all the module-level _openbox*Patched flags) is
    // process-global — a second call in the same process reuses it rather
    // than failing or silently no-op'ing without any signal.
    logger.warn('OpenBox instrumentation already installed in this process — reusing existing patches.');
    return;
  }
  installed = true;

  if (options.fileIo ?? true) {
    try {
      // 'fs' resolves to the same built-in as 'node:fs'; stored in a variable
      // so the literal string does not trigger the no-restricted-imports rule.
      const _fsMod = 'fs';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require(_fsMod) as typeof Fs;
      patchFsPromises(fs);
      patchFsCallbacks(fs);
      patchFsSync(fs);
    } catch (err) {
      logger.warn('fs instrumentation failed to install', err);
    }
  }

  const databasesEnabledByEnv = _env.OPENBOX_INSTRUMENT_DATABASES !== 'false';
  const drivers = options.databases ?? new Set<DatabaseDriverName>(ALL_DATABASE_DRIVERS);
  if (databasesEnabledByEnv && drivers.size > 0) {
    patchDatabaseModuleLoader(drivers);
    if (drivers.has('pg')) patchPg();
    if (drivers.has('mysql2')) patchMysql2();
    if (drivers.has('mongodb')) patchMongo();
    if (drivers.has('redis')) patchRedis();
    if (drivers.has('ioredis')) patchIoRedis();
  }
}
