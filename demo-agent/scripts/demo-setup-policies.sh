#!/usr/bin/env bash
# demo-setup-policies.sh — deploy the demo's policy rules as BUILDER rules via
# the real backend API, so they show up and stay editable in
# Authorize > Policies instead of being a raw Rego blob nobody can read.
#
# What this creates:
#   ONE policy version for the agent, holding these builder rules in order
#   (array order IS priority — rule N only evaluates if no earlier rule matched):
#
#     1. "Routing — prompts may only go to OpenAI"
#        BLOCK carrying a routing directive (provider.only=[openai],
#        allow_fallbacks=false). This one rule covers BOTH demo scenarios:
#          - `routing`         request declares nothing  -> narrowed to openai
#          - `routing-refuse`  request asks for azure    -> refused, never sent
#        The generator adds a `_already_routed` guard automatically, so the rule
#        stops firing once the run is inside the allowlist and never refuses its
#        own correction. That is what makes one rule enough.
#
#     2. "Refunds require a reviewer"  (or HALT with --halt-refunds)
#        REQUIRE_APPROVAL on activity_type=refund_order — the `approval` demo
#        scenario. Pass --halt-refunds to deploy the `halt` scenario instead.
#
# What this deliberately does NOT create, and why:
#
#   - The `block` scenario (cap a £12 refund at £5). A builder patch can only
#     write the routing/residency directive, never an arbitrary new_input, so
#     the refund-cap patch is not expressible here. It stays raw Rego in
#     src/scenarios.ts.
#
#   - Any residency rule. The server-side generator understands exactly one
#     directive shape — `routing: {only, allowFallbacks}` -> provider.only —
#     and has no reader for residency.regions / require_own_key / models /
#     provider.order. A residency directive sent here is accepted and then
#     silently dropped from the generated Rego, which is worse than not
#     offering it. The `residency` / `residency-breach` scenarios stay raw Rego.
#
# IMPORTANT — why this sends `routing:` and not `patch:`
#
#   The Policies UI serialises a directive as `patch: [{field, value}]`. The
#   backend's generator only reads the older `routing: {only, allowFallbacks}`.
#   And because POST /policies regenerates Rego from the builder config whenever
#   one is present (policy.service.getEffectiveRegoCode), it DISCARDS the Rego
#   the UI generated client-side. Net effect: a directive authored as `patch`
#   deploys as a bare BLOCK — the call is refused and never re-issued, and the
#   already-routed guard is missing too.
#
#   So this script sends `routing:`, which the generator does honour. Verified by
#   diffing generatePolicyBuilderRego output for both shapes.
#
#   Consequence to know about: these rules are readable and editable in the UI,
#   but if you edit one there and redeploy, the UI will rewrite `routing` as
#   `patch` and the directive will be dropped. Re-run this script instead, until
#   the two shapes agree.
#
# Requires:
#   OPENBOX_CONTROL_TOKEN   org API key (obx_key_…), sent as X-API-Key.
#                           Needs create:agent_policy + read:agent_policy.
#   OPENBOX_BACKEND_URL     dashboard API, e.g. http://localhost:3000
#                           (no trailing slash). NOT core's :8086.
#   OPENBOX_AGENT_ID        the OpenRouter agent's uuid. Find it with:
#                             curl -sS -H "X-API-Key: $OPENBOX_CONTROL_TOKEN" \
#                               "$OPENBOX_BACKEND_URL/agent" | python3 -m json.tool
#
# Note on local runs: POST /policies pushes an OPA bundle to S3 at the end. With
# no bucket configured it returns 500 and rolls the policy back, so nothing is
# created. Run this against an env (api-<slug>.node.lat) or staging.
set -euo pipefail

HALT_REFUNDS=0
for arg in "$@"; do
	case "$arg" in
	--halt-refunds) HALT_REFUNDS=1 ;;
	-h | --help)
		sed -n '2,70p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "unknown argument: $arg (try --help)" >&2
		exit 1
		;;
	esac
done

: "${OPENBOX_CONTROL_TOKEN:?set OPENBOX_CONTROL_TOKEN (org API key, obx_key_…)}"
: "${OPENBOX_BACKEND_URL:?set OPENBOX_BACKEND_URL (e.g. http://localhost:3000)}"
: "${OPENBOX_AGENT_ID:?set OPENBOX_AGENT_ID (the OpenRouter agent uuid)}"

api() { # <method> <path> [json-body]
	if [ -n "${3:-}" ]; then
		curl -sS -X "$1" "$OPENBOX_BACKEND_URL$2" \
			-H "X-API-Key: $OPENBOX_CONTROL_TOKEN" \
			-H "Content-Type: application/json" \
			-d "$3"
	else
		curl -sS -X "$1" "$OPENBOX_BACKEND_URL$2" \
			-H "X-API-Key: $OPENBOX_CONTROL_TOKEN"
	fi
}

