/**
 * Core types for the OpenBox OpenRouter governance SDK.
 *
 * Wire types for the governance event stream, which in
 * use the field names Core classifies on, so events from any OpenBox SDK are
 * interchangeable. Do not "tidy" a field name here without changing every SDK.
 */

import { createHash, randomBytes } from 'crypto';

export type VerdictArm = 'allow' | 'monitor' | 'constrain' | 'block' | 'halt' | 'require_approval';

export interface GuardrailsResult {
  input_type?: 'activity_input' | 'activity_output';
  redacted_input?: unknown;
  validation_passed?: boolean;
  reasons?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * The optional remediation directive Core attaches to a BLOCK verdict
 * (policy-produced, or written by a reviewer as an admin patch).
 *
 * Core's contract (`internal/content/patch.go`): an object with EXACTLY the
 * key `new_input`, whose value is `null | string | number | array | object` —
 * boolean is rejected, and anything malformed or oversized (>64 KiB) is
 * dropped by Core so the verdict degrades to a plain BLOCK. It is explicitly
 * "a remediation hint, not proof a retry occurred": the replacement input a
 * policy suggests, not an instruction the SDK is obliged to execute.
 *
 * `new_input` is optional here for the same reason it is raw bytes in Core: an
 * absent field and a literal `null` are different things — `null` means
 * "retry with the original input".
 */
export interface GovernancePatch {
  new_input?: unknown;
  [key: string]: unknown;
}

export interface GovernanceVerdictResponse {
  /** Remediation directive; present only on a BLOCK. See `GovernancePatch`. */
  patch?: GovernancePatch;
  arm?: VerdictArm;
  verdict?: string;
  action?: string;
  reason?: string;
  risk_score?: number;
  riskScore?: number;
  id?: string;
  approval_id?: string;
  approvalId?: string;
  guardrails_result?: GuardrailsResult;
  guardrailsResult?: GuardrailsResult;
  [key: string]: unknown;
}

/**
 * Structured error shape required by Core — a bare string in the `error` field
 * of a lifecycle event is rejected.
 */
export interface ErrorInfo {
  type: string;
  message: string;
  stack_trace?: string;
}

/**
 * One governance event on the wire. Optional fields that are not always
 * present are left optional so partial construction is ergonomic.
 */
export interface OpenBoxGovernanceEvent {
  source: 'workflow-telemetry';
  timestamp: string;
  workflow_id: string;
  run_id: string;
  workflow_type: string;
  task_queue?: string;
  session_id?: string;
  event_type: string;
  activity_id?: string;
  activity_type?: string;
  activity_input?: unknown[];
  activity_output?: unknown;
  status?: 'completed' | 'failed';
  duration_ms?: number;
  error?: ErrorInfo;
  spans?: unknown[];
  span_count?: number;
  workflow_output?: unknown;
  agent_name?: string;
  extra?: Record<string, unknown>;
  // SignalReceived
  signal_name?: string;
  signal_args?: unknown[];
  // LLM events
  prompt?: string;
  llm_model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  has_tool_calls?: boolean;
  completion?: string | null;
  // Tool events
  tool_name?: string;
  tool_type?: string;
  // OTel hook layer (Layer 2) — span-carrying events
  hook_trigger?: boolean;
  /**
   * Position of this event within its run, 1-based and gapless. Makes the
   * order explicit rather than inferred from timestamps that can tie.
   */
  sequence?: number;
  [key: string]: unknown;
}

/** Timestamp in the RFC 3339 form Core parses. */
export function rfc3339Now(): string {
  return new Date().toISOString();
}

/**
 * safe_serialize() — recursive, cycle-safe JSON coercion.
 *
 * Unlike a bare JSON.parse(JSON.stringify(...)) round-trip, this:
 *  - replaces only the cyclic edge with "[Circular]" (siblings survive)
 *  - converts Map → plain object, Set → array (JSON.stringify turns both into "{}")
 *  - converts BigInt → string, non-finite numbers → null
 *  - never throws, even for a hostile toString()/null-prototype value
 */
export function safeSerialize(value: unknown): unknown {
  return toJsonSafeInner(value, new WeakSet());
}

function toJsonSafeInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value as number) ? value : null;
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'function' || t === 'symbol') return null;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((v) => toJsonSafeInner(v, seen));
  }

  if (value instanceof Map) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value) obj[String(k)] = toJsonSafeInner(v, seen);
    return obj;
  }

  if (value instanceof Set) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return Array.from(value.values()).map((v) => toJsonSafeInner(v, seen));
  }

  if (t === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    const rec = value as Record<string, unknown>;
    const toJson = (rec as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      try {
        return toJsonSafeInner((toJson as () => unknown).call(rec), seen);
      } catch {
        // fall through to plain-object field enumeration
      }
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      // A getter/accessor property can throw on read (hostile input, or a
      // proxy) — guard each field individually so one bad property doesn't
      // take down serialization of the whole object.
      try {
        out[key] = toJsonSafeInner(rec[key], seen);
      } catch {
        out[key] = '[Unserializable]';
      }
    }
    return out;
  }

  try {
    return String(value);
  } catch {
    return '[Unserializable]';
  }
}

/**
 * Deterministic 16-char hex span id derived from a seed.
 *
 * The started and completed halves of one operation MUST carry the same
 * span_id: OpenBox Core creates the span row from the started hook and expects
 * the completed hook to fill in duration/end_time, correlating them by span_id.
 * A random id per stage leaves every span showing "started" with no duration.
 */
export function stableSpanId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/** Crypto-random hex ID. */
export function hexId(len: number = 32): string {
  return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}
