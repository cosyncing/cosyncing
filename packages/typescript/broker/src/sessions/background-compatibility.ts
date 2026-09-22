import type { AgentMessage } from '@cosyncing/protocol';

/** Codex cards need revision 26's bounded running-state reconciliation.
 * This gates only the new surface, never ordinary Codex session functionality. */
export function canSendBackgroundMessage(message: AgentMessage, clientRevision: number): boolean {
  const codexBackground = message.type === 'agent-activity' && message.key.startsWith('cmd:codex:')
    || message.type === 'event' && message.name === 'codex.background-running-snapshot';
  return !codexBackground || clientRevision >= 26;
}
