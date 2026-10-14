import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart'
    show defaultScriptedHello;

void main() {
  late _SpyCredentialStore credentialStore;
  late _InMemoryBrokerProfileRepository repository;
  late _InMemoryActiveBrokerProfileStore activeStore;
  late ProviderContainer container;

  setUp(() {
    credentialStore = _SpyCredentialStore();
    repository = _InMemoryBrokerProfileRepository();
    activeStore = _InMemoryActiveBrokerProfileStore();

    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    container = ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWithValue(database),
        credentialStoreProvider.overrideWithValue(credentialStore),
        brokerProfileRepositoryProvider.overrideWithValue(repository),
        activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  BrokerProfile remoteProfile({
    String credentialKey = 'broker-token:http://broker.example.com:9443',
    bool withCredentialKey = true,
  }) {
    return BrokerProfile(
      id: 'http://broker.example.com:9443',
      displayName: 'Remote Broker',
      baseUri: Uri.parse('http://broker.example.com:9443'),
      createdAt: DateTime(2026, 6),
      credentialKey: withCredentialKey ? credentialKey : null,
    );
  }

  group('BrokerProfileManagerController', () {
    test(
      'deleting a profile removes ALL durable broker-bound authority, so a '
      're-added profile with the same id and endpoint recovers nothing',
      () async {
        const credentialKey = 'broker-token:http://broker.example.com:9443';
        final profile = remoteProfile();
        await repository.save(profile);
        await credentialStore.writeBrokerToken(credentialKey, 'old-token');
        final scope = RosterSource.ofProfile(profile).storageKey;
        final database = container.read(appDatabaseProvider);
        const sessionKey = SessionDetailKey(
          tool: 'claude',
          sessionId: 'session-1',
        );
        final driveIntents = DriftSessionDriveIntentStore(database);
        final outbox = DriftSessionOutboxRepository(database);
        final transcripts = DriftSessionTranscriptRepository(database);
        final modelPreferences = DriftSessionModelPreferenceStore(database);
        final identityStore = DriftBrokerIdentityStore(database);
        final openSessions = DriftOpenSessionsStore(database);

        // Authority the profile accumulated while it lived — including one
        // legacy bare-id record from before endpoint qualification.
        await driveIntents.rememberAppCreated(
          brokerProfileId: scope,
          tool: sessionKey.tool,
          sessionId: sessionKey.sessionId,
        );
        await driveIntents.rememberAppCreated(
          brokerProfileId: profile.id,
          tool: sessionKey.tool,
          sessionId: 'legacy-1',
        );
        await outbox.upsert(
          SessionOutboxMessage.create(
            sessionKey: sessionKey,
            brokerProfileId: scope,
            clientMessageId: 'cm-deleted-profile',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'queued before deletion'},
          ),
        );
        await outbox.markRetryable('cm-deleted-profile', 'offline');
        await transcripts.upsert(
          SessionTranscriptSnapshot(
            brokerProfileId: scope,
            sessionKey: sessionKey,
            messages: const [
              AgentMessage(
                type: AgentMessageType.userMessage,
                raw: {'type': 'cached-before-deletion'},
              ),
            ],
            hasEarlier: false,
            updatedAt: DateTime(2026, 7, 28),
          ),
        );
        final preferenceKey = SessionModelPreferenceKey(
          brokerProfileId: scope,
          tool: sessionKey.tool,
          lineageId: 'lineage-1',
        );
        await modelPreferences.save(
          preferenceKey,
          const SessionCurrentModel(
            providerID: 'anthropic',
            modelID: 'claude-opus-5',
          ),
        );
        await identityStore.writeHello(scope, defaultScriptedHello);
        await openSessions.save(
          profile.id,
          const OpenSessionsSnapshot(
            refs: [
              SessionRef.cachedIdentity(
                tool: 'claude',
                id: 'legacy-open',
                title: 'Legacy open',
              ),
            ],
            activeKey: 'claude/legacy-open',
          ),
        );
        await openSessions.loadLossless(
          scope,
          legacyProfileId: profile.id,
        );
        await openSessions.openMember(
          scope,
          const SessionRef.cachedIdentity(
            tool: 'codex',
            id: 'scoped-open',
            title: 'Scoped open',
          ),
        );
        await openSessions.saveActiveHint(scope, 'codex/scoped-open');
        container
            .read(createdSessionAttachIntentsProvider)
            .rememberResume(scope, sessionKey);
        container
            .read(createdSessionAttachIntentsProvider)
            .rememberLive(scope, sessionKey);
        // An unrelated profile's authority must survive the deletion.
        final otherProfile = BrokerProfile(
          id: 'other-broker',
          displayName: 'other',
          baseUri: Uri.parse('http://other.invalid:7734'),
          createdAt: DateTime(2026, 6),
        );
        final otherScope = RosterSource.ofProfile(otherProfile).storageKey;
        await driveIntents.rememberAppCreated(
          brokerProfileId: otherScope,
          tool: sessionKey.tool,
          sessionId: sessionKey.sessionId,
        );
        await openSessions.openMember(
          otherScope,
          const SessionRef.cachedIdentity(
            tool: 'pi',
            id: 'other-open',
            title: 'Other open',
          ),
        );

        await container
            .read(brokerProfileManagerControllerProvider)
            .deleteProfile(profile.id);

        // Re-adding the same id and endpoint derives the SAME scope key;
        // every store must answer empty for it.
        expect(
          await driveIntents.read(
            brokerProfileId: scope,
            tool: sessionKey.tool,
            sessionId: sessionKey.sessionId,
          ),
          isNull,
          reason: 'no Drive restoration after delete → re-add',
        );
        expect(
          await driveIntents.read(
            brokerProfileId: profile.id,
            tool: sessionKey.tool,
            sessionId: 'legacy-1',
          ),
          isNull,
          reason: 'legacy bare-id provenance goes with the profile',
        );
        expect(
          await outbox.loadForSession(sessionKey, brokerProfileId: scope),
          isEmpty,
          reason: 'no prompt replay after delete → re-add',
        );
        expect(
          await transcripts.load(
            brokerProfileId: scope,
            sessionKey: sessionKey,
          ),
          isNull,
          reason: 'no cached transcript after delete → re-add',
        );
        expect(await modelPreferences.load(preferenceKey), isNull);
        expect((await openSessions.loadLossless(scope)).refs, isEmpty);
        expect(
          (await openSessions.loadLossless(otherScope)).refs.single.id,
          'other-open',
        );
        expect(
          await identityStore.readHello(scope),
          isNull,
          reason: "the deleted profile's negotiated identity goes with it",
        );
        expect(
          container
              .read(createdSessionAttachIntentsProvider)
              .takeResume(scope, sessionKey),
          isFalse,
          reason: 'no one-shot Drive intent after delete → re-add',
        );
        expect(
          container
              .read(createdSessionAttachIntentsProvider)
              .takeMode(scope, sessionKey),
          isNull,
          reason: 'no one-shot live intent after delete → re-add',
        );
        expect(
          await driveIntents.read(
            brokerProfileId: otherScope,
            tool: sessionKey.tool,
            sessionId: sessionKey.sessionId,
          ),
          isNotNull,
          reason: "another profile's authority is untouched",
        );
      },
    );

    test(
      'stale delete captured from A cannot revoke or delete replacement B',
      () async {
        final database = container.read(appDatabaseProvider);
        final durable = DriftBrokerProfileRepository(database);
        final first = await durable.save(
          remoteProfile(withCredentialKey: false),
        );
        final held = _HoldFirstProfileReadRepository(durable);
        final scoped = ProviderContainer(
          overrides: [
            appDatabaseProvider.overrideWithValue(database),
            credentialStoreProvider.overrideWithValue(credentialStore),
            brokerProfileRepositoryProvider.overrideWithValue(held),
            activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
          ],
        );
        addTearDown(scoped.dispose);

        final staleDelete = scoped
            .read(brokerProfileManagerControllerProvider)
            .deleteProfile(first.id);
        await held.firstReadStarted.future;

        await durable.delete(
          id: first.id,
          incarnationId: first.incarnationId,
        );
        final replacement = await durable.save(
          remoteProfile(withCredentialKey: false).copyWith(
            displayName: 'Replacement B',
            baseUri: Uri.parse('http://replacement-b.test:9443'),
          ),
        );
        scoped.read(activeBrokerProfileProvider.notifier).state = replacement;
        activeStore.activeProfileId = replacement.id;

        held.releaseFirstRead.complete();
        await staleDelete;

        final surviving = await durable.getById(first.id);
        expect(surviving?.incarnationId, replacement.incarnationId);
        expect(surviving?.displayName, 'Replacement B');
        expect(surviving?.baseUri.host, 'replacement-b.test');
        expect(scoped.read(activeBrokerProfileProvider), replacement);
        expect(activeStore.activeProfileId, replacement.id);
      },
    );

    test(
      'a row written while the deletion runs does not survive it',
      () async {
        final profile = remoteProfile(withCredentialKey: false);
        await repository.save(profile);
        final scope = RosterSource.ofProfile(profile).storageKey;
        final database = container.read(appDatabaseProvider);
        const sessionKey = SessionDetailKey(
          tool: 'claude',
          sessionId: 'session-1',
        );
        final outbox = DriftSessionOutboxRepository(database);
        BrokerProfile? activeWhenCleanupRan;

        // Stands in for a controller that had already resolved this scope and
        // enqueues a retryable action while the deletion is in flight.
        late final ProviderContainer scoped;
        scoped = ProviderContainer(
          overrides: [
            appDatabaseProvider.overrideWithValue(database),
            credentialStoreProvider.overrideWithValue(credentialStore),
            brokerProfileRepositoryProvider.overrideWithValue(repository),
            activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
            rosterSnapshotRepositoryProvider.overrideWithValue(
              _WritesDuringCleanupRosterSnapshotRepository(
                onDelete: () async {
                  activeWhenCleanupRan = scoped.read(
                    activeBrokerProfileProvider,
                  );
                  await outbox.upsert(
                    SessionOutboxMessage.create(
                      sessionKey: sessionKey,
                      brokerProfileId: scope,
                      clientMessageId: 'cm-raced-the-deletion',
                      kind: SessionOutboxMessageKind.prompt,
                      payload: const {'text': 'enqueued mid-deletion'},
                    ),
                  );
                },
              ),
            ),
          ],
        );
        addTearDown(scoped.dispose);
        scoped.read(activeBrokerProfileProvider.notifier).state = profile;
        activeStore.activeProfileId = profile.id;

        await scoped
            .read(brokerProfileManagerControllerProvider)
            .deleteProfile(profile.id);

        expect(
          activeWhenCleanupRan,
          isNull,
          reason:
              'the fence is dropped BEFORE any row is touched, so a '
              'controller has already lost the broker it would write for',
        );
        expect(
          await outbox.loadForSession(sessionKey, brokerProfileId: scope),
          isEmpty,
          reason:
              'the purge is ordered after the cleanup seams and commits '
              'with them, so a row written during the deletion goes too',
        );
      },
    );

    test(
      'attention persistence released after delete and re-add stays retired',
      () async {
        final profile = remoteProfile(withCredentialKey: false);
        final database = container.read(appDatabaseProvider);
        final profiles = DriftBrokerProfileRepository(database);
        final attention = DriftAttentionRepository(database);
        final scoped = ProviderContainer(
          overrides: [
            appDatabaseProvider.overrideWithValue(database),
            credentialStoreProvider.overrideWithValue(credentialStore),
            brokerProfileRepositoryProvider.overrideWithValue(profiles),
            activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
          ],
        );
        addTearDown(scoped.dispose);

        final first = await scoped
            .read(brokerProfileListProvider.notifier)
            .saveProfile(profile);
        final oldScope = RosterSource.ofProfile(first).storageKey;
        final releasePersistence = Completer<void>();
        final persistenceStarted = Completer<void>();
        final stalePersistence = () async {
          persistenceStarted.complete();
          await releasePersistence.future;
          await attention.persistAttentionEventsPage(
            brokerProfileId: oldScope,
            page: AttentionEventsPage(
              events: [
                AttentionEventView.fromJson({
                  'id': 'late-old-incarnation',
                  'cursor': 9,
                  'revision': 1,
                  'presentationRevision': 1,
                  'kind': 'runtime-update-ready',
                  'state': 'active',
                  'severity': 'maintenance',
                  'dedupeKey': 'late-old-incarnation',
                  'createdAt': 1,
                  'updatedAt': 1,
                  'title': 'Old generation',
                  'action': {'kind': 'open-runtime-settings'},
                }),
              ],
              cursor: 9,
              reset: false,
              hasMore: false,
            ),
          );
        }();
        await persistenceStarted.future;

        await scoped
            .read(brokerProfileManagerControllerProvider)
            .deleteProfile(first.id);
        final replacement = await scoped
            .read(brokerProfileListProvider.notifier)
            .saveProfile(profile);
        final replacementScope = RosterSource.ofProfile(replacement).storageKey;
        expect(replacementScope, isNot(oldScope));

        releasePersistence.complete();
        await stalePersistence;

        expect(
          await attention.loadEvents(replacementScope),
          isEmpty,
          reason: 'the replacement inbox cannot address the retired page',
        );
        expect(
          await attention.loadCursor(replacementScope),
          0,
          reason: 'the replacement cursor starts from an empty incarnation',
        );
        expect(
          (await attention.loadEvents(oldScope)).single.id,
          'late-old-incarnation',
          reason: 'the held writer retained its captured incarnation',
        );
      },
    );

    test(
      'held A active-store publication cannot reactivate A after replacement',
      () async {
        final profileA = remoteProfile(withCredentialKey: false).copyWith(
          incarnationId: 'inc-a',
        );
        await repository.save(profileA);
        container.read(activeBrokerProfileProvider.notifier).state = profileA;
        await activeStore.setActiveProfileId(profileA.id);

        activeStore.holdNextSet();
        final staleEdit = container
            .read(brokerProfileManagerControllerProvider)
            .saveProfileEdits(
              profileId: profileA.id,
              displayName: 'Edited A',
              baseUri: profileA.baseUri.toString(),
              expectedProfile: profileA,
            );
        await activeStore.setStarted.future;

        final replacement = () async {
          await container
              .read(brokerProfileManagerControllerProvider)
              .deleteProfile(profileA.id, expectedProfile: profileA);
          final profileB = await container
              .read(brokerProfileListProvider.notifier)
              .saveProfile(
                remoteProfile(withCredentialKey: false).copyWith(
                  displayName: 'Replacement B',
                  createdAt: DateTime(2026, 7),
                ),
              );
          await container
              .read(brokerProfileManagerControllerProvider)
              .setActiveProfile(
                profileB.id,
                expectedProfile: profileB,
              );
          return profileB;
        }();

        var replacementFinished = false;
        unawaited(replacement.whenComplete(() => replacementFinished = true));
        await Future<void>.delayed(Duration.zero);
        expect(replacementFinished, isFalse);

        activeStore.releaseSet();
        await staleEdit;
        final profileB = await replacement;

        expect(activeStore.activeProfileId, profileB.id);
        expect(
          container.read(activeBrokerProfileProvider)?.displayName,
          'Replacement B',
        );
        expect(
          container.read(activeBrokerProfileProvider)?.incarnationId,
          profileB.incarnationId,
        );
      },
    );
  });
}

/// Roster cleanup that writes broker-bound authority while the deletion runs.
final class _WritesDuringCleanupRosterSnapshotRepository
    implements RosterSnapshotRepository {
  _WritesDuringCleanupRosterSnapshotRepository({required this.onDelete});

  final Future<void> Function() onDelete;

  @override
  Future<void> deleteForProfile(String brokerProfileId) => onDelete();

  @override
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  }) async => null;

  @override
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  }) async => throw UnimplementedError();
}

