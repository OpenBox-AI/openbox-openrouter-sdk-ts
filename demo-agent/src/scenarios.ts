/**
 * Demo scenarios: each one puts the agent's policy into a known state, so a
 * single prompt can be run four ways and the difference is the verdict.
 *
 * Switching an arm means two things — rewriting the rego module OPA serves,
 * and toggling the policy row Core looks up for the agent. Both are local
 * development fixtures, so everything here degrades to "unavailable" rather
 * than failing the run: the demo still works against a plain Core, you just
 * cannot flip arms from the page.
 *
 *   OPENBOX_POLICY_ID    the policy row to drive (default: the fixture's id)
 *   OPENBOX_POLICY_FILE  the rego module OPA is watching (`opa run -w`)
 */

import { writeFile } from 'node:fs/promises';
import { Client as PgClient } from 'pg';

export type ScenarioName = 'allow' | 'block' | 'halt' | 'approval';

export interface Scenario {
  readonly name: ScenarioName;
  readonly label: string;
  /** What the policy does, in the page's words. */
  readonly summary: string;
  /** What the run should look like, so a reader can tell right from wrong. */
  readonly expect: string;
  readonly prompt: string;
  /** The OPA decision for `refund_order`; null leaves everything allowed. */
  readonly decision: 'BLOCK' | 'STOP' | 'REQUIRE_APPROVAL' | null;
  readonly reason?: string;
  /** A remediation directive, for the arms that carry one. */
  readonly patch?: Record<string, unknown>;
}

const REFUND_PROMPT = 'Order A-1003 arrived damaged. Check it and refund me in full.';

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'allow',
    label: 'Allowed',
    summary: 'No policy attached — every activity is recorded and permitted.',
    expect: 'The refund runs and the agent confirms £12.',
    prompt: REFUND_PROMPT,
    decision: null,
  },
  {
    name: 'block',
    label: 'Blocked',
    summary:
      'Refunds over £5 are refused, and the policy suggests the capped amount instead.',
    expect:
      'refund_order is refused, the model retries with £5, and that retry is evaluated fresh and allowed.',
    prompt: REFUND_PROMPT,
    decision: 'BLOCK',
    reason: "refund of 12 exceeds the agent's limit of 5",
    patch: { new_input: { orderId: 'A-1003', amount: 5, reason: 'capped by policy' } },
  },
  {
    name: 'halt',
    label: 'Halted',
    summary: 'Refunds stop the session outright.',
    expect:
      'refund_order never runs, no further model call goes out, and the run ends with GovernanceHaltError.',
    prompt: REFUND_PROMPT,
    decision: 'STOP',
    reason: 'refunds are not permitted for this agent',
  },
  {
    name: 'approval',
    label: 'Needs approval',
    summary: 'A refund is held open until a human decides.',
    expect:
      'refund_order waits. Approve and the tool runs; deny and the run ends with the reviewer’s reason.',
    prompt: REFUND_PROMPT,
    decision: 'REQUIRE_APPROVAL',
    reason: 'refunds require a reviewer',
  },
];

export function findScenario(name: string | undefined): Scenario {
  return SCENARIOS.find((s) => s.name === name) ?? SCENARIOS[0];
}

// ── fixture plumbing ────────────────────────────────────────────────────────

const POLICY_ID = process.env.OPENBOX_POLICY_ID ?? '59274034-770a-4631-bf62-b6b97d1d5985';
const POLICY_FILE =
  process.env.OPENBOX_POLICY_FILE ?? '/private/tmp/openbox-opa-verify/policy.rego';

function db(): PgClient {
  return new PgClient({
    host: process.env.OPENBOX_DB_HOST ?? 'localhost',
    port: Number(process.env.OPENBOX_DB_PORT ?? 5432),
    user: process.env.OPENBOX_DB_USER ?? 'postgres',
    password: process.env.OPENBOX_DB_PASSWORD ?? 'password',
    database: process.env.OPENBOX_DB_NAME ?? 'openbox',
    connectionTimeoutMillis: 2_000,
  });
}

export async function withDb<T>(fn: (client: PgClient) => Promise<T>): Promise<T | null> {
  const client = db();
  try {
    await client.connect();
    return await fn(client);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The rego module for one arm. Package name must match the policy's path. */
function regoFor(scenario: Scenario): string {
  const pkg = `org.openbox_ai.policy_${POLICY_ID.replace(/-/g, '')}`;
  const head = `package ${pkg}

# Written by the demo UI. OPA reloads this file on save (\`opa run -w\`).

default result = {"decision": "ALLOW", "reason": null}

refund_started if {
	input.activity_type == "refund_order"
	input.event_type == "ActivityStarted"
}
`;
  if (scenario.decision == null) return head;

  // The block arm keys off the amount so the model's capped retry is allowed —
  // that is the whole point of a remediation directive.
  if (scenario.decision === 'BLOCK') {
    return `${head}
requested := to_number(input.activity_input[0].amount)

result := {
	"decision": "BLOCK",
	"reason": sprintf("refund of %v exceeds the agent's limit of 5", [requested]),
	"patch": {"new_input": {"orderId": input.activity_input[0].orderId, "amount": 5, "reason": "capped by policy"}},
} if {
	refund_started
	requested > 5
}
`;
  }

  return `${head}
result := {
	"decision": "${scenario.decision}",
	"reason": ${JSON.stringify(scenario.reason ?? 'refused by policy')},
} if {
	refund_started
}
`;
}

export interface ScenarioState {
  applied: boolean;
  /** Why not, when the fixture is not reachable. */
  detail?: string;
}

/** Put the policy into the state this scenario needs. */
export async function applyScenario(scenario: Scenario): Promise<ScenarioState> {
  const rego = regoFor(scenario);
  try {
    await writeFile(POLICY_FILE, rego, 'utf8');
  } catch (err) {
    return {
      applied: false,
      detail: `Could not write ${POLICY_FILE} — set OPENBOX_POLICY_FILE, or run the scenario's policy manually.`,
    };
  }

  const updated = await withDb(async (client) => {
    const { rowCount } = await client.query(
      'UPDATE policies SET is_active = $1 WHERE id = $2',
      [scenario.decision != null, POLICY_ID],
    );
    return rowCount ?? 0;
  });

  if (updated == null) {
    return { applied: false, detail: 'OpenBox database unreachable — policy state unchanged.' };
  }
  if (updated === 0) {
    return { applied: false, detail: `No policy row ${POLICY_ID} — set OPENBOX_POLICY_ID.` };
  }

  // OPA's file watcher needs a moment to reload before the first evaluation.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { applied: true };
}

/**
 * Record a human decision on a held activity — what a reviewer would do in the
 * dashboard. The SDK is polling for exactly this.
 */
export async function decideApproval(
  activityId: string,
  approve: boolean,
): Promise<{ ok: boolean; detail?: string }> {
  const result = await withDb(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE governance_events
          SET verdict = $1, reason = $2
        WHERE activity_id = $3 AND verdict = 2`,
      [approve ? 0 : 3, approve ? 'approved by reviewer' : 'denied by reviewer', activityId],
    );
    return rowCount ?? 0;
  });

  if (result == null) return { ok: false, detail: 'OpenBox database unreachable.' };
  if (result === 0) return { ok: false, detail: 'Nothing pending for that activity.' };
  return { ok: true };
}
