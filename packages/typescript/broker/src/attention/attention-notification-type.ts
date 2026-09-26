import type { AttentionEvent, SessionInfo } from '@cosyncing/protocol';

/**
 * The user-configurable notification types, by stable id. Clients switch these on and off, and
 * Android shows each as one channel. The Flutter client's `AttentionNotificationType` enum carries
 * the same ids; `contracts/fixtures/attention-notification-types.json` holds the cases both sides
 * test against, so the two mappings cannot drift.
 */
export const ATTENTION_NOTIFICATION_TYPES = [
  'permission_request',
  'question',
  'turn_finished',
  'goal_finished',
  'turn_failed',
  'scheduled_send_failed',
  'security_alert',
  'device_paired',
  'server_problem',
  'runtime_update',
  'usage_quota',
] as const;

export type AttentionNotificationType = (typeof ATTENTION_NOTIFICATION_TYPES)[number];

const SESSION_OUTCOME_TYPES: ReadonlySet<AttentionNotificationType> = new Set([
  'turn_finished',
  'goal_finished',
  'turn_failed',
]);

/** Whether [type] is a turn or goal outcome of one session, which collapses per session. */
export function isSessionOutcomeNotificationType(type: AttentionNotificationType): boolean {
  return SESSION_OUTCOME_TYPES.has(type);
}

type NotificationSource = Pick<AttentionEvent, 'id' | 'kind' | 'severity' | 'dedupeKey' | 'agent' | 'sessionId' | 'action'>;

/**
 * The notification type of [event], or undefined when it is never an OS notification: a
 * scheduled send that succeeded, broker health below action-required, and kinds no type covers.
 */
export function attentionNotificationType(event: Pick<AttentionEvent, 'kind' | 'severity'>): AttentionNotificationType | undefined {
  switch (event.kind) {
    case 'permission-required': return 'permission_request';
    case 'question-required': return 'question';
    case 'run-finished': return 'turn_finished';
    case 'goal-finished': return 'goal_finished';
    case 'run-failed': return 'turn_failed';
    case 'scheduled-send-failed': return 'scheduled_send_failed';
    case 'security-alert': return 'security_alert';
    case 'device-paired': return 'device_paired';
    case 'broker-health':
      return event.severity === 'action-required' ? 'server_problem' : undefined;
    case 'runtime-update-ready': return 'runtime_update';
    case 'usage-threshold': return 'usage_quota';
    default: return undefined;
  }
}

/**
 * The notification slot [event] occupies. Showing into an occupied slot replaces what is there: a
 * newer turn outcome replaces the session's older one, and a reminder re-alerts the same request
 * instead of stacking.
 */
export function attentionNotificationCollapseKey(event: NotificationSource, type: AttentionNotificationType): string {
  const session = attentionNotificationSessionKey(event);
  if (isSessionOutcomeNotificationType(type) && session !== undefined) return `session-outcome:${session}`;
  const dedupeKey = event.dedupeKey.trim();
  return dedupeKey ? dedupeKey : `event:${event.id}`;
}

function attentionNotificationSessionKey(event: NotificationSource): string | undefined {
  const action = event.action.kind === 'open-session' ? event.action : undefined;
  const tool = (action?.tool ?? event.agent)?.trim();
  const sessionId = (action?.sessionId ?? event.sessionId)?.trim();
  return tool && sessionId ? `${tool}:${sessionId}` : undefined;
}

/** [event] with the fields a client presents it by, when it is a notification at all. */
export function withAttentionNotificationFields<T extends AttentionEvent>(event: T): T {
  const notificationType = attentionNotificationType(event);
  if (notificationType === undefined) return event;
  return { ...event, notificationType, collapseKey: attentionNotificationCollapseKey(event, notificationType) };
}

/**
 * [session] as its notifications name it: under the title the user gave it in Cosyncing, when there
 * is one, exactly as the roster shows it. An adapter reports its native title, which for a session
 * named here (at creation, or renamed where the tool has no native rename) is not the name the user
 * knows.
 */
export function attentionSessionView(session: SessionInfo, titleOf: (tool: string, id: string) => string | undefined): SessionInfo {
  const title = titleOf(session.tool, session.id)?.trim();
  return title && title !== session.title ? { ...session, title } : session;
}
