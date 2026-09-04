import { PROMPT_ATTACHMENT_LIMITS } from '@cosyncing/protocol';
import type { AgentMessage, AgentOption, ModeOption, PlanAction, PlanSemantic, SessionConnection } from '@cosyncing/protocol';
import { isNativeSessionUnresumableError, isOwnershipConflictError } from '@cosyncing/adapter-api';
import { trustTierForAddress } from '../security/r2-policy.ts';
import { isJoinExistingError } from './session-owner.ts';

/** Authentication and filesystem trust are deliberately separate decisions. */
export function remoteFilesystemAllowed(address: string | undefined, explicitRemoteEnable: boolean): boolean {
  return trustTierForAddress(address) === 'T1' || explicitRemoteEnable;
}

/** Stable machine codes carried by the additive `attach-conflict` frame. */
export type DriveAttachRefusalCode =
  'DRIVE_OWNERSHIP_CONFLICT'
  | 'DRIVE_OWNERSHIP_UNKNOWN'
  | 'DRIVE_NATIVE_SESSION_UNRESUMABLE'
  | 'DRIVE_RESTORE_FAILED'
  | 'JOIN_OWNER_NOT_FOUND'
  | 'JOIN_OWNER_STALE'
  | 'JOIN_NOT_SUPPORTED';

/** Classify a failed reason-tagged resume without inspecting session metadata. */
export function driveAttachRefusalCode(error: unknown): DriveAttachRefusalCode {
  if (isJoinExistingError(error)) return error.code;
  if (isOwnershipConflictError(error)) {
    return error.conflict === 'daemon-ownership-unknown' ? 'DRIVE_OWNERSHIP_UNKNOWN' : 'DRIVE_OWNERSHIP_CONFLICT';
  }
  if (isNativeSessionUnresumableError(error)) return 'DRIVE_NATIVE_SESSION_UNRESUMABLE';
  return 'DRIVE_RESTORE_FAILED';
}

export type ClientMessagePolicyErrorCode =
  | 'AGENT_UNSUPPORTED'
  | 'PERMISSION_MODE_UNSUPPORTED'
  | 'PLAN_ACTION_INVALID'
  | 'PLAN_ACTION_STALE'
  | 'PLAN_ACTION_UNSUPPORTED'
  | 'PLAN_NOT_FOUND'
  | 'ARTIFACT_INTERACTION_EXPIRED'
  | 'ARTIFACT_INTERACTION_INVALID'
  | 'ARTIFACT_INTERACTION_NOT_FOUND'
  | 'ARTIFACT_INTERACTION_REF_INVALID'
  | 'ARTIFACT_INTERACTION_TOO_LARGE'
  | 'ARTIFACT_INTERACTION_UNSUPPORTED'
  | 'ATTACHMENT_DELIVERY_FAILED'
  | 'ATTACHMENT_INVALID'
  | 'ATTACHMENT_LIMIT_EXCEEDED'
  | 'ATTACHMENT_UNSUPPORTED'
  | 'STAGED_ATTACHMENT_EXPIRED'
  | 'STAGED_ATTACHMENT_NOT_FOUND'
  | 'STAGED_ATTACHMENT_SCOPE_MISMATCH';

export class ClientMessagePolicyError extends Error {
  constructor(
    readonly code: ClientMessagePolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClientMessagePolicyError';
  }
}

function isModeToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 120
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

/**
 * Bound `msg.images` before it reaches an adapter.
 *
 * The field is the older of the two intake routes and was forwarded verbatim:
 * only `WS_INBOUND_MAX_BYTES` (32 MiB) stood between a client and an adapter
 * that declares `supportsNativeFileInput: false` and has a dead `images` branch
 * waiting for it. Ceilings, codes and shape rules are the ones inline `files`
 * already obeys — deliberately no new error code, which would move the surface
 * hash for validation that adds no new failure mode.
 */
