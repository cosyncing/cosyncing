/**
 * Compile-time lock for the adapter-api package facade.
 *
 * These imports deliberately use the package name rather than source paths. A
 * refactor may move implementations freely, but removing an exported adapter
 * contract or provider-neutral helper must fail the workspace typecheck.
 */
import {
  AgentOwnedSessionError,
  AgentRegistry,
  BoundedOutputTail,
  COMMAND_MAX_CHARS,
  COMMAND_STREAM_MAX_BYTES,
  FILE_PREVIEW_MAX_BYTES,
  FILE_PREVIEW_MAX_LINES,
  NativeSessionUnresumableError,
  OwnershipConflictError,
  PATH_MAX_CHARS,
  PRODUCT_IDENTITY,
  SEARCH_MAX_GROUPS,
  SEARCH_MAX_MATCHES_PER_GROUP,
  SEARCH_SNIPPET_MAX_BYTES,
  SessionCreateTemporarilyUnavailableError,
  TOOL_SEMANTIC_MAX_BYTES,
  URL_MAX_CHARS,
  WEB_MAX_RESULTS,
  WEB_SNIPPET_MAX_BYTES,
  WEB_TITLE_MAX_CHARS,
  boundToolSemantic,
  boundedPreview,
  boundedStream,
  clipHeadBytes,
  clipTailBytes,
  commandSemantic,
  commandState,
  compareSemanticVersions,
  createJsonlSplitter,
  diagnoseBinaryVersion,
  fileChangesOperation,
  fileReadSemantic,
  gitDiffPath,
  isAgentOwnedSessionError,
  isNativeSessionUnresumableError,
  isOwnershipConflictError,
  isSessionCreateTemporarilyUnavailableError,
  searchGroup,
  searchSemantic,
  semanticVersionFromText,
  splitUnifiedDiffFiles,
  summarizeDiff,
  webResult,
  webSemantic,
  type AgentBackend,
  type AgentIntegration,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type AttachOptions,
  type BinaryVersionDiagnosis,
  type ManagedRuntimeStartFailure,
  type ManagedRuntimeStartReporter,
  type ManagedRuntimeIntegration,
  type SessionDiscoveryOptions,
  type SessionDiscoveryWork,
  type SetupCheck,
  type SetupCheckStatus,
  type SetupCommandProbe,
  type SetupDiagnosisContext,
  type SetupHttpProbe,
  type SetupPathInspection,
  type SetupRemediation,
} from '@cosyncing/adapter-api';

type AdapterApiPublicTypes = {
  backend: AgentBackend;
  integration: AgentIntegration;
  minimumVersion: AgentMinimumVersion;
  diagnosis: AgentSetupDiagnosis;
  attach: AttachOptions;
  binaryDiagnosis: BinaryVersionDiagnosis;
  startFailure: ManagedRuntimeStartFailure;
  startReporter: ManagedRuntimeStartReporter;
  managedRuntime: ManagedRuntimeIntegration;
  discoveryOptions: SessionDiscoveryOptions;
  discoveryWork: SessionDiscoveryWork;
  check: SetupCheck;
  checkStatus: SetupCheckStatus;
  commandProbe: SetupCommandProbe;
  context: SetupDiagnosisContext;
  httpProbe: SetupHttpProbe;
  pathInspection: SetupPathInspection;
  remediation: SetupRemediation;
};

void (null as AdapterApiPublicTypes | null);
void [
  AgentOwnedSessionError,
  AgentRegistry,
  BoundedOutputTail,
  COMMAND_MAX_CHARS,
  COMMAND_STREAM_MAX_BYTES,
  FILE_PREVIEW_MAX_BYTES,
  FILE_PREVIEW_MAX_LINES,
  NativeSessionUnresumableError,
  OwnershipConflictError,
  PATH_MAX_CHARS,
  PRODUCT_IDENTITY,
  SEARCH_MAX_GROUPS,
  SEARCH_MAX_MATCHES_PER_GROUP,
  SEARCH_SNIPPET_MAX_BYTES,
  SessionCreateTemporarilyUnavailableError,
  TOOL_SEMANTIC_MAX_BYTES,
  URL_MAX_CHARS,
  WEB_MAX_RESULTS,
  WEB_SNIPPET_MAX_BYTES,
  WEB_TITLE_MAX_CHARS,
  boundToolSemantic,
  boundedPreview,
  boundedStream,
  clipHeadBytes,
  clipTailBytes,
  commandSemantic,
  commandState,
  compareSemanticVersions,
  createJsonlSplitter,
  diagnoseBinaryVersion,
  fileChangesOperation,
  fileReadSemantic,
  gitDiffPath,
  isAgentOwnedSessionError,
  isNativeSessionUnresumableError,
  isOwnershipConflictError,
  isSessionCreateTemporarilyUnavailableError,
  searchGroup,
  searchSemantic,
  semanticVersionFromText,
  splitUnifiedDiffFiles,
  summarizeDiff,
  webResult,
  webSemantic,
];
