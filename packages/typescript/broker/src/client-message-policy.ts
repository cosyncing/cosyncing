import type { AgentMessage, AgentOption, ModeOption, PlanAction, PlanSemantic, SessionConnection } from '@cosyncing/protocol';

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