export function assertBoundedPromptImages(raw: unknown, supportsNativeFileInput: boolean): void {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    throw new ClientMessagePolicyError('ATTACHMENT_INVALID', 'prompt images must be an array');
  }
  if (raw.length === 0) return;
  if (!supportsNativeFileInput) {
    throw new ClientMessagePolicyError(
      'ATTACHMENT_UNSUPPORTED',
      'this adapter does not support prompt attachments',
    );
  }
  if (raw.length > PROMPT_ATTACHMENT_LIMITS.maxFiles) {
    throw new ClientMessagePolicyError(
      'ATTACHMENT_LIMIT_EXCEEDED',
      `a prompt carries at most ${PROMPT_ATTACHMENT_LIMITS.maxFiles} images`,
    );
  }
  let encoded = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ClientMessagePolicyError('ATTACHMENT_INVALID', 'each prompt image must be an object');
    }
    const image = entry as Record<string, unknown>;
    // A client never names a broker path. `upload-staging` refuses the same
    // field on `files`; an image entry carrying one is asserting a location on
    // the host it has no standing to assert.
    if (image.brokerPath !== undefined) {
      throw new ClientMessagePolicyError(
        'ATTACHMENT_INVALID',
        'a prompt image may not carry a broker path',
      );
    }
    if (typeof image.mimeType !== 'string' || image.mimeType.trim().length === 0) {
      throw new ClientMessagePolicyError('ATTACHMENT_INVALID', 'a prompt image needs a mimeType');
    }
    if (image.name !== undefined && typeof image.name !== 'string') {
      throw new ClientMessagePolicyError('ATTACHMENT_INVALID', "a prompt image's name must be a string");
    }
    const data = image.data;
    if (typeof data !== 'string' || data.length === 0) {
      throw new ClientMessagePolicyError('ATTACHMENT_INVALID', 'a prompt image needs base64 data');
    }
    if (data.startsWith('data:')) {
      throw new ClientMessagePolicyError(
        'ATTACHMENT_INVALID',
        'prompt image data is raw base64, without a data: prefix',
      );
    }
    // Size before shape. Both bounds are arithmetic on the string's length and
    // cost nothing, so an oversized entry is refused before the canonical-base64
    // regex scans it — a 30 MB string used to be walked end to end on its way to
    // being rejected anyway.
    encoded += data.length;
    if (encoded > PROMPT_ATTACHMENT_LIMITS.maxInlineEncodedBytes) {
      throw new ClientMessagePolicyError(
        'ATTACHMENT_LIMIT_EXCEEDED',
        `prompt images exceed the ${PROMPT_ATTACHMENT_LIMITS.maxInlineEncodedBytes}-byte inline budget`,
      );
    }
    // Derived, never decoded: measuring the base64 costs no allocation, so an
    // oversized image is refused before its bytes exist in the broker at all.
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const decoded = (data.length / 4) * 3 - padding;
    if (decoded > PROMPT_ATTACHMENT_LIMITS.maxInlineDecodedBytes) {
      throw new ClientMessagePolicyError(
        'ATTACHMENT_LIMIT_EXCEEDED',
        `a prompt image is larger than ${PROMPT_ATTACHMENT_LIMITS.maxInlineDecodedBytes} bytes`,
      );
    }
    if (
      data.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      throw new ClientMessagePolicyError(
        'ATTACHMENT_INVALID',
        'prompt image data is not canonical base64',
      );
    }
  }
}

export function isShortPolicyToken(value: unknown, max = 200): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function planSemanticFromMessage(message: AgentMessage): PlanSemantic | undefined {
  if (message.type !== 'task-list-state') return undefined;
  const semantic = message.semantic;
  if (!semantic || semantic.kind !== 'plan') return undefined;
  if (!isShortPolicyToken(semantic.planKey) || !isShortPolicyToken(semantic.revision)) return undefined;
  if (!['proposed', 'active', 'completed', 'exited'].includes(semantic.state)) return undefined;
  if (!semantic.actions || typeof semantic.actions !== 'object') return undefined;
  if (typeof semantic.actions.approve !== 'boolean'
    || typeof semantic.actions.edit !== 'boolean'
    || typeof semantic.actions.exit !== 'boolean') return undefined;
  return semantic;
}

