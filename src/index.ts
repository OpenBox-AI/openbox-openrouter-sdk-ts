/**
 * OpenBox governance for the OpenRouter Agent SDK.
 *
 * Public surface mirrors the n8n node's `shared/langchain/index.ts`, plus the
 * `openrouter.ts` binding that attaches the middleware to `@openrouter/agent`.
 */

export { createOpenBoxGovernance, type OpenBoxGovernance } from './openrouter';
export { OpenBoxOpenRouterMiddleware } from './middleware';

export { GovernanceClient, type ApprovalPollResponse, type OnApiError } from './client';
export {
  ALL_DATABASE_DRIVERS,
  DEFAULT_APPROVAL_MAX_WAIT_MS,
  mergeConfig,
  type DatabaseDriverName,
  type GovernanceConfig,
  type HITLConfig,
  type Logger,
  type OpenBoxOpenRouterOptions,
} from './config';
export {
  FetchTransport,
  GovernanceAuthError,
  SoftGovernanceError,
  DEFAULT_OPENBOX_URL,
  resolveCredentials,
  type OpenBoxCredentials,
  type OpenBoxRequestOptions,
  type OpenBoxTransport,
} from './transport';
export {
  handleAfterAgent,
  handleBeforeAgent,
  handleWrapMemoryOp,
  handleWrapModelCall,
  type AgentState,
} from './hook_handlers';
export { handleWrapToolCall } from './tool_hook';
export {
  applyPiiRedaction,
  baseEventFields,
  buildEvent,
  evaluate,
  extractGovernanceBlocked,
  extractLastUserMessage,
  extractPromptFromMessages,
  extractResponseMetadata,
  hasHumanTurn,
  sendOrphanClosure,
  serializeMessagesToOpenAiBody,
  serializeResponseToOpenAiBody,
  turnFromError,
  type Turn,
} from './hooks';
export {
  EventSequencer,
  findSequenceViolations,
  isMonotonic,
  releaseSequencer,
  resetSequencers,
  sequencerFor,
  type SequenceViolation,
} from './event-sequence';
export { safeString, toErrorInfo } from './error-info';
export { pollApprovalOrHalt } from './hitl';
export { setupNodeHookInstrumentation } from './node_instrumentation';
export {
  addIgnoredPrefix,
  registerActivity,
  runWithActivity,
  setupSpanProcessorInstrumentation,
  unregisterActivity,
  unregisterWorkflow,
} from './span_processor';
export {
  enforceVerdict,
  formatActivityRejectedMessage,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  unwrapGovernanceError,
  verdictFromString,
  type VerdictResult,
} from './verdict';
export {
  hexId,
  rfc3339Now,
  safeSerialize,
  type ErrorInfo,
  type GovernanceVerdictResponse,
  type GuardrailsResult,
  type OpenBoxGovernanceEvent,
  type VerdictArm,
} from './types';
