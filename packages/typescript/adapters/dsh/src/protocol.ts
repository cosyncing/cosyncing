/**
 * The protocol strategy: the one seam the adapter's product paths talk to.
 *
 * Before this module existed the 0.2 transport (`auth.ts`, `remote.ts`, `mux.ts`,
 * `event-link.ts`) was complete and green and reachable from nothing but its own
 * tests, while `implementation.ts` still called `host.describe` and
 * `session.list`. A transport that no product path imports is a prototype, so this
 * file is where the two families actually meet: discovery, readiness, observation
 * and Drive all ask a {@link DshHostProtocol}, and the choice between them is a
 * bounded read-only decision made in exactly one place.
 *
 * TWO RULES, ENFORCED BY TYPES RATHER THAN BY REVIEW.
 *
 * NO LEGACY FALLBACK AFTER AN AUTH REFUSAL. {@link mayFallBackToLegacyAfterProbe}
 * is consulted on every route to the legacy family, so a 401 cannot quietly become
 * "try the old RPCs", which would send unauthenticated writes at a host that is
 * merely waiting for a cookie.
 *
 * NO UNVERIFIED MUTATION. A protocol exposes {@link DshHostProtocol.mutationReady}
 * and every write path in this adapter asks it. Legacy readiness is a verified
 * `host.describe`; 0.2 readiness is an authenticated carrier plus a verified
 * `$events` generation. "The socket opened" is not in either definition.
 */

import type { PromptInput } from '@cosyncing/adapter-api';
import {
  DshDriver,
  type DshCommandDescriptor,
  type DshCommandExecution,
  type DshModelCatalogModel,
  type DshModelProviderGroup,
  type DshModelSelection,
  type DshPromptOptions,
  type DshSessionModels,
} from './drive.ts';
import type { DshReceipt, DshRpcClient } from './server.ts';
import type { DshHistoryEntry } from './mapping.ts';
import { classifyDshVersion, mayFallBackToLegacyAfterProbe, probeDshContract, type DshContractFamily, type DshContractProbe, type DshProbeFetch } from './compatibility.ts';
import { transportFailure, type DshOutcome } from './envelope.ts';
import type { DshPendingApproval, DshPendingQuestion } from './mapping.ts';

export type { DshContractFamily };

/** One backward page of the session log, whichever family produced it. */
export interface DshHistoryPage {
  events: DshHistoryEntry[];
  hasMore: boolean;
  /** The consistent projection cut that belongs to the newest page. */
  projections?: unknown;
}

/**
 * One permission preset, in the shape the host's own catalog published it.
 *
 * `value` is what a switch command takes; `name` is what the host labels it
 * with, which on the captured build happens to be the same string. Neither half
 * is inferred: a preset the host did not advertise is not offered.
 */
export interface DshPermissionOption {
  value: string;
  name?: string;
  description?: string;
}

/** A host's answer to `permissionPresets/catalog`. */
export interface DshPermissionCatalog {
  options: readonly DshPermissionOption[];
  /** The preset a NEW session starts on. Not this session's current value. */
  defaultPreset?: string;
}

/**
 * What one session's connection needs, and nothing else.
 *
 * Kept deliberately narrow (the history read plus the driver's write surface) so
 * the legacy and 0.2 implementations are comparable line by line, and so a new
 * capability has to be added in the open: both families answer it or the
 * connection cannot call it.
 */
