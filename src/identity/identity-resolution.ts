/**
 * Pure identity-method resolution + validation helpers, ported from
 * `openbox-sdk-ts` `src/config/identity-resolution.ts` (proposal §13.1, IAM v3
 * workload mode). Field names and env names match the base SDK so its docs
 * carry across. Kept separate from config/index.ts so the (already
 * large) layered-env config class doesn't also own this branching — every
 * function here is a plain data transform, easy to unit test in isolation.
 *
 * No crypto/network imports.
 */

/** An identity method a caller can select (`OPENBOX_AGENT_IDENTITY_METHOD`). */
export type AgentIdentityMethod = 'openbox_did' | 'okta_ai_agent' | 'keycloak_workload';

export const AGENT_IDENTITY_METHODS: readonly AgentIdentityMethod[] = [
  'openbox_did',
  'okta_ai_agent',
  'keycloak_workload',
];

export type ResolvedIdentityMethod = AgentIdentityMethod | "legacy_unsigned";

/** The flat, env-resolved identity fields `OpenBoxConfig` carries. */
export interface IdentityFields {
  identityMethod: AgentIdentityMethod | null;
  agentDid: string | null;
  agentPrivateKey: string | null;
  oktaAgentId: string | null;
  oktaAgentKeyId: string | null;
  oktaAgentPrivateKey: string | null;
  oktaAgentAlgorithm: string | null;
  agentId: string | null;
  organizationId: string | null;
  deploymentId: string | null;
  agentProofAudience: string | null;
  workloadPrivateKey: string | null;
}

function hasDidFields(fields: IdentityFields): boolean {
  return Boolean(fields.agentDid) || Boolean(fields.agentPrivateKey);
}

function hasOktaFields(fields: IdentityFields): boolean {
  return (
    Boolean(fields.oktaAgentId) ||
    Boolean(fields.oktaAgentKeyId) ||
    Boolean(fields.oktaAgentPrivateKey)
  );
}

/**
 * Resolve the active method: explicit wins; DID fields infer `openbox_did`;
 * the neutral workload key infers `keycloak_workload`; Okta fields infer
 * `okta_ai_agent`; none infers `legacy_unsigned` (proposal §13.1 rules 1-2).
 *
 * An Okta key alone never infers `keycloak_workload` — upgrading the package
 * must not silently move an Okta v2 client onto v3. Conflicting combinations
 * are rejected by `describeWorkloadConflict`, so inference order only matters
 * for configurations that are otherwise valid.
 */
export function resolveIdentityMethod(fields: IdentityFields): ResolvedIdentityMethod {
  if (fields.identityMethod) return fields.identityMethod;
  if (hasDidFields(fields)) return "openbox_did";
  if (fields.workloadPrivateKey) return "keycloak_workload";
  if (hasOktaFields(fields)) return "okta_ai_agent";
  return "legacy_unsigned";
}

const DID_FIELD_LABELS: Array<[key: keyof IdentityFields, label: string]> = [
  ["agentDid", "agentDid (OPENBOX_AGENT_DID)"],
  ["agentPrivateKey", "agentPrivateKey (OPENBOX_AGENT_PRIVATE_KEY)"]
];

/**
 * Okta-only settings that are leftovers in workload mode. The Okta private key
 * is absent on purpose: under an explicit `keycloak_workload` selection it is
 * the documented migration alias for the workload key.
 */
const OKTA_LEFTOVER_FIELD_LABELS: Array<[key: keyof IdentityFields, label: string]> = [
  ["agentId", "agentId (OPENBOX_AGENT_ID)"],
  ["organizationId", "organizationId (OPENBOX_ORGANIZATION_ID)"],
  ["deploymentId", "deploymentId (OPENBOX_DEPLOYMENT_ID)"],
  ["agentProofAudience", "agentProofAudience (OPENBOX_AGENT_PROOF_AUDIENCE)"],
  ["oktaAgentId", "oktaAgentId (OPENBOX_OKTA_AGENT_ID)"],
  ["oktaAgentKeyId", "oktaAgentKeyId (OPENBOX_OKTA_AGENT_KEY_ID)"],
  ["oktaAgentAlgorithm", "oktaAgentAlgorithm (OPENBOX_OKTA_AGENT_ALGORITHM)"]
];

const WORKLOAD_KEY_LABEL = "workloadPrivateKey (OPENBOX_WORKLOAD_PRIVATE_KEY)";
const OKTA_KEY_LABEL = "oktaAgentPrivateKey (OPENBOX_OKTA_AGENT_PRIVATE_KEY)";

function presentLabels(
  fields: IdentityFields,
  labels: Array<[key: keyof IdentityFields, label: string]>
): string[] {
  return labels.filter(([key]) => Boolean(fields[key])).map(([, label]) => label);
}

/**
 * Describe why a `keycloak_workload` configuration is unusable, naming every
 * offending field, or `null` when there is no workload conflict (including
 * when workload mode is not involved at all).
 *
 * Workload mode is selected by an explicit `identityMethod` or by the neutral
 * `workloadPrivateKey`. It rejects DID fields, leftover Okta metadata, and the
 * neutral key together with its Okta alias — the SDK never guesses which of two
 * credentials wins.
 */
