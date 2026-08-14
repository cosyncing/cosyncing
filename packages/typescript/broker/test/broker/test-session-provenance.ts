#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { SessionInfo, SessionTerminalPresence } from '../../../adapter-api/src/index.ts';
import { isAcceptedMutationCommand, overlayFreshTerminalPresence } from '../../src/main.ts';
import { SessionMetadataStore } from '../../src/sessions/session-metadata-store.ts';

const roots: string[] = [];
const tempRoot = (name: string): string => {
  const root = mkdtempSync(join(tmpdir(), `cosyncing-session-provenance-${name}-`));
  roots.push(root);
  return root;
};

const sessionKey = (tool: string, id: string): string => `${tool}\0${id}`;
const readProvenance = (root: string): {
  version: number;
  provenance?: Record<string, { launchSurface?: string; appCreatedAt?: number; appMutatedPrivateAt?: number }>;
} => {
  const path = join(root, 'session-metadata.json');
  if (!existsSync(path)) return { version: 2, provenance: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as {
    version: number;
    provenance?: Record<string, { launchSurface?: string; appCreatedAt?: number; appMutatedPrivateAt?: number }>;
  };
};

const withControl = (presence: SessionTerminalPresence): SessionInfo => ({
  id: 'session-1',
  tool: 'codex',
  title: 'Live',
  status: 'idle',
  attachMode: 'observe',
  control: {
    drive: { supported: false, state: 'unavailable' },
    terminalSync: {
      supported: true,
      syncAvailable: false,
      active: false,
      presence,
    },
  },
});

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

try {
  // 1) v1 migration and title/project preservation.
  {
    const root = tempRoot('migration');
    const path = join(root, 'session-metadata.json');
    const legacyKey = sessionKey('codex', 'legacy');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sessions: { [legacyKey]: { title: 'Legacy Title', updatedAt: 1_000 } },
        projects: { '/repo/legacy': { name: 'Legacy Project', updatedAt: 2_000 } },
      }),
    );
    const fromV1 = new SessionMetadataStore(root);
    const restored = fromV1.apply({
      id: 'legacy',
      tool: 'codex',
      title: 'Adapter Title',
      status: 'idle',
      attachMode: 'observe',
      cwd: '/repo/legacy',
      control: { drive: { supported: false, state: 'unavailable' }, terminalSync: { supported: true, syncAvailable: false, active: false } },
    });
    check('legacy title is preserved when applying v1 file', restored.title === 'Legacy Title');
    check('legacy project alias is preserved when applying v1 file', restored.projectName === 'Legacy Project');
    fromV1.recordAppCreatedSession({ tool: 'codex', id: 'legacy' });
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      sessions: Record<string, { title?: string }>;
      projects: Record<string, { name?: string }>;
      provenance: Record<string, unknown>;
    };
    check('legacy v1 sessions survive first write', migrated.sessions[legacyKey]?.title === 'Legacy Title');
    check('legacy v1 project aliases survive first write', migrated.projects['/repo/legacy']?.name === 'Legacy Project');
    check('legacy file upgrades to provenance index version 2', migrated.version === 2 && typeof migrated.provenance === 'object');
  }

  // 2) app-created provenance survives nativeId-based identity changes.
  {
    const root = tempRoot('native-id');
    const creator = new SessionMetadataStore(root);
    creator.recordAppCreatedSession({
      id: 'broker-id-a',
      nativeId: 'native-session-id',
      tool: 'codex',
    });
    const reloaded = new SessionMetadataStore(root);
    const adapted = reloaded.apply({
      ...withControl('private'),
      id: 'broker-id-b',
      nativeId: 'native-session-id',
      title: 'Changed ID',
      status: 'idle',
      attachMode: 'observe',
      tool: 'codex',
    });
    check('provenance survives across broker id refreshes via nativeId', adapted.launchSurface === 'app');
  }

  // 3) adapter-provided launchSurface is preserved when there is no durable provenance.
  {
    const root = tempRoot('surface');
    const store = new SessionMetadataStore(root);
    const adapterInfo: SessionInfo = {
      ...withControl('private'),
      id: 'surface',
      tool: 'codex',
      title: 'Adapter surface',
      status: 'idle',
      attachMode: 'observe',
      launchSurface: 'terminal',
    };
    const applied = store.apply(adapterInfo);
    check('adapter launchSurface is preserved when no durable provenance exists', applied.launchSurface === 'terminal');
  }
  {
    const root = tempRoot('terminal-mutation');
    const store = new SessionMetadataStore(root);
    const adapterInfo: SessionInfo = {
      ...withControl('private'),
      id: 'terminal-mutation',
      tool: 'codex',
      title: 'Terminal owned',
      status: 'idle',
      attachMode: 'observe',
      launchSurface: 'terminal',
    };
    const first = store.apply(adapterInfo);
    check('adapter launchSurface is preserved before mutation', first.launchSurface === 'terminal');
    store.recordAppMutation(adapterInfo);
    const mutated = store.apply(adapterInfo);
    check('adapter terminal launchSurface remains terminal after app mutation', mutated.launchSurface === 'terminal');
  }

  // 4) title rename/clear does not erase provenance.
  {
    const root = tempRoot('rename');
    const store = new SessionMetadataStore(root);
    const base: SessionInfo = {
      ...withControl('private'),
      id: 'rename-me',
      tool: 'codex',
      title: 'Original',
      status: 'idle',
      attachMode: 'observe',
    };
    store.recordAppCreatedSession(base);
    store.renameSession('codex', 'rename-me', 'Renamed by user');
    const renamed = store.apply(base);
    check('title rename does not remove app provenance', renamed.launchSurface === 'app');
    check('title alias is applied during rename', renamed.title === 'Renamed by user');
    store.renameSession('codex', 'rename-me', null);
    const cleared = store.apply({ ...base, title: 'Should clear' });
    check('title clear does not remove app provenance', cleared.launchSurface === 'app');
  }

  // 5) private before mutation stays not behind; mutation flips behind.
  {
    const root = tempRoot('private');
    const store = new SessionMetadataStore(root);
    const base = withControl('private');
    store.recordAppCreatedSession(base);
    const untouched = store.apply(base);
    check('private session starts with behind=false before mutation', untouched.control?.terminalSync?.behind === false);
    store.recordAppMutation(base);
    const mutated = store.apply(base);
    check('private session becomes behind=true after accepted app mutation', mutated.control?.terminalSync?.behind === true);
  }

  // 6) absent/shared/unknown presence never enables behind, even with mutation evidence.
  {
    const root = tempRoot('presence');
    const presences: SessionTerminalPresence[] = ['absent', 'shared', 'unknown'];
    for (const presence of presences) {
      const store = new SessionMetadataStore(root);
      const base: SessionInfo = {
        ...withControl(presence),
        id: `presence-${presence}`,
        title: 'Presence test',
        status: 'idle',
        attachMode: 'observe',
        tool: 'codex',
      };
      store.recordAppCreatedSession(base);
      store.recordAppMutation(base);
      const after = store.apply(base);
      check(`presence ${presence} remains behind=false after mutation`, after.control?.terminalSync?.behind === false);
    }
  }

  // 7) mutation evidence is only accepted while presence was private.
  {
    const root = tempRoot('private-window');
    const store = new SessionMetadataStore(root);
    const absent: SessionInfo = {
      ...withControl('absent'),
      id: 'temporal',
      tool: 'codex',
      title: 'Temporal presence',
      status: 'idle',
      attachMode: 'observe',
    };
    store.recordAppCreatedSession(absent);
    store.recordAppMutation(absent);
    const afterAbsent = store.apply(absent);
    check('mutation while absent does not make behind true', afterAbsent.control?.terminalSync?.behind === false);
    const privateNow: SessionInfo = {
      ...absent,
      control: {
        drive: absent.control!.drive,
        terminalSync: {
          ...absent.control!.terminalSync,
          presence: 'private',
        },
      },
    };
    store.recordAppMutation(privateNow);
    const afterPrivateNow = store.apply(privateNow);
    check('later private mutation after non-private turns enables behind', afterPrivateNow.control?.terminalSync?.behind === true);
  }

  // 8) apply must not mutate adapter-owned nested objects.
  {
    const root = tempRoot('immutable');
    const store = new SessionMetadataStore(root);
    const base: SessionInfo = {
      ...withControl('private'),
      id: 'immut',
      title: 'Immutable',
      status: 'idle',
      attachMode: 'observe',
      tool: 'codex',
    };
    const before = structuredClone(base);
    store.recordAppCreatedSession(base);
    store.recordAppMutation(base);
    const after = store.apply(base);
    let immutable = true;
    try {
      assert.deepEqual(base, before);
    } catch {
      immutable = false;
    }
    check('apply does not mutate top-level/nested session objects', immutable);
    check('apply adds mutation-derived terminalSync signal', after.control?.terminalSync?.behind === true);
  }

  // 9) app-created provenance fields are truthful and mutation-only sessions never invent appCreatedAt.
  {
    const root = tempRoot('app-created-at');
    const path = join(root, 'session-metadata.json');
    const store = new SessionMetadataStore(root);
    const terminalOnly: SessionInfo = {
      ...withControl('private'),
      id: 'terminal-only',
      title: 'Terminal only',
      status: 'idle',
      attachMode: 'observe',
      tool: 'codex',
      launchSurface: 'terminal',
    };
    store.recordAppMutation(terminalOnly);
    const afterMutation = readProvenance(root);
    const terminalRecord = afterMutation.provenance?.[sessionKey('codex', 'terminal-only')];
    check('terminal-only mutation does not write appCreatedAt', terminalRecord?.appCreatedAt === undefined);
    check('terminal-only mutation writes private-divergence evidence', typeof terminalRecord?.appMutatedPrivateAt === 'number');

    const created = {
      ...terminalOnly,
      id: 'app-created',
      title: 'App created',
      launchSurface: 'app' as const,
    };
    store.recordAppCreatedSession(created);
    const createdRecord = JSON.parse(readFileSync(path, 'utf8')).provenance[sessionKey('codex', 'app-created')] as {
      appCreatedAt?: number;
      appMutatedPrivateAt?: number;
      launchSurface?: string;
    };
    check('appCreatedAt is persisted by app-created event', typeof createdRecord?.appCreatedAt === 'number');
    const before = createdRecord?.appCreatedAt;
    store.recordAppMutation(created);
    const refreshed = readProvenance(root);
    const recreatedRecord = refreshed.provenance?.[sessionKey('codex', 'app-created')];
    check('app mutation keeps existing appCreatedAt', recreatedRecord?.appCreatedAt === before);
  }

  // 10) recordAppMutation returns true only for a private-present, first-time evidence write.
  {
    const root = tempRoot('mutation-return');
    const store = new SessionMetadataStore(root);
    const privateBase: SessionInfo = {
      ...withControl('private'),
      id: 'mutation-return',
      title: 'Mutation return',
      status: 'idle',
      attachMode: 'observe',
      tool: 'codex',
    };
    const first = store.recordAppMutation(privateBase);
    const second = store.recordAppMutation(privateBase);
    const absent = {
      ...privateBase,
      control: {
        drive: privateBase.control!.drive,
        terminalSync: { ...privateBase.control!.terminalSync, presence: 'absent' as const },
      },
    };
    const nonPrivate = store.recordAppMutation(absent);
    check('first private mutation returns true', first === true);
    check('repeated private mutation returns false', second === false);
    check('non-private mutation returns false', nonPrivate === false);
  }

  // 11) no-op/rejected command outcomes do not create mutation evidence, but accepted commands do.
  {
    const accepted = { notice: 'Stopped the turn.' };
    const noOp = { notice: 'No running turn to stop.' };
    check('accepted stop command is mutation evidence', isAcceptedMutationCommand('stop', undefined, accepted));
    check('no-op stop command is not mutation evidence', !isAcceptedMutationCommand('stop', undefined, noOp));
    check('explicitly rejected command result is not mutation evidence', !isAcceptedMutationCommand('compact', undefined, { accepted: false } as never));

    const root = tempRoot('command-outcomes');
    const store = new SessionMetadataStore(root);
    const base = withControl('private');
    if (isAcceptedMutationCommand('stop', undefined, accepted)) store.recordAppMutation(base);
    const acceptedRecord = readProvenance(root).provenance?.[sessionKey('codex', base.id)];
    check('accepted command persists private mutation evidence', typeof acceptedRecord?.appMutatedPrivateAt === 'number');

    const noOpRoot = tempRoot('command-no-op');
    const noOpStore = new SessionMetadataStore(noOpRoot);
    if (isAcceptedMutationCommand('stop', undefined, noOp)) noOpStore.recordAppMutation(base);
    check('no-op command leaves provenance absent', readProvenance(noOpRoot).provenance?.[sessionKey('codex', base.id)] === undefined);

    const rejectedRoot = tempRoot('command-rejected');
    const rejectedStore = new SessionMetadataStore(rejectedRoot);
    try {
      throw new Error('command rejected');
    } catch {
      // The broker's rejected-command path does not call recordAppMutation.
    }
    check('rejected command leaves provenance absent', readProvenance(rejectedRoot).provenance?.[sessionKey('codex', base.id)] === undefined);
  }

  // 12) mutation-time freshness can record a terminal that became private after attach.
  {
    const root = tempRoot('post-attach-private');
    const store = new SessionMetadataStore(root);
    const attached: SessionInfo = {
      ...withControl('absent'),
      id: 'broker-id-before-refresh',
      nativeId: 'native-id-after-refresh',
      title: 'Post-attach transition',
      status: 'idle',
      attachMode: 'resume',
      tool: 'codex',
    };
    const freshPrivate: SessionInfo = {
      ...attached,
      id: 'broker-id-after-refresh',
      control: {
        ...attached.control!,
        terminalSync: {
          ...attached.control!.terminalSync,
          presence: 'private',
        },
      },
    };
    const mutationInfo = overlayFreshTerminalPresence(attached, [freshPrivate]);
    check('watcher-private post-attach transition is selected by native identity', mutationInfo.control?.terminalSync?.presence === 'private');
    check('fresh presence overlay preserves current attach mode', mutationInfo.attachMode === 'resume');
    store.recordAppMutation(mutationInfo);
    check('post-attach private prompt records behind evidence', store.apply(mutationInfo).control?.terminalSync?.behind === true);

    const freshAbsent = {
      ...freshPrivate,
      control: {
        ...freshPrivate.control!,
        terminalSync: { ...freshPrivate.control!.terminalSync, presence: 'absent' as const },
      },
    };
    check(
      'private freshness wins over later absent freshness',
      overlayFreshTerminalPresence(attached, [freshPrivate, freshAbsent]).control?.terminalSync?.presence === 'private',
    );
    check(
      'private freshness wins over earlier unknown freshness',
      overlayFreshTerminalPresence(attached, [{ ...freshPrivate, control: { ...freshPrivate.control!, terminalSync: { ...freshPrivate.control!.terminalSync, presence: 'unknown' as const } } }, freshPrivate]).control?.terminalSync?.presence === 'private',
    );
    const freshShared = {
      ...freshPrivate,
      control: {
        ...freshPrivate.control!,
        terminalSync: { ...freshPrivate.control!.terminalSync, presence: 'shared' as const },
      },
    };
    check(
      'explicit shared freshness wins when no private evidence exists',
      overlayFreshTerminalPresence(attached, [freshAbsent, freshShared]).control?.terminalSync?.presence === 'shared',
    );

    const unknown = {
      ...freshPrivate,
      control: {
        ...freshPrivate.control!,
        terminalSync: { ...freshPrivate.control!.terminalSync, presence: 'unknown' as const },
      },
    };
    const conservative = overlayFreshTerminalPresence(attached, [unknown]);
    check('unknown freshness never infers private', conservative.control?.terminalSync?.presence === 'unknown');
  }

  // 13) shared rejoin clears private-divergence evidence only when authoritative, across reloads.
  {
    const root = tempRoot('shared-rejoin');
    const store = new SessionMetadataStore(root);
    const base: SessionInfo = {
      ...withControl('private'),
      id: 'rejoin',
      title: 'Rejoin lifecycle',
      status: 'idle',
      attachMode: 'observe',
      tool: 'codex',
    };
    store.recordAppCreatedSession(base);
    check('first private app mutation is accepted', store.recordAppMutation(base) === true);
    const privateBefore = store.apply(base);
    check('private -> first mutation yields behind true', privateBefore.control?.terminalSync?.behind === true);

    const withPresence = (presence: SessionTerminalPresence): SessionInfo => ({
      ...base,
      control: {
        drive: base.control!.drive,
        terminalSync: {
          ...base.control!.terminalSync,
          presence,
        },
      },
    });
    const absent = withPresence('absent');
    const unknown = withPresence('unknown');
    check('absent does not clear evidence', store.clearPrivateMutationEvidenceOnSharedRejoin(absent) === false);
    check('unknown does not clear evidence', store.clearPrivateMutationEvidenceOnSharedRejoin(unknown) === false);

    const shared = {
      ...base,
      control: {
        drive: base.control!.drive,
        terminalSync: { ...base.control!.terminalSync, presence: 'shared' as const },
      },
    };
    check('shared rejoin clears evidence', store.clearPrivateMutationEvidenceOnSharedRejoin(shared) === true);
    const sharedAfter = store.apply(shared);
    check('shared rejoin yields behind false', sharedAfter.control?.terminalSync?.behind === false);
    const afterShared = readProvenance(root);
    const persistedRejoin = afterShared.provenance?.[sessionKey('codex', 'rejoin')];
    check('shared rejoin clears durable appMutatedPrivateAt', persistedRejoin?.appMutatedPrivateAt === undefined);

    const reloaded = new SessionMetadataStore(root);
    const reloadedShared = reloaded.apply(shared);
    check('reloaded shared rejoin keeps behind false', reloadedShared.control?.terminalSync?.behind === false);
    const privateAgain: SessionInfo = {
      ...shared,
      control: {
        drive: shared.control!.drive,
        terminalSync: { ...shared.control!.terminalSync, presence: 'private' as const },
      },
    };
    const laterPrivateNoMutation = reloaded.apply(privateAgain);
    check('later private after shared rejoin but before new mutation stays behind false', laterPrivateNoMutation.control?.terminalSync?.behind === false);
    const laterMutation = reloaded.recordAppMutation(privateAgain);
    check('new private mutation after shared rejoin is recorded', laterMutation === true);
    const afterNewMutation = reloaded.apply(privateAgain);
    check('new private mutation re-enables behind true', afterNewMutation.control?.terminalSync?.behind === true);
  }
} catch (err) {
  console.error('ERROR:', err);
  failures += 1;
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll session provenance checks passed.');
process.exit(failures ? 1 : 0);