final class _SpyCredentialStore implements CredentialStore {
  final Map<String, String> _tokens = <String, String>{};

  bool failDelete = false;

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    return _tokens[credentialKey];
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    _tokens[credentialKey] = token;
  }

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {
    if (failDelete) {
      throw StateError('delete failed');
    }
    _tokens.remove(credentialKey);
  }
}

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = <String, BrokerProfile>{};
  bool failSave = false;
  bool failDelete = false;

  @override
  Future<List<BrokerProfile>> getAll() async {
    return _profiles.values.toList();
  }

  @override
  Future<BrokerProfile?> getById(String id) async {
    return _profiles[id];
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    if (failSave) {
      throw StateError('save failed');
    }
    _profiles[profile.id] = profile;
    return profile;
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async {
    if (failDelete) {
      throw StateError('delete failed');
    }
    return _profiles.remove(id) != null;
  }
}

class _InMemoryActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? activeProfileId;
  bool wasCleared = false;
  bool failClear = false;
  Completer<void> setStarted = Completer<void>();
  Completer<void>? _releaseHeldSet;

  void holdNextSet() {
    setStarted = Completer<void>();
    _releaseHeldSet = Completer<void>();
  }

  void releaseSet() {
    _releaseHeldSet?.complete();
  }

  @override
  Future<String?> getActiveProfileId() async {
    return activeProfileId;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    final release = _releaseHeldSet;
    if (release != null) {
      setStarted.complete();
      await release.future;
      if (identical(_releaseHeldSet, release)) {
        _releaseHeldSet = null;
      }
    }
    activeProfileId = profileId;
    wasCleared = false;
  }

  @override
  Future<void> clearActiveProfileId() async {
    if (failClear) throw StateError('clear active failed');
    activeProfileId = null;
    wasCleared = true;
  }
}

final class _HoldFirstProfileReadRepository implements BrokerProfileRepository {
  _HoldFirstProfileReadRepository(this.delegate);

  final BrokerProfileRepository delegate;
  final Completer<void> firstReadStarted = Completer<void>();
  final Completer<void> releaseFirstRead = Completer<void>();
  var _heldFirstRead = false;

  @override
  Future<List<BrokerProfile>> getAll() => delegate.getAll();

  @override
  Future<BrokerProfile?> getById(String id) async {
    final result = await delegate.getById(id);
    if (!_heldFirstRead) {
      _heldFirstRead = true;
      firstReadStarted.complete();
      await releaseFirstRead.future;
    }
    return result;
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) => delegate.save(profile);

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) => delegate.delete(id: id, incarnationId: incarnationId);
}