export function describeWorkloadConflict(fields: IdentityFields): string | null {
  const explicit = fields.identityMethod === "keycloak_workload";
  const neutralKey = Boolean(fields.workloadPrivateKey);
  if (!explicit && !neutralKey) return null;

  if (!explicit && fields.identityMethod !== null) {
    return (
      `${WORKLOAD_KEY_LABEL} is used only by identityMethod 'keycloak_workload', but identityMethod ` +
      `is '${fields.identityMethod}'. Remove the workload key or select 'keycloak_workload'.`
    );
  }
  if (neutralKey && fields.oktaAgentPrivateKey) {
    return (
      `Both ${WORKLOAD_KEY_LABEL} and its migration alias ${OKTA_KEY_LABEL} are configured. ` +
      "Configure exactly one workload private key; the SDK never guesses which credential wins."
    );
  }

  const conflicting = [
    ...presentLabels(fields, DID_FIELD_LABELS),
    ...presentLabels(fields, OKTA_LEFTOVER_FIELD_LABELS)
  ];
  if (conflicting.length > 0) {
    return (
      `Keycloak workload identity (keycloak_workload) cannot be combined with: ${conflicting.join(", ")}. ` +
      "Workload metadata comes from OpenBox Core; remove the conflicting setting(s)."
    );
  }

  if (explicit && !neutralKey && !fields.oktaAgentPrivateKey) {
    return (
      `identityMethod is 'keycloak_workload' but no workload private key is configured: set ${WORKLOAD_KEY_LABEL}. ` +
      "OpenBox never holds or returns an agent's private key."
    );
  }
  return null;
}

/**
 * The PKCS8 PEM a `keycloak_workload` client authenticates with: the neutral
 * key, or the Okta key as the documented migration alias under an explicit
 * `keycloak_workload` selection. `null` for every other method.
 */
export function resolveWorkloadPrivateKey(fields: IdentityFields): string | null {
  if (resolveIdentityMethod(fields) !== "keycloak_workload") return null;
  if (fields.workloadPrivateKey) return fields.workloadPrivateKey;
  if (fields.identityMethod === "keycloak_workload" && fields.oktaAgentPrivateKey) {
    return fields.oktaAgentPrivateKey;
  }
  return null;
}

/**
 * Describe DID vs Okta fields present together (mutual exclusion, proposal
 * §13.1 rule 5), naming every offending field, or `null` when there is no
 * conflict.
 */
export function describeMutualExclusionConflict(fields: IdentityFields): string | null {
  if (!hasDidFields(fields) || !hasOktaFields(fields)) return null;
  const didNames: string[] = [];
  if (fields.agentDid) didNames.push("agentDid");
  if (fields.agentPrivateKey) didNames.push("agentPrivateKey");
  const oktaNames: string[] = [];
  if (fields.oktaAgentId) oktaNames.push("oktaAgentId");
  if (fields.oktaAgentKeyId) oktaNames.push("oktaAgentKeyId");
  if (fields.oktaAgentPrivateKey) oktaNames.push("oktaAgentPrivateKey");
  return (
    `OpenBox DID fields (${didNames.join(", ")}) and Okta fields (${oktaNames.join(", ")}) ` +
    "are mutually exclusive; configure exactly one identity method."
  );
}

/**
 * Every field the `okta_ai_agent` method requires (proposal §13.1 rule 4).
 * Returns the labels of any missing ones (empty array when complete) — fail
 * at construction, not at first request.
 */
export function listMissingOktaFields(fields: IdentityFields): string[] {
  const required: Array<[value: string | null, label: string]> = [
    [fields.agentId, "agentId (OPENBOX_AGENT_ID)"],
    [fields.organizationId, "organizationId (OPENBOX_ORGANIZATION_ID)"],
    [fields.deploymentId, "deploymentId (OPENBOX_DEPLOYMENT_ID)"],
    [fields.oktaAgentId, "oktaAgentId (OPENBOX_OKTA_AGENT_ID)"],
    [fields.oktaAgentKeyId, "oktaAgentKeyId (OPENBOX_OKTA_AGENT_KEY_ID)"],
    [fields.oktaAgentAlgorithm, "oktaAgentAlgorithm (OPENBOX_OKTA_AGENT_ALGORITHM)"],
    [fields.oktaAgentPrivateKey, "oktaAgentPrivateKey (OPENBOX_OKTA_AGENT_PRIVATE_KEY)"],
    [fields.agentProofAudience, "agentProofAudience (OPENBOX_AGENT_PROOF_AUDIENCE)"]
  ];
  return required.filter(([value]) => !value).map(([, label]) => label);
}

/**
 * How an `okta_ai_agent` configuration supplies its identity metadata.
 *
 * - `bootstrap`  — only the private key is local; Core supplies the rest.
 * - `legacy`     — every metadata field is configured locally; no bootstrap call.
 * - `mixed`      — SOME metadata fields are configured. Rejected, never merged.
 *
 * `mixed` is an error rather than a "fill in the gaps from Core" convenience
 * because partially-stale local metadata is the exact failure this feature
 * exists to eliminate: a leftover `oktaAgentKeyId` from before a rotation would
 * silently win over the correct value Core would have supplied.
 */
