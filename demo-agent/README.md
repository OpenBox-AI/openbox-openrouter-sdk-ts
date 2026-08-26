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
npm run ui     # http://localhost:4545
```

Drives the same governed agent as `npm run agent`, server-side — the
OpenRouter and OpenBox keys never reach the browser. Each row on the page is
one governed activity (every model call and every tool) showing the verdict
Core returned, the policy's reason when it blocks, any remediation directive
it attached, and a deep link into the session in the OpenBox dashboard.

Attach a policy to the agent and the same run shows `BLOCK` / `HALT`, or waits
on `REQUIRE_APPROVAL` while a human decides — the tool body never runs unless
the verdict allows it.

Environment: `UI_PORT` (default 4545), `OPENBOX_DASHBOARD_URL` (default
`http://localhost:3233`). The dashboard link is resolved from the local
OpenBox database (`OPENBOX_DB_*`); without it everything still works, minus
the link.
