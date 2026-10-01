/**
 * The pause between approval polls.
 *
 * An abort signal ends the pause at once instead of waiting out the interval,
 * which is how a host releases a process that is waiting on a human decision.
 *
 * The timer is deliberately NOT unref'd. In a script, the poll loop is often
 * the only thing keeping Node alive while a reviewer decides; unref'd, the
 * process would exit between two polls and the held operation would silently
 * never finish (provenance.ts hit the same thing).
 */

const _timersMod = 'timers';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setTimeout: _setTimeout, clearTimeout: _clearTimeout } = require(_timersMod) as typeof import('timers');

/** Raised when an approval wait is aborted through its signal. */
export class ApprovalWaitAbortedError extends Error {
  constructor() {
    super('Approval wait aborted');
    this.name = 'ApprovalWaitAbortedError';
  }
}

/** Resolve after `ms`, or reject with {@link ApprovalWaitAbortedError} as soon as `signal` aborts. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ApprovalWaitAbortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      _clearTimeout(timer);
      reject(new ApprovalWaitAbortedError());
    };
    const timer = _setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
