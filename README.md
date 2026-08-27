# openbox-openrouter-governance

[![PR Quality](https://github.com/OpenBox-AI/openbox-openrouter-sdk-ts/actions/workflows/pr-quality.yml/badge.svg)](https://github.com/OpenBox-AI/openbox-openrouter-sdk-ts/actions/workflows/pr-quality.yml)
[![npm](https://img.shields.io/npm/v/openbox-openrouter-governance.svg)](https://www.npmjs.com/package/openbox-openrouter-governance)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

Governance and observability for the [OpenRouter Agent SDK](https://openrouter.ai/docs/agent-sdk)
(`@openrouter/agent`), backed by [OpenBox](https://openbox.ai) Core.

Wrap `callModel` and your tools, and every model call and tool execution is
evaluated by policy before it runs, recorded with its inputs and outputs, and
traced down to the HTTP and database calls made inside it. A policy can allow
it, refuse it, redirect where it goes, stop the run, or hold it open until a
human approves.

```
callModel ──▶ WorkflowStarted ──▶ llm_call ──▶ tool ──▶ llm_call ──▶ WorkflowCompleted
                    │                │           │
                    └── every one evaluated, recorded, and enforceable ──┘
```

Governance is enforced where the decision still matters — before a tool runs,
before the next model call goes out, and while a human decides — and everything
the run does is recorded against the session it belongs to.

That includes **where each prompt goes**. OpenRouter chooses a provider per
request and the response does not say which one it was, so this SDK governs both
ends of that: [where a call may be routed](#routing-to-the-model), decided before
the request is built and enforceable by policy, and [who actually served
it](#routing-provenance), read back from OpenRouter's own record and sealed under
the session's signed root.

---

## Install

```bash
npm install openbox-openrouter-governance @openrouter/agent
```

Node 18.17+. `@openrouter/agent` is a peer dependency.

## Quickstart

```ts
import { OpenRouter, callModel, tool } from '@openrouter/agent';
import { createOpenBoxGovernance } from 'openbox-openrouter-governance';

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

**With one exception: routing.** A directive that names where a prompt may go is
applied by the SDK itself, because it can only ever remove destinations — it
cannot make a request do anything the caller did not ask for, only send it
somewhere they already allowed. See [Routing to the
model](#routing-to-the-model).

Denial, expiry and client-side timeout of an approval all surface as
`GovernanceHaltError`, so `require_approval` resolves into either allow or halt.

---

## What gets governed

| Lifecycle stage | Attached via | Enforcing? |
|---|---|---|
| `beforeAgent` — WorkflowStarted + SignalReceived | awaited inside `callModel()`, before the request goes out | **yes** — block/halt aborts, `require_approval` polls, guardrails redact the prompt |
| `wrapModelCall` — LLMStarted → model → LLMCompleted | LLMStarted pre-screen before each model call; LLMCompleted on `PostModelCall` | **partly** — see below |
| `llm_routing` — where the call may go | a routing claim on each `llm_call`, decided before the request is built | **yes** — refuse the call, or redirect it and let the corrected one run |
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

The same record settles a second question: *did I get the model I paid for?*
The model the provider actually ran is compared to the model the request asked
for → `openbox.model.honored`. A model the caller declared in their own
`models` fallback chain counts as honored — they listed it — and
`openrouter/auto` is reported as unchecked rather than as a pass, because
choosing the model is the promise there. Unlike the provider check, nearly
every request names a model, so this one speaks for almost all of the traffic.

The span is also what the dashboard's routing-integrity panel reads. It is the
only channel this record has: `routingSummaries()` returns the same figures
in-process, and the summary sent on `WorkflowCompleted.extra` never reaches
storage — Core's payload struct has no such field and drops it at unmarshal, the
same way it drops `workflow_output`. So the span is not a display choice; remove
it and routing provenance reaches Core nowhere.

What lands on each model call:

| Attribute | |
|---|---|
| `gen_ai.upstream.provider` | who actually served it |
| `gen_ai.upstream.data_region` | where it ran |
| `gen_ai.usage.total_cost` · `…upstream_cost` | what it cost |
| `gen_ai.upstream.is_byok` | whether your key was used |
| `gen_ai.routing.providers_tried` · `…fallback_attempts` | the failover trail |
| `openbox.routing.requested_only` · `…honored` | what was asked for, and whether it held |
| `gen_ai.response.model` · `openbox.model.requested` · `openbox.model.honored` | the model that ran, the model asked for, and whether they match |
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

**The boundary this leaves:** the record exists only after the call, so on its
own it is evidence and session-level enforcement. A prompt already sent cannot
be unsent. Refusing the *next* one and halting the session is exactly what you
want when the router silently fails over — but it is not a gate.

## Routing to the model

Where a call is going is stated on the call itself, as a span, before the request
is built. A policy that refuses it is refusing **this model call as routed** —
and a refusal means what it means everywhere else in this SDK: that activity does
not run, at either end of it. When the policy also says where the prompt may go
instead, routing happens as its own step and the corrected call follows:

```
llm_call     started    BLOCK   "not to that provider"   ← no spans: nothing ran
llm_call     completed  BLOCK                             ← closed on the same verdict
llm_routing  started    ALLOW
  ├─ routing to openai (openai/gpt-4o-mini)  started
  └─ routing to openai (openai/gpt-4o-mini)  completed
llm_routing  completed  ALLOW
llm_call     started    ALLOW
  ├─ POST openrouter.ai/api/v1/responses  started
  └─ POST openrouter.ai/api/v1/responses  completed  200
llm_call     completed  ALLOW
```

Three properties this holds to:

**A refused activity does not execute, and says so at both ends.** The refused
attempt has no spans — no request was ever built under it — and its completion
carries the same verdict as its start, along with why it was refused and what
happened next: *blocked: this agent may only send prompts to openai — nothing
was sent; routing to openai (openai/gpt-4o-mini) and retried*. A start that says BLOCK and a completion
that says ALLOW would be a record contradicting itself: nothing about the call
changed between the two, so nothing about the verdict should either. That is why
a refusal closes on the same claim it was refused on, rather than on a fresh
evaluation with nothing to object to.

**Routing is its own step.** Deciding where a prompt may go is a different thing
from calling the model, so it is a different activity, with the two halves of the
routing under it. They name the destination — the provider the policy allows and
the model it serves — because "routing" on a row beneath a model call tells a
reader nothing they cannot already see.

**The corrected call is a new call.** Evaluated fresh, allowed, and the only one
that runs.

The routing step appears **only when a policy actually redirects**. An ordinary
call — no policy, or a policy that is satisfied — is one `llm_call`, one
round-trip, nothing extra.

The claim is written in the same attribute vocabulary the provenance record
uses, so one rule reads both ends:

| Attribute | |
|---|---|
| `openbox.routing.declared` | whether this call named an allowlist at all |
| `openbox.routing.requested_only` · `…requested_order` · `…requested_models` | where it may go |
| `openbox.routing.allow_fallbacks` | whether it fails closed |
| `openbox.routing.redirected_from` · `…resolution` | on the record: what it asked for, and where it went |
| `gen_ai.request.model` | the model asked for |

```rego
routing := span if {
	some span in input.spans
	span.hook_type == "llm_routing_request"
}

# "no prompt leaves this agent without an allowlist" — decidable, before it goes.
result := {"decision": "BLOCK", "reason": "routing must be constrained"} if {
	routing
	routing.attributes["openbox.routing.declared"] == false
}
```

Three things a policy can do here that provenance alone cannot:

**Refuse before the prompt is sent.** The request was never built. Nothing left
the process, and no routing rows are written, because nothing was routed
anywhere.

**Redirect it.** Attach the routing to use instead, and the corrected call goes
there:

```rego
result := {
	"decision": "BLOCK",
	"reason": "this agent may only send prompts to openai",
	"patch": {"new_input": {"provider": {"only": ["openai"], "allow_fallbacks": false}}},
} if {
	routing
	{lower(p) | some p in object.get(routing.attributes, "openbox.routing.requested_only", [])} != {"openai"}
}
```

Only ever **narrower**. `only` and `models` intersect with what the caller
named, so a policy can never route a prompt somewhere the caller did not allow;
`allow_fallbacks` is false if either side says so. This is the one directive the
SDK applies on its own initiative, and that is why: it cannot make a request do
anything the caller did not ask for, only send it to fewer places. (Contrast
`patch.new_input` on a *tool*, which is offered to the model and never applied —
see [Verdicts](#verdicts-what-each-one-actually-does).)

**Fail closed on a contradiction.** If the policy allows only `openai` and the
request named `azure` alone, nothing satisfies both. The call is refused rather
than resolved in either party's favour.

### Asked one way, recorded another

The claim rides on the model call's own event, because that is what a policy is
given: Core binds an event's spans into policy input. The record is written
through the hook-span path, because that is what Core *persists* — spans on a
lifecycle event reach the policy but are never stored (measured, not assumed).
So the question and the record travel differently on purpose, and the record
carries the routing now in force rather than the one that was refused — a record
restating the refused routing would be re-judged by the rule that rejected it.

### Why a redirect is spelled as a block, and what that costs

`BLOCK` is the only arm Core forwards a `patch` on, and `patch.new_input` the
only key it forwards — `CONSTRAIN`, `ALLOW` and `MONITOR` all arrive with the
directive stripped (measured against Core, not assumed).

That is why a redirect costs a refused attempt. What a policy means by "route it
to openai instead" is a **constraint**, not a refusal: it is not saying the model
may not be called. But the only channel that carries the instruction also
declares the call refused, and a refused call must not then execute — so the SDK
honours the refusal literally and opens a corrected call rather than quietly
resuming the blocked one. The record stays true at the cost of one extra
evaluation per redirect.

If Core forwards a `patch` on `constrain`, this collapses to what it should be:
one `llm_call`, allowed under a constraint, with the routing recorded inside it
and no refused attempt at all. `constrain` is already accepted by
`readRoutingDirective`, so policies would change one word and nothing in this
SDK would need to change.

### The two boundaries

- **Only the first turn's request is rewritable.** From turn two the request
  lives inside the engine, so a directive that would change where that turn's
  prompt goes is *refused*, not ignored — the one thing worse than not applying
  a constraint is appearing to. In practice a redirected run restates the
  narrowed constraint from then on, so a satisfied policy stops firing.
- **A halt still ends the session**, and an approval still holds the call open;
  a routing directive only ever turns a *block* into a redirect.

Turn it off with `preflightRouting: false` or `OPENBOX_PREFLIGHT_ROUTING=false` —
which does not make routing unenforceable, only un-preventable: the provenance
record still lands, and a policy can still halt the session on it.

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
  preflightRouting: true,           // default; OPENBOX_PREFLIGHT_ROUTING
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
