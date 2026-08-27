# Demo agent — OpenRouter + OpenBox

A customer-support agent on `@openrouter/agent`, governed by OpenBox. It
consumes the SDK as a **local dependency** (`"openbox-openrouter-governance":
"file:.."`), so it exercises the real published package surface rather than
reaching into `src/`.

## Setup

```bash
cd demo-agent
cp .env.example .env   # fill in your keys
npm install
```

`npm install` links the parent SDK. If you change SDK source, rebuild it so the
demo picks it up:

```bash
cd .. && npm run build && cd demo-agent
```

## Run

```bash
npm run agent                                        # default scenario
npm run agent -- "Where is order A-1001?"            # your own question
npm run agent:stream                                 # stream the answer
```

## Routing integrity showcase

```bash
npm run demo:routing
```

Four real runs that populate the **Routing Integrity** panel in the dashboard:
one with no provider allowlist, one pinned to `openai`, one pinned to `azure`
(the same model, a different real upstream), and one pinned to a provider that
cannot serve the model — which OpenRouter refuses server-side, so the promise
holds by failing rather than by being broken.

Then look at it: **http://localhost:3233/routing-integrity**

Any single run can carry a constraint of its own:

```bash
OPENROUTER_PROVIDER_ONLY=openai npm run agent -- "Where is order A-1001?"
OPENROUTER_PROVIDER_ONLY=openai,azure OPENROUTER_ALLOW_FALLBACKS=false npm run agent
```

`OPENROUTER_PROVIDER_ONLY` is what makes a call *checkable*: without it the
provenance still records who served the prompt, but nothing was promised, so the
call is reported as "unconstrained" rather than as a pass. Setting it also turns
on `captureRequestObjectBody`, which the honored comparison needs — it reads
`provider.only` off the outbound request body, and the OpenRouter client passes a
`Request` whose body is otherwise not captured.

## What it does

Three tools, chosen to exercise different governance paths:

| Tool | Why it's here |
|---|---|
| `lookup_order` | plain read — the baseline case |
| `refund_order` | moves money; the one you'd actually attach a policy to |
| `search_docs` | makes a real outbound HTTP call, so instrumentation records a tool span as well as the model call |

The whole integration is two lines:

```ts
const openbox = createOpenBoxGovernance({ agentName: 'support-agent', onApiError: 'fail_closed' });

const result = await openbox.callModel(callModel, client, {
  model, input: question,
  tools: openbox.tools([lookupOrder, refundOrder, searchDocs]),
});
```

`openbox.tools()` wraps each tool's body; `openbox.callModel()` opens the
workflow, governs the prompt, pre-screens each model call, and closes the
workflow when the run ends. The returned value is the SDK's own `ModelResult`,
so `getText()` / `getTextStream()` work unchanged and stay correctly typed.

## Expected output

```
  [run] model=openai/gpt-4o-mini  question="Order A-1003 arrived damaged. Check it and refund me in full."
  [tool] lookup_order(A-1003)
  [tool] refund_order(A-1003, £12) — Item arrived damaged.

Your order A-1003 has been refunded in full for £12 ...
```

And in OpenBox, one flat activity trail per run:

```
WorkflowStarted    support-agent
SignalReceived     user_prompt
ActivityStarted    llm_call
ActivityCompleted  llm_call
ActivityStarted    lookup_order    [{"orderId": "A-1003"}]
ActivityCompleted  lookup_order    {"total": 12, "status": "delivered", ...}
ActivityStarted    llm_call
ActivityCompleted  llm_call
ActivityStarted    refund_order    [{"amount": 12, "reason": "Item arrived damaged.", ...}]
ActivityCompleted  refund_order    {"refunded": 12, "reference": "RF-A-1003"}
ActivityStarted    llm_call
ActivityCompleted  llm_call
WorkflowCompleted  support-agent
```

## Testing enforcement

Everything above returns `allow`. To see the gates actually fire, attach a
policy to this agent in OpenBox targeting `refund_order`:

