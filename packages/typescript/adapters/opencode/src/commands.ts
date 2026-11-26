import type { SlashCommand } from '@cosyncing/adapter-api';

/** Session actions shared by both native generations. */
export const OPENCODE_SHARED_ACTIONS: SlashCommand[] = [
  { name: 'compact', description: 'Compact / summarize the session', kind: 'action' },
  { name: 'undo', description: 'Revert the last message', kind: 'action' },
  { name: 'redo', description: 'Restore the reverted message', kind: 'action' },
  { name: 'stop', description: 'Stop the running turn', kind: 'action' },
];
