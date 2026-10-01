/**
 * AbortSignal helpers that work on Node 18, which has `AbortSignal.timeout`
 * but not `AbortSignal.any`.
 */

/** A signal that aborts when any of `signals` aborts, plus a cleanup to drop the listeners. */
export function anySignal(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  const onAbort = (event: Event) => {
    const source = event.target as AbortSignal;
    controller.abort(source.reason);
  };
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const s of present) s.removeEventListener('abort', onAbort);
    },
  };
}

/** A signal that aborts after `ms`, with its timer unref'd so it never holds the process open. */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
}
