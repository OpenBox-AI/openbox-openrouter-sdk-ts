/**
 * Structured error normalization: Core rejects a bare string in an event's
 * `error` field, so every error is coerced into `{type, message, stack_trace}`.
 */

import { ErrorInfo } from './types';

/**
 * Stringify an arbitrary thrown value without ever throwing itself — guards
 * against a hostile toString()/Symbol.toPrimitive or a null-prototype object.
 */
export function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return '[Unserializable]';
    }
  }
}

/**
 * toErrorInfo(err) — the one conversion seam. Error instances preserve their
 * own `name` (not `constructor.name`, which diverges whenever an Error
 * subclass sets `this.name` explicitly) and `stack`, included only when
 * present. Everything else becomes `{type: "Error", message: safeString(value)}`.
 */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    const info: ErrorInfo = {
      type: err.name || 'Error',
      message: err.message,
    };
    if (typeof err.stack === 'string' && err.stack) {
      info.stack_trace = err.stack;
    }
    return info;
  }

  return { type: 'Error', message: safeString(err) };
}