export interface DshSessionChannel {
  readonly family: DshContractFamily;
  history(request: { sessionId: string; maxMessages: number; beforeSeq?: number }): Promise<DshOutcome<DshHistoryPage>>;
  /** rc.2 authorizes durable image readback against this session's own log. */
  attachment?(sessionId: string, attachmentId: string, signal?: AbortSignal): Promise<DshOutcome<{ attachment: unknown; data: unknown }>>;
  prompt(sessionId: string, input: PromptInput, options?: DshPromptOptions): Promise<void>;
  models(sessionId: string): Promise<DshSessionModels>;
  selectModel(sessionId: string, selection: DshModelSelection): Promise<DshModelSelection>;
  listCommands(sessionId: string): Promise<DshCommandDescriptor[]>;
  executeCommand(sessionId: string, line: string): Promise<DshCommandExecution | undefined>;
  cancel(sessionId: string): Promise<void>;
  answerQuestion(pending: DshPendingQuestion, answers: string[][]): Promise<DshReceipt>;
  respondApproval(pending: DshPendingApproval, allow: boolean): Promise<DshReceipt>;
  /**
   * The host's permission-preset catalog, when the deployment composes one.
   *
   * Optional because the families split this surface differently rather than
   * because a caller may skip it. On 0.2 the per-session `permissions`
   * projection carries only the CURRENT value and the roster lives on a separate
   * host-wide route, so a picker built from the projection alone is empty on a
   * host that has three presets. On 0.1 the projection carries both. A read
   * that cannot answer returns undefined, which is "no roster", never a guess.
   */
  permissionCatalog?(): Promise<DshPermissionCatalog | undefined>;
  /** A dropped carrier generation: cancel this session's stream reads and force a re-baseline. */
  onGenerationLost?(): void;
  /** Release any stream this channel holds for the session. */
  close?(): void;
}

/**
 * The 0.1.0-rc.6 session channel: the existing driver, plus the one history read
 * that used to sit inline in the connection.
 *
 * It holds no behaviour of its own on purpose. Every method is a delegation to
 * the code that shipped and was physically qualified, so switching families
 * cannot change what a legacy host sees on the wire.
 */
export class DshLegacySessionChannel implements DshSessionChannel {
  readonly family = 'legacy-0.1' as const;
  private readonly driver: DshDriver;

  constructor(private readonly rpc: DshRpcClient, driver?: DshDriver) {
    this.driver = driver ?? new DshDriver(rpc);
  }

  async history(request: { sessionId: string; maxMessages: number; beforeSeq?: number }): Promise<DshOutcome<DshHistoryPage>> {
    const outcome = await this.rpc.call<DshHistoryPage>('session.history', {
      sessionId: request.sessionId,
      maxMessages: request.maxMessages,
      ...(request.beforeSeq !== undefined ? { beforeSeq: request.beforeSeq } : {}),
    });
    if (!outcome.ok) return outcome;
    const page = outcome.value ?? ({} as DshHistoryPage);
    return { ok: true, value: { events: page.events ?? [], hasMore: page.hasMore === true, ...(page.projections !== undefined ? { projections: page.projections } : {}) } };
  }

  prompt(sessionId: string, input: PromptInput, options?: DshPromptOptions): Promise<void> {
    return this.driver.prompt(sessionId, input, options ?? {});
  }

  models(sessionId: string): Promise<DshSessionModels> {
    return this.driver.models(sessionId);
  }

  selectModel(sessionId: string, selection: DshModelSelection): Promise<DshModelSelection> {
    return this.driver.selectModel(sessionId, selection);
  }

  listCommands(sessionId: string): Promise<DshCommandDescriptor[]> {
    return this.driver.listCommands(sessionId);
  }

  executeCommand(sessionId: string, line: string): Promise<DshCommandExecution | undefined> {
    return this.driver.executeCommand(sessionId, line);
  }

  cancel(sessionId: string): Promise<void> {
    return this.driver.cancel(sessionId);
  }

  answerQuestion(pending: DshPendingQuestion, answers: string[][]): Promise<DshReceipt> {
    return this.driver.answerQuestion(pending, answers);
  }

  respondApproval(pending: DshPendingApproval, allow: boolean): Promise<DshReceipt> {
    return this.driver.respondApproval(pending, allow);
  }
}

/** What a verified host says about itself, in family-neutral terms. */
export interface DshHostIdentity {
  readonly family: DshContractFamily;
  /** Legacy `host.describe` identity when the family published one; never inferred. */
  readonly hostHome?: string;
}

export interface DshRosterRow {
  sessionId: string;
  raw: unknown;
}

/** Workspace registration as both families expose it. */
export interface DshWorkspace {
  workspaceId: string;
  path: string;
  title: string;
}

/**
 * The host-level surface the adapter's product paths use.
 *
 * Discovery, creation, renaming and the model catalog live here because they are
 * host reads, not session reads; per-session reads and writes go through
 * {@link DshSessionChannel}. Both families must answer every method: an optional
 * method here would be a family that fails at runtime for a reason the type
 * system could have said out loud.
 */