export function validatePlanActionRequest(
  raw: unknown,
  current: Extract<AgentMessage, { type: 'task-list-state' }> | undefined,
): { action: PlanAction; semantic: PlanSemantic } {
  const request = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const action = request.action;
  if (action !== 'approve' && action !== 'edit' && action !== 'exit') {
    throw new ClientMessagePolicyError('PLAN_ACTION_INVALID', 'plan action must be approve, edit, or exit');
  }
  if (!isShortPolicyToken(request.planKey) || !isShortPolicyToken(request.planRevision)) {
    throw new ClientMessagePolicyError('PLAN_ACTION_INVALID', 'planKey and planRevision must be short ASCII tokens');
  }
  if (!current) throw new ClientMessagePolicyError('PLAN_NOT_FOUND', 'the referenced plan is not current');
  const semantic = planSemanticFromMessage(current);
  if (!semantic || semantic.planKey !== request.planKey) {
    throw new ClientMessagePolicyError('PLAN_NOT_FOUND', 'the referenced plan is not current');
  }
  if (semantic.revision !== request.planRevision || semantic.state === 'completed' || semantic.state === 'exited') {
    throw new ClientMessagePolicyError('PLAN_ACTION_STALE', 'the referenced plan revision is stale');
  }
  if (!semantic.actions[action]) {
    throw new ClientMessagePolicyError('PLAN_ACTION_UNSUPPORTED', `the current plan does not support ${action}`);
  }
  if (action === 'edit') {
    if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 20_000) {
      throw new ClientMessagePolicyError('PLAN_ACTION_INVALID', 'plan edit text must be between 1 and 20000 characters');
    }
  } else if (Object.prototype.hasOwnProperty.call(request, 'text')) {
    throw new ClientMessagePolicyError('PLAN_ACTION_INVALID', 'only plan edit accepts text');
  }
  return { action, semantic };
}

function advertisedModeValues(options: ModeOption[]): Set<string> {
  return new Set(options.map((option) => option?.value).filter(isModeToken));
}

/**
 * Validate an explicitly supplied permissionMode against the exact options advertised by this live
 * connection. Absence is backwards compatible; presence fails closed when the adapter has no mode
 * surface, its mode lookup is unavailable, or the native value is malformed/stale.
 */
export async function validateRequestedPermissionMode(
  conn: SessionConnection,
  supplied: boolean,
  raw: unknown,
): Promise<string | undefined> {
  if (!supplied) return undefined;
  if (!isModeToken(raw)) {
    throw new ClientMessagePolicyError(
      'PERMISSION_MODE_UNSUPPORTED',
      'permissionMode must be an exact adapter-advertised mode token',
    );
  }
  let options: ModeOption[];
  try {
    options = conn.listModes ? await conn.listModes() : [];
  } catch {
    throw new ClientMessagePolicyError(
      'PERMISSION_MODE_UNSUPPORTED',
      'permissionMode is unavailable for this session',
    );
  }
  if (!advertisedModeValues(Array.isArray(options) ? options : []).has(raw)) {
    throw new ClientMessagePolicyError(
      'PERMISSION_MODE_UNSUPPORTED',
      'permissionMode is not advertised for this session',
    );
  }
  return raw;
}

/**
 * Validate a `set-agent` request against the exact agents/modes advertised by this live
 * connection. Fails closed when the adapter has no agent surface, its agent lookup is
 * unavailable, or the requested name is malformed/stale — mirror of
 * {@link validateRequestedPermissionMode}.
 */
export async function validateRequestedAgent(
  conn: SessionConnection,
  raw: unknown,
): Promise<string> {
  if (!isModeToken(raw)) {
    throw new ClientMessagePolicyError(
      'AGENT_UNSUPPORTED',
      'agent must be an exact adapter-advertised agent name',
    );
  }
  if (!conn.setAgent || !conn.listAgents) {
    throw new ClientMessagePolicyError(
      'AGENT_UNSUPPORTED',
      'this session does not support switching agents',
    );
  }
  let options: AgentOption[];
  try {
    options = await conn.listAgents();
  } catch {
    throw new ClientMessagePolicyError(
      'AGENT_UNSUPPORTED',
      'agent selection is unavailable for this session',
    );
  }
  const advertised = new Set(
    (Array.isArray(options) ? options : [])
      .map((option) => option?.name)
      .filter(isModeToken),
  );
  if (!advertised.has(raw)) {
    throw new ClientMessagePolicyError(
      'AGENT_UNSUPPORTED',
      'agent is not advertised for this session',
    );
  }
  return raw;
}