- **block** — `refund_order`'s body never runs; the agent exits with code 2 and
  prints `[blocked] OpenBox governance block at tool_start: <reason>`.
- **require_approval** — the call is held open at the `[tool] refund_order(...)`
  line while OpenBox polls (every 3s, up to 5 min) until a human decides.
  Approve and it proceeds; reject and it fails with the reason.

Nothing in the agent code changes for either — enforcement is entirely
server-side policy.

## Configuration

Set in `.env`:

| Variable | Notes |
|---|---|
| `OPENROUTER_API_KEY` | required |
| `OPENROUTER_MODEL` | default `openai/gpt-4o-mini` |
| `OPENBOX_API_URL` | `http://localhost:8086` local, `https://core.openbox.ai` hosted |
| `OPENBOX_API_KEY` | required |
| `OPENBOX_AGENT_DID` | omit with the private key to run unsigned |
| `OPENBOX_AGENT_PRIVATE_KEY` | base64 Ed25519 seed |

## Web UI

```bash
npm run ui     # http://localhost:4545  (UI_PORT to change it)
```

Drives the same governed agent as `npm run agent`, server-side — the
OpenRouter and OpenBox keys never reach the browser. Each row on the page is
one governed activity (every model call and every tool) showing the verdict
Core returned, the policy's reason when it refuses, any remediation directive
it attached, and a deep link into the session in the OpenBox dashboard.

### Scenarios

Six buttons put the agent's policy into a known state before the run, so the
same prompt can be run six ways and the difference is the verdict:

| Scenario | Policy | What you should see |
|---|---|---|
| **Allowed** | none attached | the refund runs, the agent confirms £12 |
| **Blocked** | refunds over £5 refused, capped amount suggested | `refund_order` is refused; the model retries with £5 and that retry is evaluated fresh and allowed |
| **Halted** | refunds stop the session | the tool never runs, no further model call goes out, the run ends with `GovernanceHaltError` |
| **Needs approval** | a refund waits for a human | the row holds on `REQUIRE APPROVAL` with **Approve** / **Deny** — approve and the tool runs, deny and the run ends with the reviewer's reason |
| **Routing narrowed** | prompts may only go to openai; the request names no allowlist | the first `llm_call` is **refused as routed** at both ends and runs nothing — no spans at all. Then an `llm_routing` step, green, carrying *routing to openai (openai/gpt-4o-mini)* started and completed. Then the corrected `llm_call`, green, with the request under it and a *served by OpenAI* span recording who actually took it. Every later call stays green, and the provenance line at the end shows openai served it, honored |
| **Routing refused** | the same policy, against a request asking for azure | the two allowlists have nothing in common, so there is nowhere to route it: the `llm_call` is refused, no routing rows are recorded, and the run ends with `GovernanceBlockedError`. No prompt is sent, and there is no provenance line because there was no call |

The last two keep every verdict true to what happened: the refused attempt is
refused at both ends and executes nothing, the routing that fixed it is its own
step, and the call that runs is a clean allow. The line at the end of a run is
OpenRouter's own record of where the prompt actually went — the same comparison,
from the other end.

Switching a scenario rewrites the rego module OPA is watching and toggles the
policy row Core looks up. That needs the local fixture:

| Variable | Default | What it is |
|---|---|---|
| `OPENBOX_POLICY_FILE` | `/private/tmp/openbox-opa-verify/policy.rego` | the module served by `opa run -s -w <file>` |
| `OPENBOX_POLICY_ID` | the fixture's id | the `policies` row for this agent, whose `config.path` matches the module's package |
| `OPENBOX_DB_*` | localhost / postgres / password / openbox | used to toggle the policy, resolve the session link, and record an approval decision |

Without them the page says so and runs against whatever policy is already
attached — every other part still works.

**Approve / Deny writes the decision a reviewer would make in the dashboard**
(`governance_events.verdict`), which is exactly what the SDK's approval poll is
waiting for. It is a demo convenience, not an approval API.
