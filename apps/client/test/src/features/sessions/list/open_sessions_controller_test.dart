import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_reveal_request.dart';
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

    test('explicit opens request reveal, metadata refresh does not', () async {
      final profile = _profile('p1');
      final container = buildContainer(profile: profile);
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      final controller = container.read(
        openSessionsControllerProvider.notifier,
      );
      expect(container.read(sessionRosterRevealRequestProvider), isNull);
      controller.open(_ref('codex', 'child'));
      final first = container.read(sessionRosterRevealRequestProvider)!;
      expect(first.sourceKey, RosterSource.ofProfile(profile).storageKey);
      expect(first.sessionKey, 'codex/child');
      controller.refreshMetadata(const [
        SessionInfo(
          id: 'child',
          tool: 'codex',
          title: 'Updated title',
          status: SessionStatus.working,
          attachMode: AttachMode.observe,
        ),
      ]);
      expect(container.read(sessionRosterRevealRequestProvider), same(first));
      controller.open(_ref('codex', 'child'));
      final second = container.read(sessionRosterRevealRequestProvider)!;
      expect(second, isNot(same(first)));
      expect(second.sourceKey, first.sourceKey);
      expect(second.sessionKey, first.sessionKey);
    });

    test(
      'reveal requests are cleared when the broker source changes',
      () async {
        final profile = StateProvider<BrokerProfile?>((_) => _profile('p1'));
        final container = ProviderContainer(
          overrides: [
            openSessionsStoreProvider.overrideWithValue(store),
            activeBrokerProfileProvider.overrideWith(
              (ref) => ref.watch(profile),
            ),
          ],
        );
        addTearDown(container.dispose);
        await container.read(openSessionsControllerProvider.future);
        container
            .read(openSessionsControllerProvider.notifier)
            .open(_ref('codex', 'child'));
        final first = container.read(sessionRosterRevealRequestProvider)!;
        container.read(profile.notifier).state = _profile('p2');
        expect(container.read(sessionRosterRevealRequestProvider), isNull);
        await container.read(openSessionsControllerProvider.future);
        container
            .read(openSessionsControllerProvider.notifier)
            .open(_ref('codex', 'child'));
        final second = container.read(sessionRosterRevealRequestProvider)!;
        expect(second.sourceKey, isNot(first.sourceKey));
        expect(second.sessionKey, first.sessionKey);
      },
    );

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

    test('undo refuses a different broker source', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      container
          .read(openSessionsControllerProvider.notifier)
          .restoreClosedTabs(
            ClosedSessionTabs(
              'other-source',
              OpenSessionsState(
                refs: [_ref('claude', 'a')],
                activeKey: 'claude/a',
              ),
            ),
          );
      expect(
        container.read(openSessionsControllerProvider).value!.refs,
        isEmpty,
      );
    });
  });

  group('OpenSessionsController membership emissions', () {
    late _WatchedOpenSessionsStore watched;
    late StateProvider<BrokerProfile?> slot;

    ProviderContainer buildContainer({BrokerProfile? profile}) {
      slot = StateProvider<BrokerProfile?>((_) => profile);
      return ProviderContainer(
        overrides: [
          openSessionsStoreProvider.overrideWithValue(watched),
          activeBrokerProfileProvider.overrideWith((ref) => ref.watch(slot)),
        ],
      );
    }

    setUp(() => watched = _WatchedOpenSessionsStore());
    tearDown(() => watched.dispose());

    test('a stale emission does not strip the active tab', () async {
      final container = buildContainer();
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      container
          .read(openSessionsControllerProvider.notifier)
          .open(_ref('claude', 'a'));
      container.read(slot.notifier).state = _profile('p1');
      await container.read(openSessionsControllerProvider.future);

      // The watch's first emission predates the member the replay just wrote,
      // and the second catches up. Neither reports which tab is active.
      watched.emit(const []);
      await _settle();
      watched.emit([_ref('claude', 'a')]);
      await _settle();

      final state = container.read(openSessionsControllerProvider).requireValue;
      expect(state.refs.map((ref) => ref.key), ['claude/a']);
      // Null here is what put a tab in the strip beside "select a session".
      expect(state.activeKey, 'claude/a');
    });

    test('a late emission restores the deep link, not the first tab', () async {
      watched.stored = OpenSessionsSnapshot(
        refs: [_ref('claude', 'restored')],
        activeKey: 'claude/restored',
      );
      final container = buildContainer();
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);
      container
          .read(openSessionsControllerProvider.notifier)
          .open(_ref('codex', 'linked'));
      container.read(slot.notifier).state = _profile('p1');
      await container.read(openSessionsControllerProvider.future);

      watched.emit([_ref('claude', 'restored')]);
      await _settle();
      watched.emit([_ref('claude', 'restored'), _ref('codex', 'linked')]);
      await _settle();

      final state = container.read(openSessionsControllerProvider).requireValue;
      // The reader asked for the deep-linked session, not whichever tab
      // happens to sit leftmost in a set they restored days ago.
      expect(state.activeKey, 'codex/linked');
    });

    test('an emission that drops the active tab falls back', () async {
      watched.stored = OpenSessionsSnapshot(
        refs: [_ref('claude', 'a'), _ref('codex', 'b')],
        activeKey: 'codex/b',
      );
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(openSessionsControllerProvider.future);

      // Another window closed the active tab.
      watched.emit([_ref('claude', 'a')]);
      await _settle();

      final state = container.read(openSessionsControllerProvider).requireValue;
      expect(state.activeKey, 'claude/a');
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

/// A lossless store whose membership stream is driven by the test.
///
/// The Drift store's own emissions are correct but unschedulable; the race
/// this covers is entirely about their ORDER relative to a write.
class _WatchedOpenSessionsStore implements LosslessOpenSessionsStore {
  final StreamController<List<SessionRef>> _membership =
      StreamController<List<SessionRef>>.broadcast();

  /// What a restore returns.
  OpenSessionsSnapshot stored = OpenSessionsSnapshot.empty;

  /// The members written through [openMember].
  final List<SessionRef> opened = [];

  /// The last active hint saved.
  String? activeHint;

  void emit(List<SessionRef> refs) => _membership.add(refs);

  void dispose() => unawaited(_membership.close());

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async => stored;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {
    stored = snapshot;
  }

  @override
  Future<OpenSessionsSnapshot> loadLossless(
    String sourceKey, {
    String? legacyProfileId,
  }) async => stored;

  @override
  Stream<List<SessionRef>> watchMembership(String sourceKey) =>
      _membership.stream;

  @override
  Future<void> openMember(String sourceKey, SessionRef entry) async {
    opened.add(entry);
  }

  @override
  Future<void> closeMember(String sourceKey, String sessionKey) async {}

  @override
  Future<void> closeOtherMembers(
    String sourceKey,
    List<String> sessionKeys,
  ) async {}

  @override
  Future<void> reorderMembers(
    String sourceKey,
    List<String> orderedKeys,
  ) async {}

  @override
  Future<void> refreshMemberMetadata(
    String sourceKey,
    List<SessionRef> entries,
  ) async {}

  @override
  Future<void> saveActiveHint(String sourceKey, String? sessionKey) async {
    activeHint = sessionKey;
  }
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
