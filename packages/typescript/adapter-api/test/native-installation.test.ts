/**
 * The registry's answer about an agent's native CLI (`AgentBackend.isInstalled`) and the projection
 * every outbound row takes from it.
 *
 * `e2e/adapters/conformance` C17 proves what a client sees per agent with a real broker and a
 * fake whose binary is removed. The rules here are the ones no single agent exercises all of:
 * which rows keep their control (a running writer, an active terminal sync), which attach mode
 * stops pointing at a new writer, and that a hook that is absent, throws, or answers nonsense
 * gates nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  AgentRegistry,
  nativeDriveAttachMode,
  nativeNotInstalledReason,
  withoutNativeInstallation,
  type AgentBackend,
  type AgentCapabilities,
  type SessionInfo,
} from '../src/index.ts';

const RESUMING: AgentCapabilities = {
  integrationKind: 'acp-stdio',
  attachModes: ['observe', 'resume'],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: false,
  supportsNativeArtifact: false,
  supportsNativeFileInput: false,
  supportsModelSwitch: false,
  permissionGranularity: 'none',
};
const LIVE_ONLY: AgentCapabilities = { ...RESUMING, attachModes: ['live', 'observe'], supportsResume: false, supportsLiveAttach: true };

const TERMINAL_SYNC_OFF = { supported: false, syncAvailable: false, active: false } as const;

function row(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    tool: 'fake',
    title: id,
    status: 'idle',
    attachMode: 'resume',
    control: {
      drive: { state: 'observing', supported: true, takeoverAvailable: true },
      terminalSync: TERMINAL_SYNC_OFF,
    },
    ...overrides,
  };
}

class FakeBackend implements AgentBackend {
  readonly id = 'fake';
  readonly displayName = 'Fake Agent';
  installed: unknown = true;
  probes = 0;
  constructor(readonly capabilities: AgentCapabilities = RESUMING, private readonly rows: SessionInfo[] = [row('a')]) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  isInstalled(): boolean {
    this.probes += 1;
    if (this.installed instanceof Error) throw this.installed;
    return this.installed as boolean;
  }
  async discoverSessions(): Promise<SessionInfo[]> {
    return this.rows.map((info) => structuredClone(info));
  }
  async attach(): Promise<never> {
    throw new Error('not reachable');
  }
}

function registryOf(backend: AgentBackend): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(backend);
  return registry;
}

describe('the discovery leg', () => {
  test('records one answer per leg, and every row of the sweep is projected from it', async () => {
    const backend = new FakeBackend();
    const registry = registryOf(backend);
    backend.installed = false;
    const [listed] = await registry.discoverAll();
    expect(backend.probes).toBe(1);
    expect(registry.nativeInstalled('fake')).toBe(false);
    // The registry hands back the adapter's own row; the projection is the broker's last step.
    expect(listed?.control?.drive.supported).toBe(true);
    const projected = registry.projectNativeInstallation(listed!);
    expect(projected.control?.drive).toEqual({
      state: 'unavailable',
      supported: false,
      reason: nativeNotInstalledReason('Fake Agent'),
    });
    expect(projected.attachMode).toBe('observe');
    expect(projected.control?.terminalSync).toEqual(TERMINAL_SYNC_OFF);

    backend.installed = true;
    await registry.discoverAll();
    expect(registry.nativeInstalled('fake')).toBe(true);
    expect(registry.projectNativeInstallation(listed!)).toBe(listed!);
  });

  test('a hook that throws or answers nonsense establishes nothing, so it gates nothing', async () => {
    const backend = new FakeBackend();
    const registry = registryOf(backend);
    backend.installed = false;
    await registry.discoverAll();
    backend.installed = new Error('resolver exploded');
    await registry.discoverAll();
    expect(registry.nativeInstalled('fake')).toBeUndefined();
    backend.installed = 'no';
    expect(await registry.probeNativeInstalled('fake')).toBeUndefined();
    const listed = row('a');
    expect(registry.projectNativeInstallation(listed)).toBe(listed);
  });

  test('an adapter without the hook is never projected', async () => {
    const backend = new FakeBackend();
    const hookless: AgentBackend = {
      id: backend.id,
      displayName: backend.displayName,
      capabilities: backend.capabilities,
      isAvailable: () => backend.isAvailable(),
      discoverSessions: () => backend.discoverSessions(),
      attach: () => backend.attach(),
    };
    const registry = registryOf(hookless);
    await registry.discoverAll();
    expect(await registry.probeNativeInstalled('fake')).toBeUndefined();
    const listed = row('a');
    expect(registry.projectNativeInstallation(listed)).toBe(listed);
  });

  test('a fresh probe replaces the leg\'s answer', async () => {
    const backend = new FakeBackend();
    const registry = registryOf(backend);
    await registry.discoverAll();
    expect(registry.nativeInstalled('fake')).toBe(true);
    backend.installed = false;
    expect(await registry.probeNativeInstalled('fake')).toBe(false);
    expect(registry.nativeInstalled('fake')).toBe(false);
  });
});

describe('the projection', () => {
  test('leaves a running writer alone: a driving row, or an active terminal sync', () => {
    const driving = row('d', { control: { drive: { state: 'driving', supported: true }, terminalSync: TERMINAL_SYNC_OFF } });
    expect(withoutNativeInstallation(driving, 'Fake Agent', RESUMING)).toBe(driving);
    const synced = row('s', {
      attachMode: 'live',
      control: {
        drive: { state: 'unavailable', supported: false, reason: 'synced' },
        terminalSync: { supported: true, syncAvailable: true, active: true, presence: 'shared' },
      },
    });
    expect(withoutNativeInstallation(synced, 'Fake Agent', RESUMING)).toBe(synced);
    const controlless = row('c', { control: undefined });
    expect(withoutNativeInstallation(controlless, 'Fake Agent', RESUMING)).toBe(controlless);
  });

  test('replaces any other reason, and only rewrites the attach mode that opens a new writer', () => {
    const subagent = row('sub', {
      attachMode: 'observe',
      control: { drive: { state: 'unavailable', supported: false, reason: 'owned by its parent' }, terminalSync: TERMINAL_SYNC_OFF },
    });
    const projected = withoutNativeInstallation(subagent, 'Fake Agent', RESUMING);
    expect(projected.control?.drive.reason).toBe(nativeNotInstalledReason('Fake Agent'));
    expect(projected.attachMode).toBe('observe');
    // A `live` attach on an agent that resumes joins a terminal-synced session; it is not the writer mode.
    const joinable = row('j', { attachMode: 'live' });
    expect(withoutNativeInstallation(joinable, 'Fake Agent', RESUMING).attachMode).toBe('live');
    // On a live-only agent, `live` IS the writer, so a client following the row must not open it.
    expect(withoutNativeInstallation(joinable, 'Fake Agent', LIVE_ONLY).attachMode).toBe('observe');
  });

  test('the writer mode is resume where declared, else live', () => {
    expect(nativeDriveAttachMode(RESUMING)).toBe('resume');
    expect(nativeDriveAttachMode({ ...RESUMING, attachModes: ['live', 'resume', 'observe'] })).toBe('resume');
    expect(nativeDriveAttachMode(LIVE_ONLY)).toBe('live');
    expect(nativeDriveAttachMode({ ...RESUMING, attachModes: ['observe'] })).toBeUndefined();
  });

  test('the reason says the agent is not installed and that Observe still works', () => {
    expect(nativeNotInstalledReason('Grok Build')).toMatch(/^Grok Build is not installed/);
    expect(nativeNotInstalledReason('Grok Build')).toMatch(/Observe still reads/);
  });
});
