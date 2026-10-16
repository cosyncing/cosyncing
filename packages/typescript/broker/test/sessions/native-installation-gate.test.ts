/**
 * The Hub's half of "a missing binary keeps stored sessions Observe-only".
 *
 * Conformance C17 (`e2e/adapters/conformance`) proves the outcome per agent through a real broker,
 * but most adapters also refuse a Drive writer on their own when their binary is gone, so a broken
 * Hub gate hides behind them there. Here the adapter would admit anything: only the Hub stands
 * between a Drive request and a new native writer, and only the Hub projects the row.
 */
import { afterEach, expect, test } from 'bun:test';
import { Hub } from '../../src/sessions/hub.ts';
import { driveAttachRefusalCode } from '../../src/sessions/client-message-policy.ts';
import {
  AgentRegistry,
  nativeNotInstalledReason,
  type AgentCapabilities,
  type AgentMessage,
  type AttachMode,
  type SessionConnection,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';

const hubs: Hub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.dispose().catch(() => undefined);
});

const RESUMING: AgentCapabilities = {
  integrationKind: 'acp-stdio',
  attachModes: ['observe', 'resume', 'live'],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: true,
  supportsNativeArtifact: false,
  supportsNativeFileInput: false,
  supportsModelSwitch: false,
  permissionGranularity: 'none',
};
const LIVE_ONLY: AgentCapabilities = { ...RESUMING, attachModes: ['observe', 'live'], supportsResume: false };

function rowInfo(id: string, attachMode: AttachMode, driving = false): SessionInfo {
  return {
    id,
    tool: 'fake',
    title: id,
    status: 'idle',
    attachMode,
    control: {
      drive: driving ? { state: 'driving', supported: true } : { state: 'observing', supported: true },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  };
}

function fakeConn(info: SessionInfo): SessionConnection {
  const handlers = new Set<(message: AgentMessage) => void>();
  return {
    info,
    getHistory: async () => [],
    subscribe: (handler: (message: AgentMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {},
  } as unknown as SessionConnection;
}

function fixture(capabilities: AgentCapabilities = RESUMING) {
  const attaches: Array<AttachMode | undefined> = [];
  const backend = {
    id: 'fake',
    displayName: 'Fake Agent',
    capabilities,
    installed: false as boolean,
    isInstalled(): boolean { return this.installed; },
    isAvailable: async () => true,
    discoverSessions: async () => [rowInfo('stored', 'resume')],
    attach: async (id: string, mode?: AttachMode) => {
      attaches.push(mode);
      const writer = mode !== undefined && mode !== 'observe';
      return fakeConn(rowInfo(id, mode ?? 'observe', writer));
    },
  };
  const registry = new AgentRegistry();
  registry.register(backend);
  const hub = new Hub(registry, 15_000);
  hubs.push(hub);
  return { backend, registry, hub, attaches };
}

test('a Drive writer is refused before the adapter is asked; Observe still attaches', async () => {
  const { hub, attaches } = fixture();
  const refusal = await hub.ensure('fake', 'stored', 'resume', 'takeover').then(() => undefined, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toBe(nativeNotInstalledReason('Fake Agent'));
  // The generic conflict code: no native side declined anything.
  expect(driveAttachRefusalCode(refusal)).toBe('DRIVE_RESTORE_FAILED');
  expect(attaches).toEqual([]);
  const observer = await hub.ensure('fake', 'stored');
  expect(attaches).toEqual([undefined]);
  expect(observer.conn.info.attachMode).toBe('observe');
});

test('the gate re-probes: a binary that comes back admits the writer at once', async () => {
  const { backend, hub, attaches } = fixture();
  await expect(hub.ensure('fake', 'stored', 'resume', 'takeover')).rejects.toThrow(/not installed/);
  backend.installed = true;
  const writer = await hub.ensure('fake', 'stored', 'resume', 'takeover');
  expect(attaches).toEqual(['resume']);
  expect(writer.conn.info.control?.drive.state).toBe('driving');
});

test('only the mode that starts a writer is gated', async () => {
  // On an agent that resumes, `live` joins a terminal-synced session: no local binary needed.
  const resuming = fixture();
  await resuming.hub.ensure('fake', 'joined', 'live');
  expect(resuming.attaches).toEqual(['live']);
  // On a live-only agent, `live` IS the writer.
  const liveOnly = fixture(LIVE_ONLY);
  await expect(liveOnly.hub.ensure('fake', 'stored', 'live')).rejects.toThrow(/not installed/);
  expect(liveOnly.attaches).toEqual([]);
});

test('every row the Hub publishes is projected from the recorded answer', async () => {
  const { backend, registry, hub } = fixture();
  const [stored] = await registry.discoverAll();
  const projected = hub.projectSessionInfo(stored!);
  expect(projected.control?.drive).toEqual({
    state: 'unavailable',
    supported: false,
    reason: nativeNotInstalledReason('Fake Agent'),
  });
  expect(projected.attachMode).toBe('observe');
  // A writer that already runs is left alone.
  expect(hub.projectSessionInfo(rowInfo('running', 'resume', true)).control?.drive.state).toBe('driving');
  backend.installed = true;
  await registry.discoverAll();
  expect(hub.projectSessionInfo(stored!).control?.drive.supported).toBe(true);
});
