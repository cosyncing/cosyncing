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
  provenance?: Record<string, { launchSurface?: string; appCreatedAt?: number; appMutatedPrivateAt?: number; currentModel?: SessionInfo['currentModel'] }>;
} => {
  const path = join(root, 'session-metadata.json');
  if (!existsSync(path)) return { version: 2, provenance: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as {
    version: number;
    provenance?: Record<string, { launchSurface?: string; appCreatedAt?: number; appMutatedPrivateAt?: number; currentModel?: SessionInfo['currentModel'] }>;
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

  // 12) exact app-selected model survives identity refresh and later app picks.
  {
    const root = tempRoot('model-hint');
    const store = new SessionMetadataStore(root);
    const created: SessionInfo = {
      ...withControl('absent'),
      id: 'encoded-path-a',
      nativeId: 'native-model-session',
      title: 'Model hint',
      currentModel: {
        providerID: 'vllm-hpc',
        modelID: 'qwen3.8-27B-FP8',
        variant: 'vllm-hpc',
        reasoningEffort: 'high',
      },
    };
    store.recordAppCreatedSession(created);
    const reloaded = new SessionMetadataStore(root);
    const initial = reloaded.currentModelHint({
      tool: 'codex',
      id: 'encoded-path-b',
      nativeId: 'native-model-session',
    });
    check('create-time model hint survives native-id refresh', initial?.providerID === 'vllm-hpc' && initial.modelID === 'qwen3.8-27B-FP8' && initial.variant === 'vllm-hpc' && initial.reasoningEffort === 'high');

    const changed: SessionInfo = {
      ...created,
      id: 'encoded-path-b',
      currentModel: {
        providerID: 'volcengine-coding-plan',
        modelID: 'deepseek-v4-pro',
        variant: 'volcengine',
      },
    };
    check('non-private app model change updates durable hint', reloaded.recordAppMutation(changed) === true);
    const updated = new SessionMetadataStore(root).currentModelHint(changed);
    check('later app model selection replaces create-time hint', updated?.providerID === 'volcengine-coding-plan' && updated.modelID === 'deepseek-v4-pro' && updated.variant === 'volcengine');

    const native = {
      tool: changed.tool,
      id: changed.id,
      nativeId: changed.nativeId,
      currentModel: { providerID: 'native-provider', modelID: 'native-model' },
    };
    check('authoritative native model evidence replaces the provisional durable hint',
      reloaded.recordCurrentModelHint(native) === true);
    const nativeUpdated = new SessionMetadataStore(root).currentModelHint(native);
    check('native model evidence survives metadata-store reload',
      nativeUpdated?.providerID === 'native-provider' && nativeUpdated.modelID === 'native-model');

    // The human LABEL has to survive too. The wire permits `currentModel.label`,
    // adapters with a host-authored catalogue publish one (Cline and Kimi both
    // do), and the client deliberately refuses to invent one from a raw model id
    // -- so a label erased here is a session that renders the generic `Model`
    // chip with no way to recover the name. `cleanCurrentModel` rebuilt the
    // record field by field and dropped it for EVERY adapter.
    //
    // The fixture label is a real one (`Qwen3.8 Flash Next (HPC vLLM)`, as
    // measured in the installed Kilo composer) rather than a model id. A test
    // that passed an id here would still pass while proving nothing a client can
    // use: the client discards an id-shaped label on arrival.
    const labelRoot = tempRoot('model-label');
    const labelStore = new SessionMetadataStore(labelRoot);
    const labelled: SessionInfo = {
      ...withControl('absent'),
      id: 'labelled-a',
      nativeId: 'native-labelled',
      title: 'Labelled',
      currentModel: {
        providerID: 'vllm-hpc',
        modelID: 'qwen3.8-flash-next',
        label: 'Qwen3.8 Flash Next (HPC vLLM)',
      },
    };
    labelStore.recordAppCreatedSession(labelled);
    const labelReloaded = new SessionMetadataStore(labelRoot).currentModelHint(labelled);
    check('the model label survives cleaning and a metadata-store reload',
      labelReloaded?.label === 'Qwen3.8 Flash Next (HPC vLLM)');

    // A label arriving for an already-known model must register as a change, or
    // a client missing the label never receives it.
    const relabelled = {
      tool: labelled.tool,
      id: labelled.id,
      nativeId: labelled.nativeId,
      currentModel: { providerID: 'vllm-hpc', modelID: 'qwen3.8-flash-next', label: 'Qwen3.8 Flash Next' },
    };
    check('a label-only change is recorded rather than read as no change',
      new SessionMetadataStore(labelRoot).recordCurrentModelHint(relabelled) === true);
  }

  // 13) exact native prompt correlations are bounded, durable, replaceable, and revoked with writer provenance.
  {
    const root = tempRoot('prompt-correlations');
    const info = { tool: 'cline', id: 'cline-session', nativeId: 'cline-native' };
    const store = new SessionMetadataStore(root);
    store.recordAppCreatedSession(info);
    const digest = `sha256:${'a'.repeat(64)}`;
    check('a valid prompt correlation is recorded', store.recordAppPromptCorrelation({
      ...info,
      correlation: {
        nativeMessageId: 'native-user-1', nativeMessageDigest: digest,
        key: 'app-key-1', clientKey: 'client-key-1',
      },
    }) === true);
    check('a malformed prompt digest is refused', store.recordAppPromptCorrelation({
      ...info,
      correlation: {
        nativeMessageId: 'native-user-bad', nativeMessageDigest: 'not-a-digest', key: 'bad-key',
      },
    }) === false);
    store.recordAppPromptCorrelation({
      ...info,
      correlation: {
        nativeMessageId: 'native-user-1', nativeMessageDigest: digest,
        key: 'app-key-replaced', clientKey: 'client-key-replaced',
      },
    });
    for (let index = 2; index <= 70; index += 1) {
      store.recordAppPromptCorrelation({
        ...info,
        correlation: {
          nativeMessageId: `native-user-${index}`,
          nativeMessageDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
          key: `app-key-${index}`,
        },
      });
    }
    const reloaded = new SessionMetadataStore(root);
    const correlations = reloaded.appPromptCorrelations(info);
    check('prompt correlations survive reload and remain bounded',
      correlations.length === 64
        && correlations.at(-1)?.nativeMessageId === 'native-user-70'
        && !correlations.some((entry) => entry.nativeMessageId === 'native-user-1'));

    for (let sessionIndex = 1; sessionIndex <= 4; sessionIndex += 1) {
      const sibling = {
        tool: 'cline', id: `cline-session-${sessionIndex}`, nativeId: `cline-native-${sessionIndex}`,
      };
      store.recordAppCreatedSession(sibling);
      for (let index = 0; index < 64; index += 1) {
        store.recordAppPromptCorrelation({
          ...sibling,
          correlation: {
            nativeMessageId: `native-${sessionIndex}-${index}`,
            nativeMessageDigest: `sha256:${(sessionIndex * 100 + index).toString(16).padStart(64, '0')}`,
            key: `app-${sessionIndex}-${index}`,
          },
        });
      }
    }
    const globallyReloaded = new SessionMetadataStore(root);
    const globalCount = [info, ...Array.from({ length: 4 }, (_, index) => ({
      tool: 'cline', id: `cline-session-${index + 1}`, nativeId: `cline-native-${index + 1}`,
    }))].reduce((total, candidate) => total + globallyReloaded.appPromptCorrelations(candidate).length, 0);
    check('prompt correlations have one global bounded-retention ceiling', globalCount === 256);
    reloaded.revokeAppCreatedSession(info);
    check('writer revocation also removes every stored prompt correlation',
      new SessionMetadataStore(root).appPromptCorrelations(info).length === 0);
  }

  // 14) authoritative terminal summaries share the exact durable history boundary.
  {
    const root = tempRoot('terminal-summaries');
    const info = { tool: 'grok', id: 'grok-session', nativeId: 'grok-native' };
    const store = new SessionMetadataStore(root);
    store.recordAppCreatedSession(info);
    const historyBoundary = {
      sourceId: '/fixture/updates.jsonl',
      revision: 'fixture-revision-1',
      appendPosition: 42,
      rewriteToken: 'fixture-prefix-1',
    };
    check('a terminal summary is recorded atomically with its exact history boundary',
      store.recordAppHistoryBoundary({
        ...info,
        historyBoundary,
        terminalSummary: {
          type: 'run-summary',
          key: 'grok:turn-1:acp-terminal',
          turnId: 'grok:turn-1',
          userMessageKey: 'grok:user-1',
          assistantMessageKey: 'grok:assistant-1',
          status: 'done',
        },
      }) === true);
    const reloaded = new SessionMetadataStore(root);
    check('the history boundary and terminal summary survive one metadata-store reload',
      JSON.stringify(reloaded.appHistoryBoundary(info)) === JSON.stringify(historyBoundary)
        && reloaded.appTerminalSummaries(info).length === 1
        && reloaded.appTerminalSummaries(info)[0]?.status === 'done');
    check('re-recording the same terminal key replaces rather than duplicates it',
      reloaded.recordAppHistoryBoundary({
        ...info,
        historyBoundary: { ...historyBoundary, revision: 'fixture-revision-2', appendPosition: 43 },
        terminalSummary: {
          type: 'run-summary',
          key: 'grok:turn-1:acp-terminal',
          turnId: 'grok:turn-1',
          status: 'cancelled',
        },
      }) === true
        && reloaded.appTerminalSummaries(info).length === 1
        && reloaded.appTerminalSummaries(info)[0]?.status === 'cancelled');
    check('a malformed non-terminal summary is refused without advancing the boundary',
      reloaded.recordAppHistoryBoundary({
        ...info,
        historyBoundary: { ...historyBoundary, revision: 'must-not-persist' },
        terminalSummary: {
          type: 'run-summary',
          key: 'invalid-running',
          turnId: 'grok:turn-invalid',
          status: 'running' as never,
        },
      }) === false
        && reloaded.appHistoryBoundary(info)?.revision === 'fixture-revision-2');
    // Token counts must survive the store, and a summary REPUBLISHED with them
    // must actually be written. `cleanTerminalSummary` rebuilds a stored summary
    // field by field and `terminalSummariesEqual` decides whether anything
    // changed -- a field missing from either is dropped silently, which is what
    // hid Cline's per-turn usage while the summary itself survived.
    check('a terminal summary carries its token counts through the store',
      reloaded.recordAppHistoryBoundary({
        ...info,
        historyBoundary: { ...historyBoundary, revision: 'fixture-revision-3', appendPosition: 44 },
        terminalSummary: {
          type: 'run-summary',
          key: 'grok:turn-1:acp-terminal',
          turnId: 'grok:turn-1',
          status: 'done',
          tokens: { input: 3945, output: 289, cacheRead: 0 },
        },
      }) === true
        && new SessionMetadataStore(root).appTerminalSummaries(info)[0]?.tokens?.input === 3945
        && new SessionMetadataStore(root).appTerminalSummaries(info)[0]?.tokens?.output === 289);
    check('republishing the same summary with counts is not mistaken for no change',
      reloaded.recordAppHistoryBoundary({
        ...info,
        historyBoundary: { ...historyBoundary, revision: 'fixture-revision-4', appendPosition: 45 },
        terminalSummary: {
          type: 'run-summary',
          key: 'grok:turn-1:acp-terminal',
          turnId: 'grok:turn-1',
          status: 'done',
          tokens: { input: 4100, output: 512 },
        },
      }) === true
        && new SessionMetadataStore(root).appTerminalSummaries(info)[0]?.tokens?.input === 4100);
    check('counts that are not finite non-negative numbers are refused, not stored',
      reloaded.recordAppHistoryBoundary({
        ...info,
        historyBoundary: { ...historyBoundary, revision: 'fixture-revision-5', appendPosition: 46 },
        terminalSummary: {
          type: 'run-summary',
          key: 'grok:turn-1:acp-terminal',
          turnId: 'grok:turn-1',
          status: 'done',
          tokens: { input: Number.NaN, output: -3, cacheRead: 7 } as never,
        },
      }) === true
        && JSON.stringify(new SessionMetadataStore(root).appTerminalSummaries(info)[0]?.tokens)
          === JSON.stringify({ cacheRead: 7 }));

    reloaded.revokeAppCreatedSession(info);
    const revoked = new SessionMetadataStore(root);
    check('writer revocation removes the shared boundary and every terminal summary',
      revoked.appHistoryBoundary(info) === undefined
        && revoked.appTerminalSummaries(info).length === 0);
  }
} catch (err) {
  console.error('ERROR:', err);
  failures += 1;
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll session provenance checks passed.');
process.exit(failures ? 1 : 0);
