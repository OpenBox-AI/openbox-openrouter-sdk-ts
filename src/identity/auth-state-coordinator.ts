/**
 * Per-client coordination for authentication state that must be acquired over
 * the network: IAM v3 workload tokens and Okta v2 bootstrap identities.
 *
 * Guarantees, all per coordinator (per client — never process-global):
 * - Concurrent callers share ONE acquisition. Its failure rejects every waiter;
 *   a later, independent call may acquire again.
 * - State is published atomically, and only by an acquisition that is still
 *   current. `reset()` and `close()` bump a revision and abort the acquisition
 *   that was in flight, so it can never publish and its waiters move straight
 *   on to the current acquisition instead of waiting out the old one.
 * - State the owner no longer considers usable (e.g. a refresh-due token) is
 *   dropped, never served — there is no stale fallback when renewal fails.
 * - A caller's abort signal cancels only that caller's wait, never the shared
 *   acquisition unrelated callers depend on.
 *
 * No timers, background refresh, or persistence: acquisition happens on demand.
 */

interface Flight<T> {
  readonly revision: number;
  readonly promise: Promise<T>;
  /** Aborted when this acquisition is superseded (`reset()`) or the coordinator closes. */
  readonly controller: AbortController;
}

/** Internal marker: an acquisition finished after it was superseded. Never escapes `get()`. */
class SupersededAcquisitionError extends Error {}

export interface AuthStateCoordinatorOptions<T> {
  /** Perform one acquisition. `signal` aborts when it is superseded or the coordinator closes. */
  readonly acquire: (signal: AbortSignal) => Promise<T>;
  /** False once a published state must not be used again (e.g. refresh-due). */
  readonly isUsable: (state: T) => boolean;
  /** The error every call receives after `close()`. */
  readonly closedError: () => Error;
  /** Diagnostics hook, called once per PUBLISHED state — never for a superseded acquisition. */
  readonly onPublish?: (state: T) => void;
}

export class AuthStateCoordinator<T extends object> {
  readonly #options: AuthStateCoordinatorOptions<T>;
  #state: T | null = null;
  #flight: Flight<T> | null = null;
  #revision = 0;
  #closed = false;

  constructor(options: AuthStateCoordinatorOptions<T>) {
    this.#options = options;
  }

  /** The published state while it is usable; never starts an acquisition. */
  current(): T | null {
    const state = this.#state;
    return state !== null && this.#options.isUsable(state) ? state : null;
  }

  /** Resolve a usable state, joining the in-flight acquisition or starting one. */
  async get(signal?: AbortSignal): Promise<T> {
    for (;;) {
      const usable = this.#takeUsableState();
      if (usable !== null) return usable;
      const flight = this.#flight ?? this.#startFlight();
      const published = await this.#awaitFlight(flight, signal);
      // Invalidated between publication and this resumption → loop to what is current.
      if (published !== null && published === this.#state) return published;
    }
  }

  /**
   * Drop `expected` if it is still the published state (e.g. Core rejected a
   * request that used it). A rejection for a state that was already replaced
   * leaves the newer state alone, so a burst of late 401s cannot force a burst
   * of re-acquisitions.
   */
  invalidate(expected: T): void {
    if (this.#state === expected) this.#state = null;
  }

  /** Drop the published state and supersede (abort) any in-flight acquisition (explicit refresh). */
  reset(): void {
    this.#revision += 1;
    this.#state = null;
    const flight = this.#flight;
    this.#flight = null;
    flight?.controller.abort(new SupersededAcquisitionError("authentication acquisition superseded"));
  }

  /** Idempotent: reject every current and future call and abort in-flight acquisition. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.reset();
  }

  /** The published state while usable (a refresh-due one is dropped); throws once closed. */
  #takeUsableState(): T | null {
    if (this.#closed) throw this.#options.closedError();
    const state = this.#state;
    if (state === null) return null;
    if (this.#options.isUsable(state)) return state;
    this.#state = null; // refresh-due: drop it rather than ever serving it again
    return null;
  }

  /**
   * The flight's published state, or null when the flight was superseded by
   * reset()/close() mid-flight — its outcome is irrelevant and the caller loops.
   * The caller's own abort, and the failure of a still-current flight, propagate.
   */
  async #awaitFlight(flight: Flight<T>, signal: AbortSignal | undefined): Promise<T | null> {
    try {
      return await waitUnlessAborted(flight.promise, signal);
    } catch (error) {
      const superseded = flight.revision !== this.#revision || this.#closed;
      if (signal?.aborted || !superseded) throw error;
      return null;
    }
  }

  #startFlight(): Flight<T> {
    const revision = this.#revision;
    const controller = new AbortController();
    // Async by contract. A synchronous throw would fail only the get() that
    // started this acquisition: the flight below is never registered.
    const acquisition = this.#options.acquire(controller.signal);
    const flight: Flight<T> = {
      revision,
      controller,
      promise: acquisition.then(
        (state) => {
          if (revision !== this.#revision) throw new SupersededAcquisitionError();
          // Still current, so this is the in-flight acquisition: publish the
          // state and clear the flight together, in one synchronous step.
          this.#state = state;
          this.#flight = null;
          try {
            this.#options.onPublish?.(state);
          } catch {
            // Diagnostics only: a failing logger must not un-publish a valid state.
          }
          return state;
        },
        (error: unknown) => {
          if (this.#flight === flight) this.#flight = null;
          throw error;
        }
      )
    };
    // Every waiter may have been aborted; never leave the shared rejection unhandled.
    flight.promise.catch(() => undefined);
    this.#flight = flight;
    return flight;
  }
}

/** `promise`, or a rejection as soon as `signal` aborts — without cancelling `promise`. */
function waitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}