jqp() { python3 -c "import json,sys; d=json.load(sys.stdin); d=d.get('data',d); print($1)" 2>/dev/null || true; }

# Pretty-print JSON on stdin, falling back to the raw bytes when it is not JSON.
# Callers redirect the whole group, e.g. `{ printf '%s\n' "$resp" | pretty; } >&2`
# — doing the redirection here as `2>/dev/null >&2` would point stdout at the
# already-nulled stderr and swallow the output entirely.
pretty() { python3 -m json.tool 2>/dev/null || cat; }

echo "agent:   $OPENBOX_AGENT_ID"
echo "backend: $OPENBOX_BACKEND_URL"

# ---------------------------------------------------------------------------
# There is no DELETE for policies — the model is versioning. Whatever is
# current now stays in Version History and this deploy supersedes it, so the
# raw-Rego policy the demo ships with is replaced rather than removed.
# ---------------------------------------------------------------------------
current="$(api GET "/agent/$OPENBOX_AGENT_ID/policies/current" || true)"
current_name="$(printf '%s' "$current" | jqp "d.get('name','(none)')")"
echo "superseding current policy: ${current_name:-(none)}"

if [ "$HALT_REFUNDS" -eq 1 ]; then
	refund_decision='HALT'
	refund_reason='refunds are not permitted for this agent'
	refund_rule_name='Refunds halt the run'
else
	refund_decision='REQUIRE_APPROVAL'
	refund_reason='refunds require a reviewer'
	refund_rule_name='Refunds require a reviewer'
fi

body="$(
	REFUND_DECISION="$refund_decision" \
		REFUND_REASON="$refund_reason" \
		REFUND_RULE_NAME="$refund_rule_name" \
		python3 <<'PY'
import json, os

def cond(cid, field, value):
    """One builder condition: <field> equals "<value>" (string)."""
    return {
        "id": cid,
        "left": {"kind": "field", "field": field, "transform": "value", "valueType": "string"},
        "operator": "equals",
        "right": {"kind": "literal", "value": value, "valueType": "string"},
    }

rules = [
    {
        "id": "demo-routing-openai",
        "name": "Routing — prompts may only go to OpenAI",
        "decision": "BLOCK",
        "reason": "this agent may only send prompts to openai",
        "matchMode": "all",
        # Gated on the model call so the directive is not also handed to tool
        # calls, where the SDK would read it as suggested tool arguments.
        "conditions": [cond("demo-routing-cond-1", "activity_type", "llm_call")],
        # The shape the server-side generator honours. See the header note.
        "routing": {"only": ["openai"], "allowFallbacks": False},
    },
    {
        "id": "demo-refund-arm",
        "name": os.environ["REFUND_RULE_NAME"],
        "decision": os.environ["REFUND_DECISION"],
        "reason": os.environ["REFUND_REASON"],
        "matchMode": "all",
        "conditions": [cond("demo-refund-cond-1", "activity_type", "refund_order")],
    },
]

print(json.dumps({
    "name": "OpenRouter demo — routing and refunds",
    "description": (
        "Builder rules for the OpenRouter demo: prompts narrowed to OpenAI "
        "(covers the routing and routing-refuse scenarios), plus the refund arm. "
        "Created by demo-agent/scripts/demo-setup-policies.sh."
    ),
    "config": {"policy_builder": {"version": 2, "rules": rules}},
}, indent=2))
PY
)"

echo "deploying ${#body} bytes of builder config…"
resp="$(api POST "/agent/$OPENBOX_AGENT_ID/policies" "$body")"

policy_id="$(printf '%s' "$resp" | jqp "d.get('id','')")"
if [ -z "$policy_id" ]; then
	echo "--- response ---" >&2
	{ printf '%s\n' "$resp" | pretty; } >&2
	echo >&2
	echo "no policy id in the response." >&2
	echo "If it says 'governance bundle deployment failed' or mentions XML/S3, the" >&2
	echo "backend could not push the OPA bundle — run this against an env, not local." >&2
	exit 1
fi

echo
echo "created policy $policy_id"
echo
echo "the generated Rego (regenerated server-side from the builder config):"
api GET "/agent/$OPENBOX_AGENT_ID/policies/$policy_id" |
	jqp "d.get('rego_code','(none)')" | sed 's/^/    /'

cat <<EOF

verify in the UI:  Authorize > Policies — both rules should render as builder
                   rules, not as "authored as custom Rego"

verify enforcement:
  cd "\$(dirname "\$0")/.."
  npm run agent -- --scenario routing          # narrowed to openai, honored
  npm run agent -- --scenario routing-refuse   # refused before the prompt is sent

still raw Rego in src/scenarios.ts (not builder-expressible — see header):
  block, residency, residency-breach
EOF
