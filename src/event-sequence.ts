/**
 * Ordering guarantees for a run's governance events.
 *
 * ─── Why this exists ───────────────────────────────────────────────────────
 *
 * Core orders a session's events by the `timestamp` the SDK stamps on them,
 * and the dashboard renders that order literally. Two things broke it:
 *
 *  1. **Millisecond ties.** A parallel tool round emits several ActivityStarted
 *     events within the same millisecond — three landed within 3ms in a real
 *     run. Events sharing a timestamp have no defined order, so the timeline
 *     could show a tool completing before the tool that preceded it started.
 *
 *  2. **Clock movement.** `Date.now()` is not monotonic (NTP correction, sleep
 *     /wake). A backwards step mid-run reorders everything after it.
 *
 * So ordering is not left to wall-clock luck: each event gets a strictly
 * increasing timestamp within its run, plus an explicit `sequence` number that
 * is unambiguous even if two events are later normalized to the same instant.
 *
 * ─── What it deliberately does NOT do ──────────────────────────────────────
 *
 * It does not serialize the *sending* of events. Tools in a parallel round run
 * concurrently by design, and each governance POST costs ~1s against a real
 * Core — chaining them would turn a 3-tool round into 3× the latency to fix a
 * display problem. Stamping order at build time gives a deterministic sequence
 * while leaving the network free to overlap.
 */

import type { OpenBoxGovernanceEvent } from './types';

/** Lifecycle rules a well-formed run must satisfy. */
export type SequenceViolation =
  | { kind: 'completed_without_started'; activityId: string; activityType?: string }
  | { kind: 'duplicate_completion'; activityId: string; activityType?: string }
  | { kind: 'event_after_workflow_completed'; eventType: string; activityId: string }
  | { kind: 'workflow_started_twice' }
  | { kind: 'activity_before_workflow_started'; eventType: string; activityId: string };

function isStart(eventType: string): boolean {
  return eventType === 'ActivityStarted' || eventType === 'LLMStarted' || eventType === 'ToolStarted';
}

function isCompletion(eventType: string): boolean {
  return (
    eventType === 'ActivityCompleted' || eventType === 'LLMCompleted' || eventType === 'ToolCompleted'
  );
}

/**
 * Per-run ordering state. One instance per `run_id`; see {@link sequencerFor}.
 */
export class EventSequencer {
  /** Last timestamp handed out, in ms. Never decreases. */
  private lastMs = 0;
  private seq = 0;
  private workflowStarted = false;
  private workflowCompleted = false;
  private readonly openActivities = new Set<string>();
  private readonly completedActivities = new Set<string>();

  /**
   * Assign this event its position in the run.
   *
   * Returns a NEW object rather than mutating: `buildEvent` composes its
   * result from spreads, and a caller that reuses a field object should not
   * see a timestamp appear in it.
   */
  stamp(event: OpenBoxGovernanceEvent): OpenBoxGovernanceEvent {
    // Strictly increasing: a tie or a backwards clock step advances by 1ms
    // rather than repeating or regressing.
    const now = Date.now();
    this.lastMs = now > this.lastMs ? now : this.lastMs + 1;
    this.seq += 1;

    this.track(event);

    return {
      ...event,
      timestamp: new Date(this.lastMs).toISOString(),
      sequence: this.seq,
    };
  }

  /** Update lifecycle bookkeeping so {@link check} can spot violations. */
  private track(event: OpenBoxGovernanceEvent): void {
    const { event_type: type, activity_id: id } = event;
    if (type === 'WorkflowStarted') this.workflowStarted = true;
    else if (type === 'WorkflowCompleted' || type === 'WorkflowFailed') this.workflowCompleted = true;
    else if (id != null && isStart(type)) this.openActivities.add(id);
    else if (id != null && isCompletion(type)) {
      this.openActivities.delete(id);
      this.completedActivities.add(id);
    }
  }

  /**
   * Report what is wrong with emitting this event now, or null if it is fine.
   *
   * Advisory: the SDK logs violations rather than throwing, because dropping a
   * governance event to protect a display invariant is the wrong trade — a
   * missing event is worse than an out-of-order one. Tests assert on it.
   */
  check(event: OpenBoxGovernanceEvent): SequenceViolation | null {
    const { event_type: type, activity_id: id, activity_type: activityType } = event;

    if (this.workflowCompleted) {
      return { kind: 'event_after_workflow_completed', eventType: type, activityId: id ?? '' };
    }
    if (type === 'WorkflowStarted' && this.workflowStarted) {
      return { kind: 'workflow_started_twice' };
    }
    if (id != null && isCompletion(type)) {
      if (this.completedActivities.has(id)) {
        return { kind: 'duplicate_completion', activityId: id, activityType };
      }
      if (!this.openActivities.has(id)) {
        return { kind: 'completed_without_started', activityId: id, activityType };
      }
    }
    if (
      !this.workflowStarted &&
      id != null &&
      (isStart(type) || isCompletion(type))
    ) {
      return { kind: 'activity_before_workflow_started', eventType: type, activityId: id };
    }
    return null;
  }

  /** Activity ids started but never completed. Used when closing a run. */
  danglingActivities(): string[] {
    return [...this.openActivities];
  }
}

// ── registry ────────────────────────────────────────────────────────────────
//
// Keyed by run_id so concurrent runs on one middleware keep independent
// sequences — a shared counter would interleave two runs' numbering and make
// each look full of holes.

const _sequencers = new Map<string, EventSequencer>();

export function sequencerFor(runId: string): EventSequencer {
  let s = _sequencers.get(runId);
  if (!s) {
    s = new EventSequencer();
    _sequencers.set(runId, s);
  }
  return s;
}

/** Drop a finished run's state. Called when its workflow closes. */
export function releaseSequencer(runId: string): void {
  _sequencers.delete(runId);
}

/** Test hook: forget every run. */
export function resetSequencers(): void {
  _sequencers.clear();
}

// ── offline verification ────────────────────────────────────────────────────

/**
 * Check an already-emitted sequence, e.g. rows read back from Core. Replays
 * the same rules over the list and returns every violation found.
 *
 * This is the function to point at a session that "looks wrong" — it answers
 * whether the order is genuinely invalid or merely concurrent.
 */
export function findSequenceViolations(
  events: readonly OpenBoxGovernanceEvent[],
): SequenceViolation[] {
  const sequencer = new EventSequencer();
  const violations: SequenceViolation[] = [];
  for (const event of events) {
    const violation = sequencer.check(event);
    if (violation) violations.push(violation);
    sequencer.stamp(event);
  }
  return violations;
}

/**
 * True when timestamps are strictly increasing and `sequence` is a gapless
 * 1..N run. Both hold for anything this SDK emits for a single run.
 */
export function isMonotonic(events: readonly OpenBoxGovernanceEvent[]): boolean {
  let lastMs = -1;
  for (let i = 0; i < events.length; i++) {
    const ms = Date.parse(String(events[i].timestamp));
    if (Number.isNaN(ms) || ms <= lastMs) return false;
    lastMs = ms;
    const seq = (events[i] as { sequence?: number }).sequence;
    if (seq !== i + 1) return false;
  }
  return true;
}
