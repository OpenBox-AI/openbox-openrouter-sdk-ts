# @openbox-ai/openbox-openrouter-governance

[![PR Quality](https://github.com/OpenBox-AI/openbox-openrouter-sdk-ts/actions/workflows/pr-quality.yml/badge.svg)](https://github.com/OpenBox-AI/openbox-openrouter-sdk-ts/actions/workflows/pr-quality.yml)
[![npm](https://img.shields.io/npm/v/@openbox-ai/openbox-openrouter-governance.svg)](https://www.npmjs.com/package/@openbox-ai/openbox-openrouter-governance)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Governance and observability for the [OpenRouter Agent SDK](https://openrouter.ai/docs/agent-sdk)
(`@openrouter/agent`), backed by [OpenBox](https://openbox.ai) Core.

Wrap `callModel` and your tools, and every model call and tool execution is
evaluated by policy before it runs, recorded with its inputs and outputs, and
traced down to the HTTP and database calls made inside it. A policy can allow
it, refuse it, stop the run, or hold it open until a human approves.

```
callModel ──▶ WorkflowStarted ──▶ llm_call ──▶ tool ──▶ llm_call ──▶ WorkflowCompleted
                    │                │           │
                    └── every one evaluated, recorded, and enforceable ──┘
```

Governance is enforced where the decision still matters — before a tool runs,
before the next model call goes out, and while a human decides — and everything
the run does is recorded against the session it belongs to.

---

## Install

```bash
npm install @openbox-ai/openbox-openrouter-governance @openrouter/agent
```

Node 18.17+. `@openrouter/agent` is a peer dependency.

## Quickstart

```ts
import { OpenRouter, callModel, tool } from '@openrouter/agent';
import { createOpenBoxGovernance } from '@openbox-ai/openbox-openrouter-governance';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const openbox = createOpenBoxGovernance({
  agentName: 'research-agent',
  // apiKey / openboxUrl / agentDid / agentPrivateKey also read from
  // OPENBOX_API_KEY, OPENBOX_API_URL, OPENBOX_AGENT_DID,
  // OPENBOX_AGENT_PRIVATE_KEY.
});

const result = await openbox.callModel(callModel, client, {
  model: 'anthropic/claude-sonnet-5',
  input: 'Summarize the latest incident report',
  tools: openbox.tools([searchTool, dbTool]),
});

console.log(await result.getText());
await openbox.close();   // always — it drains in-flight telemetry
```

`openbox.callModel` returns the SDK's own `ModelResult`, so every consumption
pattern (`getText`, `getTextStream`, `getToolStream`, …) works unchanged. Only
the pre-flight governance is awaited.

There is a runnable agent with three tools, a CLI and a web UI in
[`demo-agent/`](./demo-agent).

---

## Verdicts: what each one actually does

A policy returns one arm per activity. What matters in practice is its **scope**
— what it stops — and **who enforces it**.

| Arm | Scope | Effect |
|---|---|---|
| `allow` / `monitor` / `constrain` | — | recorded, proceeds |
| `block` | that **activity** | the tool body never runs. The engine reports the refusal to the model, which may adapt or retry — the session continues |
| `halt` (`STOP`) | the whole **session** | the run ends. Core marks the session `halted` and refuses every later event for it |
| `require_approval` | that **activity** | the call is held open while the SDK polls, then resolves to allow, or to a halt on denial/expiry/timeout |

Three consequences worth knowing before you write a policy:

**A block is not always survivable.** Its scope is one activity, but whether the
agent continues depends on whether the engine can proceed without it. Blocking a
tool leaves the model free to try something else. Blocking the pre-flight
`llm_call` ends the run — there is nothing else to do.

**A halt is terminal on Core, and the SDK is what stops the run.**
`@openrouter/agent` catches an error thrown from a tool body and hands it to the
model as an ordinary tool failure, and its `HooksManager` logs and ignores a
throwing hook. So a halt cannot be enforced by throwing. This SDK records the
halt and enforces it where the engine cannot swallow it: no further provider
request leaves the process, every consumption of the result rethrows instead of
returning text, and the run is closed as failed. Without that, a halted session
on Core still handed the caller a perfectly happy answer.

**A block can carry a remediation directive.** Core may attach
`patch: {"new_input": …}` — the input a policy suggests instead. It arrives on
`GovernanceBlockedError.patch` and is appended to the message the model sees, so
the agent can retry — and that retry is governed like any other call. **The SDK
never applies a patch itself**: silently re-running a money-moving tool with
arguments the caller never wrote is not an observability layer's decision.

```
refund_order(A-1003, £12)  →  BLOCK   patch {"new_input": {"amount": 5, …}}
refund_order(A-1003, £5)   →  ALLOW   tool executes
```

Denial, expiry and client-side timeout of an approval all surface as
`GovernanceHaltError`, so `require_approval` resolves into either allow or halt.

---

## What gets governed

| Lifecycle stage | Attached via | Enforcing? |
|---|---|---|
| `beforeAgent` — WorkflowStarted + SignalReceived | awaited inside `callModel()`, before the request goes out | **yes** — block/halt aborts, `require_approval` polls, guardrails redact the prompt |
| `wrapModelCall` — LLMStarted → model → LLMCompleted | LLMStarted pre-screen before each model call; LLMCompleted on `PostModelCall` | **partly** — see below |
| `wrapToolCall` — ToolStarted → tool → ToolCompleted | `openbox.tools()` wraps each tool's `execute`/`run` | **yes** — including holding the call open across a human approval |
| `afterAgent` — WorkflowCompleted | `SessionEnd` hook | n/a (observational by definition) |
| HTTP / DB span capture | `span_processor.ts` + `node_instrumentation.ts` | **yes** — spans are evaluated mid-flight and can abort the call |

### The one real gap

`@openrouter/agent` has no pre-model hook. `PostModelCall` fires after the
tokens are already spent, so the LLMStarted pre-screen is opened at the two
points where the engine is guaranteed to be about to make a call:

1. before `callModel()` invokes the engine (the initial turn), and
2. at the end of a tool round — a tool round is always followed by another
   model call.

A `block`/`halt` verdict at either point aborts before the call. What is not
covered is a call the engine decides to make for some other reason (a retry, a
`Stop`-hook forced resume); those are governed observationally via
`PostModelCall`, plus the HTTP instrumentation, which does intercept the actual
request to OpenRouter mid-flight.

### Tools

`openbox.tools()` handles the shape `tool()` actually returns — the OpenAI wire
form `{type: 'function', function: {name, inputSchema, execute}}` — as well as a
flat `{name, execute}` object. The tool is copied with its property descriptors
and prototype intact, so the engine still accepts it, and your original object
is never mutated.

Two kinds of tool are returned untouched:

- **async-generator `execute`** — wrapping it would mean buffering every yield
  until the tool finished, silently turning a streaming tool into a batch one.
- **manual tools** (no `execute`/`run` body at all).

Both are still governed, through the `PreToolUse` / `PostToolUse` /
`PostToolUseFailure` hooks: a block still blocks, and completion is still
reported. What that path cannot do is hold the call open across a human
approval, or scope http/db spans to the tool. Tools wrapped by `tools()` are
recorded by name so the hook path skips them — no double events, and no asking
a human twice for the same call.

---

## Observability

Spans are recorded for what the run actually does — the model calls, plus any
HTTP, database or file work inside a wrapped tool:

```
POST https://openrouter.ai/api/v1/responses          llm_completion  started
POST https://openrouter.ai/api/v1/responses 200      llm_completion  completed
GET  https://.../ac/?q=refund+policy&type=list       http_get        started
GET  https://.../ac/?q=refund+policy&type=list 200   http_get        completed
SELECT mysql                                          db_query        started
SELECT mysql                                          db_query        completed
```

**Drivers.** `pg`, `mysql2` (promise, callback, **pool**, and event-emitter
call shapes), `mongodb`, `ioredis`, and `redis` (node-redis v4 — its typed
commands dispatch through a private path that a naïve `sendCommand` patch never
sees). Drivers are resolved from the **host application's** `node_modules` by
scanning `require.cache`; requiring them from this package resolves nothing.
File IO is off by default (`instrumentFileIo`).

**Streaming bodies are teed, never buffered** — a slow turn must not stall the
caller's stream. The model's SSE transcript is collapsed to its terminal
`response` object before storage, because Core parses span bodies as JSON, which
is where token counts and the model id come from.

**Lazy results are proxied.** `callModel` performs no I/O until you consume it,
and that consumption runs in *your* async context, outside the activity scope.
The result is proxied so each method re-enters the scope; async iterables are
wrapped per pull, because a generator's body resumes in the **consumer's**
context. Without both, a streaming run recorded zero spans while the identical
non-streaming run recorded six.

---

## Routing provenance

OpenRouter makes its users two promises that pull against each other. One is
trust — *"ensure prompts only go to the models and providers you trust"*. The
other is reliability — 80+ providers with automatic fallback when one is down.
Together they mean the provider that serves any given call is chosen at request
time, per call, and **the caller cannot see which one it was**. The response
does not say. For anyone with a data-residency clause, a provider allowlist, or
an auditor, "we routed it correctly" is a claim they have to take on faith.

OpenRouter does publish the answer — `GET /api/v1/generation?id=<gen-id>`
returns the provider that served the call, the region it ran in, what it cost,
whether your own key was used, and the fallback attempts that preceded it. This
SDK reads that record for every governed model call, which lets OpenBox do
three things with it that a gateway alone cannot:

**Enforce it.** The record arrives as a span, so a policy decides on it:

```rego
trusted := {"anthropic"}

untrusted contains provider if {
	some span in input.spans
	provider := lower(span.attributes["gen_ai.upstream.provider"])
	not provider in trusted
}

result := {
	"decision": "STOP",
	"reason": sprintf("prompt was served by an untrusted provider: %v", [concat(", ", untrusted)]),
} if { count(untrusted) > 0 }
```

Run an agent under that policy and the session ends `halted`, with the reason
recorded against the model call that broke the rule.

**Attest it.** The record travels in span *attributes*, which is what Core
hashes into the session's Merkle tree — so it is sealed under the signed
session root. "Every prompt in this session was served by an approved provider
in an approved region" stops being a log line someone could edit and becomes a
statement backed by a signature.

**Check the promise.** The routing the caller *asked for* travels with the
record, so `provider.only: ["anthropic"]` versus what actually served the call
is a comparison anyone can make — `openbox.routing.honored` is the answer.

What lands on each model call:

| Attribute | |
|---|---|
| `gen_ai.upstream.provider` | who actually served it |
| `gen_ai.upstream.data_region` | where it ran |
| `gen_ai.usage.total_cost` · `…upstream_cost` | what it cost |
| `gen_ai.upstream.is_byok` | whether your key was used |
| `gen_ai.routing.providers_tried` · `…fallback_attempts` | the failover trail |
| `openbox.routing.requested_only` · `…honored` | what was asked for, and whether it held |
| `gen_ai.generation.id` | OpenRouter's receipt number, so any claim can be re-checked at source |

### Timing, and what it costs you

The generation record is written shortly *after* the response, not with it — a
lookup at turn close returns 404. So collection runs in the background with
backoff and is drained before the session closes: it never delays an answer,
and it still lands inside the session (and therefore inside the attestation).
A run whose last turn finishes at once may take a few extra seconds to close
while the last record is fetched.

It needs an OpenRouter key (`openrouterApiKey`, or `OPENROUTER_API_KEY`) and is
inert without one. Turn it off with `attestRouting: false` or
`OPENBOX_ATTEST_ROUTING=false`.

**One honest boundary:** because the record exists only after the call, this is
evidence and session-level enforcement, not a pre-flight gate. A prompt already
sent cannot be unsent. What a policy can do is refuse the *next* one and halt
the session — which is exactly what you want when the router silently fails
over to a provider your contract excludes.

## What governance costs

Every evaluation is a round-trip to Core, which starts a Temporal workflow and
awaits it: **~1.0s idle, ~2.0s under concurrent load**. That is the dominant
cost of instrumenting a fast tool, so it is worth understanding the shape:

| A tool that does | Costs about |
|---|---|
| one gated operation | ~1s |
| one Postgres query (promise API) | ~2s — gated twice by design: before it runs, and on its results |
| four **concurrent** queries | ~one round — different operations' spans travel concurrently |
| four **sequential** queries | ~four rounds — the application serialized them |

`spanConcurrency` (default 4) bounds how many of an activity's spans are in
flight at once; set it to `1` for strictly serial delivery. Ordering within one
operation is always preserved.

---

## Configuration

```ts
createOpenBoxGovernance({
  agentName: 'research-agent',
  sessionId: 'user-42',
  taskQueue: 'openrouter',          // default
  onApiError: 'fail_open',          // or 'fail_closed'
  governanceTimeout: 30,            // seconds
  toolTypeMap: { db_query: 'database' },
  skipToolTypes: new Set(['echo']),
  hitl: { enabled: true, pollIntervalMs: 5000, timeoutMs: 60 * 60 * 1000 },
  instrumentHttp: true,             // default
  instrumentDatabases: true,        // default; pg/mysql2/mongodb/redis/ioredis
  instrumentFileIo: false,          // default
  spanConcurrency: 4,               // default; OPENBOX_SPAN_CONCURRENCY
  captureRequestObjectBody: false,  // default — see below
  transport: myTransport,           // bring your own HTTP stack
});
```

`onApiError: 'fail_open'` (the default) lets the run continue when Core is
unreachable. `'fail_closed'` aborts it. Auth failures (401/403) always
hard-fail regardless — a revoked key must never silently degrade to "run
ungoverned".

`captureRequestObjectBody` is off for a reason: reading a body off a `Request`
requires cloning it, which leaves the caller's object in a state their retry
logic cannot reuse. With it on, roughly a quarter of real runs died with
`Cannot construct a Request with a Request object that has already been used`.
Response bodies — where token counts live — are unaffected.

---

## Event ordering

Core orders a session by the timestamp the SDK stamps, and `Date.now()` is
neither unique nor monotonic. So every event gets a strictly increasing
timestamp within its run plus an explicit, gapless `sequence`, and a small set
of invariants is checked as events are built (a completion needs a start; an
activity completes once; nothing after the workflow closes). Violations are
logged, never thrown — a dropped governance event is worse than an out-of-order
one.

A parallel tool round legitimately produces several starts before any
completion. **Pair events by `activity_id`, not by adjacency.**

`findSequenceViolations(events)` replays the rules over rows read back from
Core, to tell a genuinely invalid order from mere concurrency.

---

## Demo

```bash
cd demo-agent
npm run agent            # CLI, one prompt
npm run agent:stream     # stream the answer
npm run ui               # web UI on http://localhost:4545
```

The UI drives the same governed agent server-side (keys never reach the
browser) and streams every governance decision to the page as it happens, with
a deep link into the session in the OpenBox dashboard.

---

## Tests

```bash
npm test        # unit suite: fake engine + fake transport, no network, no keys
npm run typecheck
```

The suite replays the engine's real hook order against a fake transport, so it
covers event ordering, verdict enforcement, halt semantics, and the driver call
shapes without needing a server.

What it cannot prove is enforcement end to end — that needs a real Core with
OPA running and a policy attached to the agent. Exercise each arm by pointing a
policy at a tool (the SDK sends a tool's name as `activity_type`) and checking
both what the agent did and what Core recorded: a blocked tool must not run, a
halted run must not answer, and an approval must hold the call open until it is
decided.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, branch and PR conventions,
and what a change needs before it lands. Releases are cut by bumping the
version on `main` — see [RELEASING.md](./RELEASING.md).

Security issues go to **security@openbox.ai**, not to a public issue — see
[SECURITY.md](./SECURITY.md).

## License

[Apache-2.0](./LICENSE)