export interface DshHostProtocol {
  readonly family: DshContractFamily;
  /** Prove, right now, that this host answers THIS contract. Reads only. */
  ready(signal?: AbortSignal): Promise<DshOutcome<DshHostIdentity>>;
  /** Whether a write may be issued against this protocol at this instant. */
  mutationReady(): boolean;
  roster(signal?: AbortSignal): Promise<DshOutcome<readonly DshRosterRow[]>>;
  workspaces(signal?: AbortSignal): Promise<DshOutcome<readonly DshWorkspace[]>>;
  /** Host-wide model catalog. Throws the adapter's drive error, as the legacy path always did. */
  modelCatalog(): Promise<DshModelProviderGroup[]>;
  createSession(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId: string; agentPreset?: string }>;
  renameSession(sessionId: string, title: string): Promise<string>;
  selectModel(sessionId: string, selection: DshModelSelection): Promise<DshModelSelection>;
  /** The per-session model read that seeds the roster's model column. */
  sessionModels(sessionId: string): Promise<DshSessionModels>;
  channel(sessionId: string): DshSessionChannel;
  start(): void;
  stop(): void;
}

/** The last failure a protocol selection made, kept for diagnostics. */
export type DshProtocolDecision =
  | { family: 'remote-0.2'; authenticated: boolean; probe: DshContractProbe }
  | { family: 'legacy-0.1'; probe: DshContractProbe }
  | { family: null; detail: string; probe: DshContractProbe };

/**
 * Which family to speak, from two GETs and nothing else.
 *
 * A refusal is a finding, not a retry: `remote-0.2 / auth-required` means the
 * adapter is talking to a 0.2 host it has not enrolled, whose remedy is
 * `cosy dsh connect`, not another probe. `null` is the only answer that says
 * "nothing recognizable is here", and it never silently becomes legacy.
 */
export async function selectDshProtocol(options: {
  baseUrl: string;
  fetchImpl?: DshProbeFetch;
  headers?: Readonly<Record<string, string>>;
}): Promise<DshProtocolDecision> {
  const fetchImpl: DshProbeFetch = options.fetchImpl
    ?? ((url, init) => fetch(url, init as unknown as RequestInit).then((response) => ({ status: response.status })));
  const probe = await probeDshContract(options.baseUrl, fetchImpl, options.headers ?? {});
  if (probe.family === 'remote-0.2') return { family: 'remote-0.2', authenticated: probe.authenticated, probe };
  if (probe.family === 'legacy-0.1' && mayFallBackToLegacyAfterProbe(probe)) return { family: 'legacy-0.1', probe };
  return { family: null, probe, detail: describeProbe(probe) };
}

function describeProbe(probe: DshContractProbe): string {
  switch (probe.reason) {
    case 'no-listener': return 'nothing answered on the configured DeepSeek Harness address';
    case 'probe-failed': return 'the DeepSeek Harness contract probe could not complete';
    case 'no-contract': return 'the address answers, but not with a DeepSeek Harness web contract this build implements';
    default: return 'the DeepSeek Harness host refused the contract probe';
  }
}

/**
 * Whether a locally readable version agrees with the family the probe picked.
 *
 * A version read is EVIDENCE, not a gate, on the external-host path: `dsh
 * --version` describes the binary on this machine, which need not be the process
 * serving a remote address. It gates managed launches (see
 * {@link decideManagedLaunch}) and it is reported by doctor; here it only records
 * a mismatch so a diagnosis can name it.
 */
export function versionFamilyAgreement(
  versionOutput: string | undefined,
  family: DshContractFamily,
): 'agrees' | 'disagrees' | 'unreadable' {
  const verdict = classifyDshVersion(versionOutput);
  if (verdict.status === 'unavailable') return 'unreadable';
  if (verdict.status === 'unsupported') return 'disagrees';
  return verdict.family === family ? 'agrees' : 'disagrees';
}

/** A failure that says the adapter has no usable protocol for this endpoint. */
export function protocolUnavailable(detail: string, retryable = true): ReturnType<typeof transportFailure> {
  return transportFailure('unreachable', { retryable, detail });
}

/** Helper re-exported so callers do not import the model module for one type. */
export type DshCatalogModel = DshModelCatalogModel;
