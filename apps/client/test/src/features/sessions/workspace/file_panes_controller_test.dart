import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _session = SessionDetailKey(tool: 'claude', sessionId: 'a');

BrokerProfile _profile(String id) => BrokerProfile(
  id: id,
  displayName: id,
  baseUri: Uri.parse('http://127.0.0.1:7734'),
  createdAt: DateTime(2026),
);

/// Flushes fire-and-forget persistence microtasks.
Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  late _FakeFilePanesStore store;
  late StateProvider<BrokerProfile?> slot;

  /// A container whose active profile arrives after the first build — what a
  /// cold start does, since the URL is resolved before the profile is loaded.
  ProviderContainer buildContainer({BrokerProfile? profile}) {
    slot = StateProvider<BrokerProfile?>((_) => profile);
    return ProviderContainer(
      overrides: [
        filePanesStoreProvider.overrideWithValue(store),
        activeBrokerProfileProvider.overrideWith((ref) => ref.watch(slot)),
      ],
    );
  }

  setUp(() => store = _FakeFilePanesStore());

  group('FilePanesController', () {
    test('opens and activates against a live source', () async {
      final container = buildContainer(profile: _profile('p1'));
      addTearDown(container.dispose);
      await container.read(filePanesControllerProvider.future);

      await container
          .read(filePanesControllerProvider.notifier)
          .open(_session, 'lib/one.dart');
      await _settle();

      final state = container.read(filePanesControllerProvider).requireValue;
      expect(state.forSession(_session).map((pane) => pane.path), [
        'lib/one.dart',
      ]);
      expect(store.saved?.panes, hasLength(1));
    });

    test('a file opened before the profile arrives survives it', () async {
      final container = buildContainer();
      addTearDown(container.dispose);
      await container.read(filePanesControllerProvider.future);

      await container
          .read(filePanesControllerProvider.notifier)
          .open(_session, 'lib/one.dart');
      container.read(slot.notifier).state = _profile('p1');
      final state = await container.read(filePanesControllerProvider.future);
      await _settle();

      // Otherwise a bookmarked `?path=` link opens the session and no file:
      // the mutation is refused outright against a sourceless build.
      expect(state.forSession(_session).map((pane) => pane.path), [
        'lib/one.dart',
      ]);
      expect(state.activeFor(_session)?.path, 'lib/one.dart');
    });

    test('and is persisted, not merely shown', () async {
      final container = buildContainer();
      addTearDown(container.dispose);
      await container.read(filePanesControllerProvider.future);
      await container
          .read(filePanesControllerProvider.notifier)
          .open(_session, 'lib/one.dart');
      container.read(slot.notifier).state = _profile('p1');
      await container.read(filePanesControllerProvider.future);
      await _settle();

      expect(store.saved?.panes.map((pane) => pane.path), ['lib/one.dart']);
    });

    test('a profile that never arrives opens nothing', () async {
      final container = buildContainer();
      addTearDown(container.dispose);
      await container.read(filePanesControllerProvider.future);

      await container
          .read(filePanesControllerProvider.notifier)
          .open(_session, 'lib/one.dart');
      await _settle();

      // Held, not applied: there is no working set to add to, and no broker to
      // read the file from either.
      final state = container.read(filePanesControllerProvider).requireValue;
      expect(state.panes, isEmpty);
      expect(store.saved, isNull);
    });

    test('replaying keeps a restored set and adds to it', () async {
      store.stored = FilePanesState.empty.opened(_session, 'lib/kept.dart');
      final container = buildContainer();
      addTearDown(container.dispose);
      await container.read(filePanesControllerProvider.future);

      await container
          .read(filePanesControllerProvider.notifier)
          .open(_session, 'lib/deep-linked.dart');
      container.read(slot.notifier).state = _profile('p1');
      final state = await container.read(filePanesControllerProvider.future);
      await _settle();

      // The deep link is an addition to the working set, never a replacement
      // of it: the tabs the reader left open are still theirs.
      expect(state.forSession(_session).map((pane) => pane.path), [
        'lib/kept.dart',
        'lib/deep-linked.dart',
      ]);
      expect(state.activeFor(_session)?.path, 'lib/deep-linked.dart');
    });
  });
}

class _FakeFilePanesStore implements FilePanesStore {
  /// What a restore returns.
  FilePanesState stored = FilePanesState.empty;

  /// The last state written, or null if nothing ever was.
  FilePanesState? saved;

  @override
  Future<FilePanesState> load(String sourceKey) async => stored;

  @override
  Future<void> save(String sourceKey, FilePanesState state) async {
    saved = state;
    stored = state;
  }
}