export type OktaConfigMode = "bootstrap" | "legacy" | "mixed";

/**
 * The metadata fields Core supplies in bootstrap mode, and their env names.
 *
 * `oktaAgentAlgorithm` is deliberately NOT here: it is an algorithm constraint
 * rather than identity metadata, it is harmless to leave set to its only
 * allowed value, and the algorithm actually used is the one Core returns
 * (re-checked as RS256 on arrival).
 */
const BOOTSTRAP_MANAGED_FIELDS: Array<[key: keyof IdentityFields, label: string]> = [
  ["agentId", "agentId (OPENBOX_AGENT_ID)"],
  ["organizationId", "organizationId (OPENBOX_ORGANIZATION_ID)"],
  ["deploymentId", "deploymentId (OPENBOX_DEPLOYMENT_ID)"],
  ["agentProofAudience", "agentProofAudience (OPENBOX_AGENT_PROOF_AUDIENCE)"],
  ["oktaAgentId", "oktaAgentId (OPENBOX_OKTA_AGENT_ID)"],
  ["oktaAgentKeyId", "oktaAgentKeyId (OPENBOX_OKTA_AGENT_KEY_ID)"]
];

/** The bootstrap-managed fields that are set — the "unexpected" list for `mixed`. */
export function listUnexpectedBootstrapFields(fields: IdentityFields): string[] {
  return BOOTSTRAP_MANAGED_FIELDS.filter(([key]) => Boolean(fields[key])).map(([, label]) => label);
}

/**
 * Classify an `okta_ai_agent` configuration into exactly one mode.
 *
 * Callers must have already established that the resolved method is
 * `okta_ai_agent`; this function only decides how its metadata arrives.
 */
export function classifyOktaConfigMode(fields: IdentityFields): OktaConfigMode {
  const present = listUnexpectedBootstrapFields(fields);
  if (present.length === 0) return "bootstrap";
  if (present.length === BOOTSTRAP_MANAGED_FIELDS.length) return "legacy";
  return "mixed";
}

/** The error text for a `mixed` configuration, naming the offending fields. */
export function describeMixedOktaConfig(fields: IdentityFields): string {
  const present = listUnexpectedBootstrapFields(fields);
  const missing = BOOTSTRAP_MANAGED_FIELDS.filter(([key]) => !fields[key]).map(([, label]) => label);
  return (
    "Okta identity configuration is incomplete and cannot be combined with identity bootstrap. " +
    `Configured: ${present.join(", ")}. Missing: ${missing.join(", ")}. ` +
    "Either remove the configured field(s) to let OpenBox Core supply all identity metadata " +
    "(bootstrap mode, requiring only apiUrl, apiKey and oktaAgentPrivateKey), or configure every " +
    "remaining field for fully explicit configuration."
  );
}

/** Only RS256 is allowlisted; the error text for any other algorithm, else null. */
function describeOktaAlgorithmProblem(algorithm: string | null): string | null {
  return algorithm === "RS256"
    ? null
    : `oktaAgentAlgorithm must be 'RS256' (got ${JSON.stringify(algorithm)}); only RS256 is allowlisted.`;
}

/**
 * The offline configuration error for an `okta_ai_agent` identity, or null
 * when it is valid. Callers must have already established that the resolved
 * method is `okta_ai_agent`.
 */
export function describeOktaConfigProblem(fields: IdentityFields): string | null {
  // The private key is the one value Core can never supply, in either mode.
  if (!fields.oktaAgentPrivateKey) {
    return (
      "Okta agent identity requires oktaAgentPrivateKey (OPENBOX_OKTA_AGENT_PRIVATE_KEY); " +
      "OpenBox never holds or returns an agent's private key."
    );
  }

  switch (classifyOktaConfigMode(fields)) {
    case "mixed":
      return describeMixedOktaConfig(fields);
    case "legacy": {
      // Fully explicit configuration — unchanged from before bootstrap
      // existed, so an already-deployed runtime keeps working verbatim.
      const missing = listMissingOktaFields(fields);
      if (missing.length > 0) {
        return `Okta agent identity is missing required field(s): ${missing.join(", ")}.`;
      }
      return describeOktaAlgorithmProblem(fields.oktaAgentAlgorithm);
    }
    case "bootstrap":
      // Nothing further to validate offline. The remaining checks — key
      // parsing, RSA size, and the thumbprint match against the selected
      // credential — need the private key and the network, and belong to the
      // bootstrap step itself. `normalized()` stays pure and offline, which
      // is what lets it keep running inside constructors.
      //
      // An explicitly set algorithm must still be the allowlisted one, so a
      // stale `OPENBOX_OKTA_AGENT_ALGORITHM=RS512` fails here rather than
      // being silently ignored.
      return fields.oktaAgentAlgorithm === null ? null : describeOktaAlgorithmProblem(fields.oktaAgentAlgorithm);
  }
}
