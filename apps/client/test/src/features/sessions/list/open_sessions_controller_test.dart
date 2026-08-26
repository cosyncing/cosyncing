import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

SessionRef _ref(
  String tool,
  String id, {
  String title = 'title',
  SessionStatus status = SessionStatus.idle,
}) => SessionRef(tool: tool, id: id, title: title, status: status);

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://127.0.0.1:7734'),
  createdAt: DateTime(2026),
);

/// Flushes fire-and-forget persistence microtasks.
Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  late _FakeOpenSessionsStore store;

  ProviderContainer buildContainer({BrokerProfile? profile}) {
    return ProviderContainer(
      overrides: [
        openSessionsStoreProvider.overrideWithValue(store),
        activeBrokerProfileProvider.overrideWith((ref) => profile),
      ],
    );
  }

  setUp(() => store = _FakeOpenSessionsStore());

  group('OpenSessionsController', () {
    test('starts empty with no active profile', () async {
      final container = buildContainer();
      addTearDown(container.dispose);

      final state = await container.read(openSessionsControllerProvider.future);
      expect(state.isEmpty, isTrue);
    });

    test('open adds, activates, and dedups by key', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      container.read(openSessionsControllerProvider.notifier)
        ..open(_ref('claude', 'a'))
        ..open(_ref('codex', 'b'))
        ..open(_ref('claude', 'a', title: 'renamed'));

      final state = container.read(openSessionsControllerProvider).value!;
      expect(state.refs.map((ref) => ref.key), ['claude/a', 'codex/b']);
      expect(state.refs.first.title, 'renamed');
      expect(state.activeKey, 'claude/a');
    });

    test('close removes and activates a neighbor', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      final controller = container.read(openSessionsControllerProvider.notifier)
        ..open(_ref('claude', 'a'))
        ..open(_ref('codex', 'b'))
        ..open(_ref('pi', 'c'))
        ..activate('codex/b');
      await controller.close('codex/b');

      final state = container.read(openSessionsControllerProvider).value!;
      expect(state.refs.map((ref) => ref.key), ['claude/a', 'pi/c']);
      expect(state.activeKey, 'pi/c');
    });

    test('closing the last tab clears the active key', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      final controller = container.read(
        openSessionsControllerProvider.notifier,
      )..open(_ref('claude', 'a'));
      await controller.close('claude/a');

      final state = container.read(openSessionsControllerProvider).value!;
      expect(state.isEmpty, isTrue);
      expect(state.activeKey, isNull);
    });

    test('closeOthers keeps only the target', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      final controller = container.read(openSessionsControllerProvider.notifier)
        ..open(_ref('claude', 'a'))
        ..open(_ref('codex', 'b'))
        ..open(_ref('pi', 'c'));
      await controller.closeOthers('codex/b');

      final state = container.read(openSessionsControllerProvider).value!;
      expect(state.refs.map((ref) => ref.key), ['codex/b']);
      expect(state.activeKey, 'codex/b');
    });

    test('reorder moves a tab (ReorderableListView semantics)', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      container.read(openSessionsControllerProvider.notifier)
        ..open(_ref('claude', 'a'))
        ..open(_ref('codex', 'b'))
        ..open(_ref('pi', 'c'))
        ..reorder(0, 3);

      final state = container.read(openSessionsControllerProvider).value!;
      expect(state.refs.map((ref) => ref.key), ['codex/b', 'pi/c', 'claude/a']);
    });

    test('refreshMetadata updates status of open tabs only', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      container.read(openSessionsControllerProvider.notifier)
        ..open(_ref('claude', 'a'))
        ..refreshMetadata([
          const SessionInfo(
            id: 'a',
            tool: 'claude',
            title: 'Fresh title',
            status: SessionStatus.needsInput,
            attachMode: AttachMode.observe,
          ),
          const SessionInfo(
            id: 'z',
            tool: 'claude',
            title: 'Not open',
            status: SessionStatus.working,
            attachMode: AttachMode.observe,
          ),
        ]);

      final state = container.read(openSessionsControllerProvider).value!;
      expect(state.refs.single.status, SessionStatus.needsInput);
      expect(state.refs.single.title, 'Fresh title');
    });

    test(
      'accepted rename updates and persists title without changing status',
      () async {
        final first = buildContainer(profile: _profile('p1'));
        await first.read(openSessionsControllerProvider.future);
        first.read(openSessionsControllerProvider.notifier)
          ..open(
            _ref(
              'codex',
              'a',
              title: 'Before',
              status: SessionStatus.needsInput,
            ),
          )
          ..renameSessionTitle('codex', 'a', 'After');
        await _settle();

        final renamed = first.read(openSessionsControllerProvider).value!;
        expect(renamed.refs.single.title, 'After');
        expect(renamed.refs.single.status, SessionStatus.needsInput);
        first.dispose();

        final second = buildContainer(profile: _profile('p1'));
        addTearDown(second.dispose);
        final restored = await second.read(
          openSessionsControllerProvider.future,
        );
        expect(restored.refs.single.title, 'After');
        expect(restored.refs.single.status, SessionStatus.needsInput);
      },
    );

    test('persists and restores across a fresh container', () async {
      final first = buildContainer(profile: _profile('p1'));
      await first.read(openSessionsControllerProvider.future);
      first.read(openSessionsControllerProvider.notifier)
        ..open(_ref('claude', 'a'))
        ..open(_ref('codex', 'b'));
      await _settle();
      first.dispose();

      final second = buildContainer(profile: _profile('p1'));
      addTearDown(second.dispose);
      final restored = await second.read(
        openSessionsControllerProvider.future,
      );
      expect(restored.refs.map((ref) => ref.key), ['claude/a', 'codex/b']);
      expect(restored.activeKey, 'codex/b');
    });

    group('cached identity (N3)', () {
      test('reopening from cached identity clears a stale status', () async {
        // The persisted tab carries a needs-input claim from before the last
        // restart. Reopening the session from the local snapshot means the
        // client has NO current status for it; keeping the old one presents a
        // stale claim as current, and a merge-style `open` cannot express that.
        final container = buildContainer(profile: _profile('p1'));
        addTearDown(container.dispose);
        await container.read(openSessionsControllerProvider.future);
        container.read(openSessionsControllerProvider.notifier)
          ..open(
            _ref(
              'claude',
              'a',
              title: 'Live title',
              status: SessionStatus.needsInput,
            ),
          )
          ..open(
            const SessionRef.cachedIdentity(
              tool: 'claude',
              id: 'a',
              title: 'Cached title',
            ),
          );

        final ref = container
            .read(openSessionsControllerProvider)
            .value!
            .refs
            .single;
        expect(ref.status, isNull, reason: 'unknown must replace, not merge');
        expect(ref.title, 'Cached title');
      });

      test('a cached-identity tab restores with no status', () async {
        final first = buildContainer(profile: _profile('p1'));
        await first.read(openSessionsControllerProvider.future);
        first
            .read(openSessionsControllerProvider.notifier)
            .open(
              const SessionRef.cachedIdentity(
                tool: 'codex',
                id: 'b',
                title: 'Cached title',
              ),
            );
        await _settle();
        first.dispose();

        final second = buildContainer(profile: _profile('p1'));
        addTearDown(second.dispose);
        final restored = await second.read(
          openSessionsControllerProvider.future,
        );
        expect(restored.refs.single.title, 'Cached title');
        expect(
          restored.refs.single.status,
          isNull,
          reason: 'a restart must not invent a status the client never had',
        );
      });

      test(
        'authoritative metadata still replaces an unknown status',
        () async {
          final container = buildContainer(profile: _profile('p1'));
          addTearDown(container.dispose);
          await container.read(openSessionsControllerProvider.future);
          container.read(openSessionsControllerProvider.notifier)
            ..open(
              const SessionRef.cachedIdentity(
                tool: 'claude',
                id: 'a',
                title: 'Cached title',
              ),
            )
            ..refreshMetadata([
              const SessionInfo(
                id: 'a',
                tool: 'claude',
                title: 'Real title',
                status: SessionStatus.working,
                attachMode: AttachMode.observe,
              ),
            ]);

          final ref = container
              .read(openSessionsControllerProvider)
              .value!
              .refs
              .single;
          expect(ref.status, SessionStatus.working);
          expect(ref.title, 'Real title');
        },
      );
    });

    test('working sets are scoped per broker profile', () async {
      final p1 = buildContainer(profile: _profile('p1'));
      await p1.read(openSessionsControllerProvider.future);
      p1
          .read(openSessionsControllerProvider.notifier)
          .open(_ref('claude', 'a'));
      await _settle();
      p1.dispose();

      final p2 = buildContainer(profile: _profile('p2'));
      addTearDown(p2.dispose);
      final state = await p2.read(openSessionsControllerProvider.future);
      expect(state.isEmpty, isTrue);
    });
  });

  group('PV1 lossless multi-window working set', () {
    late AppDatabase database;
    late DriftOpenSessionsStore losslessStore;

    ProviderContainer buildWindow(BrokerProfile profile) {
      return ProviderContainer(
        overrides: [
          openSessionsStoreProvider.overrideWithValue(losslessStore),
          activeBrokerProfileProvider.overrideWith((ref) => profile),
        ],
      );
    }

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      losslessStore = DriftOpenSessionsStore(database);
    });

    tearDown(() => database.close());

    test(
      'migrates a legacy snapshot once without resurrecting closed tabs',
      () async {
        final profile = _profile('legacy');
        await losslessStore.save(
          profile.id,
          OpenSessionsSnapshot(
            refs: [_ref('claude', 'a'), _ref('codex', 'b')],
            activeKey: 'codex/b',
          ),
        );

        final first = buildWindow(profile);
        final migrated = await first.read(
          openSessionsControllerProvider.future,
        );
        expect(migrated.refs.map((ref) => ref.key), ['claude/a', 'codex/b']);
        expect(migrated.activeKey, 'codex/b');
        final firstOpen = first.read(openSessionsControllerProvider.notifier);
        await firstOpen.close('claude/a');
        await firstOpen.close('codex/b');
        await Future<void>.delayed(const Duration(milliseconds: 30));
        first.dispose();

        final restarted = buildWindow(profile);
        addTearDown(restarted.dispose);
        expect(
          (await restarted.read(openSessionsControllerProvider.future)).refs,
          isEmpty,
        );
      },
    );

    test(
      'a legacy snapshot is consumed by only one endpoint incarnation',
      () async {
        final firstProfile = _profile('legacy-shared');
        final secondProfile = BrokerProfile(
          id: firstProfile.id,
          displayName: firstProfile.displayName,
          baseUri: Uri.parse('http://127.0.0.1:8834'),
          createdAt: DateTime(2026),
        );
        await losslessStore.save(
          firstProfile.id,
          OpenSessionsSnapshot(
            refs: [_ref('claude', 'from-first-endpoint')],
            activeKey: 'claude/from-first-endpoint',
          ),
        );

        final firstSource = RosterSource.ofProfile(firstProfile).storageKey;
        final secondSource = RosterSource.ofProfile(secondProfile).storageKey;
        final migrated = await losslessStore.loadLossless(
          firstSource,
          legacyProfileId: firstProfile.id,
        );
        final laterIncarnation = await losslessStore.loadLossless(
          secondSource,
          legacyProfileId: secondProfile.id,
        );

        expect(migrated.refs.single.id, 'from-first-endpoint');
        expect(laterIncarnation.refs, isEmpty);
        expect(
          (await losslessStore.load(firstProfile.id)).refs,
          isEmpty,
          reason: 'the ambiguous bare-profile row is consumed atomically',
        );
      },
    );

    test('close-others intent cannot delete a later unseen open', () async {
      final sourceKey = RosterSource.ofProfile(
        _profile('shared'),
      ).storageKey;
      await losslessStore.openMember(sourceKey, _ref('claude', 'a'));
      await losslessStore.openMember(sourceKey, _ref('codex', 'b'));

      // The intent formed while only a and b were visible.
      const keysVisibleToIntent = ['codex/b'];
      await losslessStore.openMember(sourceKey, _ref('pi', 'c'));
      await losslessStore.closeOtherMembers(
        sourceKey,
        keysVisibleToIntent,
      );

      expect(
        (await losslessStore.loadLossless(
          sourceKey,
        )).refs.map((ref) => ref.key),
        ['claude/a', 'pi/c'],
      );
    });

    test(
      'interleaved windows merge membership and keep activation local',
      () async {
        final profile = _profile('shared');
        final first = buildWindow(profile);
        final second = buildWindow(profile);
        addTearDown(first.dispose);
        addTearDown(second.dispose);
        await Future.wait([
          first.read(openSessionsControllerProvider.future),
          second.read(openSessionsControllerProvider.future),
        ]);

        first
            .read(openSessionsControllerProvider.notifier)
            .open(_ref('claude', 'a'));
        second
            .read(openSessionsControllerProvider.notifier)
            .open(_ref('codex', 'b'));
        await Future<void>.delayed(const Duration(milliseconds: 40));

        expect(
          first
              .read(openSessionsControllerProvider)
              .value!
              .refs
              .map((ref) => ref.key),
          ['claude/a', 'codex/b'],
        );
        expect(
          second
              .read(openSessionsControllerProvider)
              .value!
              .refs
              .map((ref) => ref.key),
          ['claude/a', 'codex/b'],
        );

        second
            .read(openSessionsControllerProvider.notifier)
            .activate('claude/a');
        first.read(openSessionsControllerProvider.notifier).activate('codex/b');
        await Future<void>.delayed(const Duration(milliseconds: 20));

        expect(
          first.read(openSessionsControllerProvider).value!.activeKey,
          'codex/b',
        );
        expect(
          second.read(openSessionsControllerProvider).value!.activeKey,
          'claude/a',
          reason: 'the restart hint must not act as live navigation authority',
        );
      },
    );

    test('close and reorder do not discard a concurrent open', () async {
      final profile = _profile('shared');
      final first = buildWindow(profile);
      final second = buildWindow(profile);
      addTearDown(first.dispose);
      addTearDown(second.dispose);
      await Future.wait([
        first.read(openSessionsControllerProvider.future),
        second.read(openSessionsControllerProvider.future),
      ]);
      final firstController = first.read(
        openSessionsControllerProvider.notifier,
      );
      // A delay deliberately separates the two operation bursts.
      // ignore: cascade_invocations
      firstController
        ..open(_ref('claude', 'a'))
        ..open(_ref('codex', 'b'));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      await firstController.close('claude/a');
      // `close` is awaited (it may barrier a draft), so the reorder cannot be
      // a cascade section of it.
      // ignore: cascade_invocations
      firstController.reorder(0, 1);
      second
          .read(openSessionsControllerProvider.notifier)
          .open(_ref('pi', 'c'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final keys = await losslessStore
          .loadLossless(
            RosterSource.ofProfile(profile).storageKey,
          )
          .then((snapshot) => snapshot.refs.map((ref) => ref.key).toSet());
      expect(keys, {'codex/b', 'pi/c'});
    });

    test(
      'same profile id at another endpoint has a separate working set',
      () async {
        final firstProfile = _profile('shared');
        final secondProfile = BrokerProfile(
          id: 'shared',
          displayName: 'shared',
          baseUri: Uri.parse('http://127.0.0.1:8834'),
          createdAt: DateTime(2026),
        );
        await losslessStore.openMember(
          RosterSource.ofProfile(firstProfile).storageKey,
          _ref('claude', 'a'),
        );

        expect(
          (await losslessStore.loadLossless(
            RosterSource.ofProfile(secondProfile).storageKey,
          )).refs,
          isEmpty,
        );
      },
    );
  });
}

class _FakeOpenSessionsStore implements OpenSessionsStore {
  final Map<String, OpenSessionsSnapshot> saved =
      <String, OpenSessionsSnapshot>{};

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async =>
      saved[profileId] ?? OpenSessionsSnapshot.empty;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {
    saved[profileId] = snapshot;
  }
}
