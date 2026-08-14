import 'dart:async';
import 'dart:ui' as ui;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/app/app.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_remote_wake_runtime.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_badge_seen_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/view/foreground_attention_host.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_repository.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/update/web_client_update.dart';
import 'package:cosyncing_client/src/platform/update/web_client_update_provider.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// In-memory [UiPreferencesStore] so pumping [App] does not open a real Drift
/// database (which would leave a pending timer in widget tests).
class _InMemoryUiPreferencesStore implements UiPreferencesStore {
  _InMemoryUiPreferencesStore({
    String? localeTag,
    UiDensity? density,
    String? themeMode,
  }) {
    if (localeTag != null) _values['locale'] = localeTag;
    if (density != null) _values['density'] = density.token;
    if (themeMode != null) _values['mode'] = themeMode;
  }

  final Map<String, String> _values = <String, String>{};

  @override
  Future<String?> getThemeId() async => _values['theme'];

  @override
  Future<void> setThemeId(String themeId) async {
    _values['theme'] = themeId;
  }

  @override
  Future<String?> getThemeMode() async => _values['mode'];

  @override
  Future<void> setThemeMode(String mode) async {
    _values['mode'] = mode;
  }

  @override
  Future<String?> getLocaleTag() async => _values['locale'];

  @override
  Future<void> setLocaleTag(String tag) async {
    _values['locale'] = tag;
  }

  @override
  Future<String?> getTextScale() async => _values['textScale'];

  @override
  Future<void> setTextScale(String token) async {
    _values['textScale'] = token;
  }

  @override
  Future<String?> getDensity() async => _values['density'];

  @override
  Future<void> setDensity(String token) async {
    _values['density'] = token;
  }

  @override
  Future<bool?> getShowDebugViews() async {
    final value = _values['showDebugViews'];
    return value == null ? null : value == 'true';
  }

  @override
  Future<void> setShowDebugViews({required bool value}) async {
    _values['showDebugViews'] = value.toString();
  }
}

class _InMemoryAttentionBadgeSeenStore implements AttentionBadgeSeenStore {
  @override
  Future<int> loadSeenThroughCursor(String brokerProfileId) async => 0;

  @override
  Future<int> loadUnseenCount(String brokerProfileId) async => 0;

  @override
  Future<bool> markSeenThroughCursor(String brokerProfileId, int cursor) async {
    return false;
  }
}

void main() {
  ProviderContainer buildContainer({
    String? initialNotificationTapPayload,
    Future<void> Function(Ref ref)? notificationLaunchBootstrap,
    AttentionRepository? attentionRepository,
    String? localeTag,
    UiDensity? density,
    String? themeMode,
    AppDatabase? database,
    WebClientUpdateState webUpdate = const WebClientUpdateState(
      updateReady: false,
      handoffFailed: false,
    ),
    Stream<WebClientUpdateState>? webUpdates,
  }) {
    final profile = _attentionProfile();
    final container = ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWith((ref) {
          final resolved = database ?? AppDatabase(NativeDatabase.memory());
          if (database == null) {
            ref.onDispose(resolved.close);
          }
          return resolved;
        }),
        brokerProfileRepositoryProvider.overrideWithValue(
          _SingleBrokerProfileRepository(profile),
        ),
        activeBrokerProfileStoreProvider.overrideWithValue(
          _MemoryActiveBrokerProfileStore(),
        ),
        brokerGateControllerProvider.overrideWith(
          _ConnectedBrokerGateController.new,
        ),
        brokerClientProvider.overrideWith((_) async => null),
        sessionListRepositoryProvider.overrideWith(
          (_) async => InMemorySessionListRepository(),
        ),
        activeBrokerProfileHydrationProvider.overrideWith((_) async {}),
        sessionRosterWindowProvider.overrideWith(_FixedRosterWindow.new),
        attentionFeedRuntimeProvider.overrideWith((_) {}),
        attentionRemoteWakeRuntimeProvider.overrideWith((_) {}),
        attentionMutationDrainRuntimeProvider.overrideWith((_) {}),
        sessionNotificationLaunchBootstrapProvider.overrideWith(
          notificationLaunchBootstrap ?? (_) async {},
        ),
        attentionInboxProvider.overrideWith(
          (_) async => AttentionInboxSections.fromEntries(const []),
        ),
        attentionUnseenBadgeCountProvider.overrideWith((_) async => 0),
        attentionBadgeSeenStoreProvider.overrideWithValue(
          _InMemoryAttentionBadgeSeenStore(),
        ),
        attentionRepositoryProvider.overrideWithValue(
          attentionRepository ?? _RecordingAttentionRepository(),
        ),
        uiPreferencesStoreProvider.overrideWithValue(
          _InMemoryUiPreferencesStore(
            localeTag: localeTag,
            density: density,
            themeMode: themeMode,
          ),
        ),
        webClientUpdateProvider.overrideWith(
          (_) => webUpdates ?? Stream.value(webUpdate),
        ),
      ],
    );

    if (initialNotificationTapPayload != null) {
      container.read(sessionNotificationTapPayloadProvider.notifier).state =
          initialNotificationTapPayload;
    }

    return container;
  }

  Widget buildApp({ProviderContainer? container}) {
    final appContainer = container ?? buildContainer();
    return UncontrolledProviderScope(
      container: appContainer,
      child: const App(),
    );
  }

  group('App', () {
    setUp(() => goRouter.go('/sessions'));

    testWidgets('renders MaterialApp.router', (tester) async {
      await tester.pumpWidget(buildApp());
      expect(find.byType(App), findsOneWidget);
    });

    testWidgets('uses adaptive platform density', (tester) async {
      await tester.pumpWidget(buildApp());

      final materialApp = tester.widget<MaterialApp>(find.byType(MaterialApp));
      expect(
        materialApp.theme?.visualDensity,
        VisualDensity.adaptivePlatformDensity,
      );
    });

    testWidgets(
      'repeated handoff failure is one localized selectable app-level notice',
      (tester) async {
        tester.view
          ..physicalSize = const Size(360, 640)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        for (final localeAndMessage in const [
          (
            'en',
            'Cosyncing couldn’t switch to the new version automatically. '
                'Close the other Cosyncing tabs to finish updating.',
            'light',
            UiDensity.compact,
          ),
          (
            'zh',
            'Cosyncing 无法自动切换到新版本。请关闭其他 Cosyncing 标签页以完成更新。',
            'dark',
            UiDensity.spacious,
          ),
        ]) {
          final container = buildContainer(
            localeTag: localeAndMessage.$1,
            themeMode: localeAndMessage.$3,
            density: localeAndMessage.$4,
            webUpdate: const WebClientUpdateState(
              updateReady: true,
              handoffFailed: true,
            ),
          );
          await tester.pumpWidget(buildApp(container: container));
          await tester.pumpAndSettle();

          final banner = find.byKey(
            const Key('web-client-update-handoff-failed'),
          );
          expect(banner, findsOneWidget);
          expect(
            find.descendant(
              of: banner,
              matching: find.byType(SelectionArea),
            ),
            findsOneWidget,
          );
          expect(find.text(localeAndMessage.$2), findsOneWidget);
          expect(
            find.byKey(const Key('web-client-update-reload')),
            findsNothing,
          );
          expect(tester.takeException(), isNull);

          await tester.pumpWidget(const SizedBox.shrink());
          container.dispose();
        }
      },
    );

    testWidgets('web update stays hidden without a waiting build', (
      tester,
    ) async {
      final container = buildContainer();
      await tester.pumpWidget(buildApp(container: container));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('web-client-update-handoff-failed')),
        findsNothing,
      );
      container.dispose();
    });

    // N3b's whole point: the routine case is invisible. A verified replacement
    // is waiting and the page is moving this tab through the handoff by itself,
    // so there is nothing for the user to read, dismiss, or act on.
    testWidgets('a waiting build alone shows no update surface', (
      tester,
    ) async {
      final container = buildContainer(
        webUpdate: const WebClientUpdateState(
          updateReady: true,
          handoffFailed: false,
        ),
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(buildApp(container: container));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('web-client-update-handoff-failed')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('web update state does not remount the router subtree', (
      tester,
    ) async {
      final updates = StreamController<WebClientUpdateState>();
      addTearDown(updates.close);
      final container = buildContainer(webUpdates: updates.stream);
      addTearDown(container.dispose);
      await tester.pumpWidget(buildApp(container: container));
      updates.add(
        const WebClientUpdateState(updateReady: false, handoffFailed: false),
      );
      await tester.pumpAndSettle();
      final navigatorBefore = tester.state<NavigatorState>(
        find.byType(Navigator).first,
      );

      updates.add(
        const WebClientUpdateState(updateReady: true, handoffFailed: true),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('web-client-update-handoff-failed')),
        findsOneWidget,
      );
      expect(
        tester.state<NavigatorState>(find.byType(Navigator).first),
        same(navigatorBefore),
      );
    });

    testWidgets('warm notification tap opens the exact session in one action', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(390, 844)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final database = AppDatabase(NativeDatabase.memory());
      final container = buildContainer(database: database);
      addTearDown(database.close);
      addTearDown(container.dispose);
      await tester.pumpWidget(buildApp(container: container));

      container.read(sessionNotificationTapPayloadProvider.notifier).state =
          _openSessionPayload('warm-session');
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(
        goRouter.routeInformationProvider.value.uri.path,
        '/sessions/codex/warm-session',
      );
      expect(
        find.byType(SessionDetailPage, skipOffstage: false),
        findsOneWidget,
      );
      expect(
        container.read(sessionNotificationTapPayloadProvider),
        isNull,
      );
      goRouter.go('/sessions');
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    });

    testWidgets(
      'cold notification launch opens the exact session in one action',
      (
        tester,
      ) async {
        tester.view
          ..physicalSize = const Size(390, 844)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final database = AppDatabase(NativeDatabase.memory());
        final container = buildContainer(
          database: database,
          notificationLaunchBootstrap: (ref) async {
            ref.read(sessionNotificationTapHandlerProvider)(
              _openSessionPayload('cold-session'),
            );
          },
        );
        addTearDown(database.close);
        addTearDown(container.dispose);

        await tester.pumpWidget(buildApp(container: container));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));

        expect(
          goRouter.routeInformationProvider.value.uri.path,
          '/sessions/codex/cold-session',
        );
        expect(
          find.byType(SessionDetailPage, skipOffstage: false),
          findsOneWidget,
        );
        expect(container.read(sessionNotificationTapPayloadProvider), isNull);
        goRouter.go('/sessions');
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      },
    );

    testWidgets('foreground banner localizes an untitled session', (
      tester,
    ) async {
      for (final localeAndTitle in const [
        ('en', 'Codex: Untitled session needs input'),
        ('zh', 'Codex: 未命名会话 需要输入'),
      ]) {
        final container = buildContainer(localeTag: localeAndTitle.$1);
        await tester.pumpWidget(buildApp(container: container));
        await tester.pumpAndSettle();

        container.read(foregroundAttentionEventProvider.notifier).state =
            _attentionEntry('blank-${localeAndTitle.$1}', title: '   ');
        await tester.pump(foregroundAttentionCoalesceWindow);

        expect(find.text(localeAndTitle.$2), findsOneWidget);
        await tester.pumpWidget(const SizedBox.shrink());
        container.dispose();
      }
    });

    testWidgets(
      'foreground Open reaches exact session without inbox mutation',
      (
        tester,
      ) async {
        tester.view
          ..physicalSize = const Size(390, 844)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final database = AppDatabase(NativeDatabase.memory());
        final repository = _RecordingAttentionRepository();
        final container = buildContainer(
          attentionRepository: repository,
          database: database,
        );
        addTearDown(database.close);
        addTearDown(container.dispose);
        final entry = _attentionEntry('open', title: 'Permission needed');
        await tester.pumpWidget(buildApp(container: container));
        await tester.pumpAndSettle();

        container.read(foregroundAttentionEventProvider.notifier).state = entry;
        await tester.pump(foregroundAttentionCoalesceWindow);
        await tester.tap(
          find.byKey(const Key('foreground-attention-open')),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));

        expect(find.byType(SessionDetailPage), findsOneWidget);
        expect(
          goRouter.routeInformationProvider.value.uri.path,
          '/sessions/codex/session-open',
        );
        expect(repository.markReadCallCount, 0);
        expect(repository.markDismissedCallCount, 0);
        expect(entry.event.readAt, isNull);
        expect(entry.event.dismissedAt, isNull);
        goRouter.go('/sessions');
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      },
    );

    testWidgets('foreground Close hides without navigation or inbox mutation', (
      tester,
    ) async {
      final repository = _RecordingAttentionRepository();
      final container = buildContainer(attentionRepository: repository);
      final entry = _attentionEntry('close', title: 'Question waiting');
      await tester.pumpWidget(buildApp(container: container));
      await tester.pumpAndSettle();

      container.read(foregroundAttentionEventProvider.notifier).state = entry;
      await tester.pump(foregroundAttentionCoalesceWindow);
      await tester.tap(
        find.byKey(const Key('foreground-attention-close-button')),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsNothing,
      );
      expect(goRouter.routeInformationProvider.value.uri.path, '/sessions');
      expect(repository.markReadCallCount, 0);
      expect(repository.markDismissedCallCount, 0);
      expect(container.read(attentionInboxRevisionProvider), 0);
      expect(entry.event.readAt, isNull);
      expect(entry.event.dismissedAt, isNull);
    });

    testWidgets('new foreground event updates the one aggregate', (
      tester,
    ) async {
      final repository = _RecordingAttentionRepository();
      final container = buildContainer(attentionRepository: repository);
      await tester.pumpWidget(buildApp(container: container));
      await tester.pumpAndSettle();

      container.read(foregroundAttentionEventProvider.notifier).state =
          _attentionEntry('older', title: 'Older event');
      await tester.pump(foregroundAttentionCoalesceWindow);

      container.read(foregroundAttentionEventProvider.notifier).state =
          _attentionEntry('newer', title: 'Newer event');
      await tester.pump(foregroundAttentionCoalesceWindow);
      expect(
        find.byKey(const Key('foreground-attention-banner')),
        findsOneWidget,
      );
      expect(find.text('2 new notifications'), findsOneWidget);
      expect(find.text('2 need input'), findsOneWidget);
      expect(repository.markReadCallCount, 0);
      expect(repository.markDismissedCallCount, 0);
    });

    testWidgets('Close exposes localized label and button semantics', (
      tester,
    ) async {
      final container = buildContainer();
      await tester.pumpWidget(buildApp(container: container));
      await tester.pumpAndSettle();

      container.read(foregroundAttentionEventProvider.notifier).state =
          _attentionEntry('semantics', title: 'Action required');
      await tester.pump(foregroundAttentionCoalesceWindow);

      expect(find.text('Close'), findsOneWidget);
      final closeSemantics = tester
          .getSemantics(
            find.byKey(const Key('foreground-attention-close')),
          )
          .getSemanticsData();
      expect(closeSemantics.label, contains('Close this notification'));
      expect(
        closeSemantics.hasAction(ui.SemanticsAction.tap),
        isTrue,
      );
    });

    testWidgets('Compact and Roomy Close targets fit without overflow', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(360, 640)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      for (final density in [UiDensity.compact, UiDensity.spacious]) {
        final container = buildContainer(density: density);
        await tester.pumpWidget(buildApp(container: container));
        await tester.pumpAndSettle();
        container
            .read(foregroundAttentionEventProvider.notifier)
            .state = _attentionEntry(
          density.name,
          title: 'A long foreground notification title that must fit safely',
        );
        await tester.pump(foregroundAttentionCoalesceWindow);

        final size = tester.getSize(
          find.byKey(const Key('foreground-attention-close-button')),
        );
        expect(size.width, greaterThanOrEqualTo(40));
        expect(size.height, greaterThanOrEqualTo(40));
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox.shrink());
        container.dispose();
      }
    });
  });
}

class _FixedRosterWindow extends SessionRosterWindowController {
  @override
  Future<SessionRosterQueryWindow> build() async =>
      SessionRosterQueryWindow.last7Days;
}

AttentionInboxEntry _attentionEntry(String id, {required String title}) {
  return AttentionInboxEntry(
    profile: _attentionProfile(),
    event: AttentionEventView(
      id: id,
      cursor: 1,
      revision: 1,
      presentationRevision: 1,
      kind: 'question-required',
      state: 'active',
      severity: 'action-required',
      dedupeKey: id,
      createdAt: DateTime(2026).millisecondsSinceEpoch,
      updatedAt: DateTime(2026).millisecondsSinceEpoch,
      agent: 'codex',
      sessionId: 'session-$id',
      title: title,
      action: AttentionEventAction(
        kind: 'open-session',
        tool: 'codex',
        sessionId: 'session-$id',
      ),
    ),
  );
}

BrokerProfile _attentionProfile() => BrokerProfile(
  id: 'profile',
  incarnationId: 'incarnation-1',
  displayName: 'Test workstation',
  baseUri: Uri.parse('http://127.0.0.1:7734'),
  createdAt: DateTime(2026),
);

String _openSessionPayload(String sessionId) {
  final profile = _attentionProfile();
  return '{"kind":"attention-event",'
      '"eventId":"event-$sessionId",'
      '"brokerProfileId":"${profile.id}",'
      '"brokerScopeKey":"${RosterSource.ofProfile(profile).storageKey}",'
      '"actionKind":"open-session",'
      '"tool":"codex",'
      '"sessionId":"$sessionId"}';
}

final class _SingleBrokerProfileRepository implements BrokerProfileRepository {
  _SingleBrokerProfileRepository(this.profile);

  final BrokerProfile profile;

  @override
  Future<List<BrokerProfile>> getAll() async => [profile];

  @override
  Future<BrokerProfile?> getById(String id) async =>
      id == profile.id ? profile : null;

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async => profile;

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async => false;
}

final class _MemoryActiveBrokerProfileStore
    implements ActiveBrokerProfileStore {
  String? activeId;

  @override
  Future<void> clearActiveProfileId() async => activeId = null;

  @override
  Future<String?> getActiveProfileId() async => activeId;

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    activeId = profileId;
  }
}

final class _ConnectedBrokerGateController extends BrokerGateController {
  @override
  Future<BrokerGateState> build() async => const BrokerGateState.connected();
}

class _RecordingAttentionRepository implements AttentionRepository {
  int markReadCallCount = 0;
  int markDismissedCallCount = 0;

  @override
  Future<bool> advancePresentedRevision({
    required String brokerProfileId,
    required String eventId,
    required int presentedRevision,
  }) async => false;

  @override
  Future<List<AttentionDeliveryState>> loadDeliveryStates(
    String brokerProfileId,
  ) async => const [];

  @override
  Future<List<AttentionEventView>> loadEvents(String brokerProfileId) async =>
      const [];

  @override
  Future<List<AttentionDeliveryState>> loadPendingMutations(
    String brokerProfileId,
  ) async => const [];

  @override
  Future<List<AttentionDeliveryState>> loadPendingPresentations(
    String brokerProfileId,
  ) async => const [];

  @override
  Future<int> loadCursor(String brokerProfileId) async => 0;

  @override
  Future<int> loadUnreadCount(String brokerProfileId) async => 0;

  @override
  Future<List<AttentionEventSnapshot>> markSnapshotDismissed(
    List<AttentionEventSnapshot> snapshot, {
    DateTime? dismissedAt,
  }) async => snapshot;

  @override
  Future<int> reconcileBulkDismissResult({
    required String brokerProfileId,
    required AttentionBulkDismissResponse result,
  }) async => 0;

  @override
  Future<void> markDismissed(
    String brokerProfileId,
    String eventId, {
    DateTime? dismissedAt,
  }) async {
    markDismissedCallCount++;
  }

  @override
  Future<bool> markBrokerDismissedSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerDismissedAt,
  }) async => false;

  @override
  Future<bool> markBrokerReadSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerReadAt,
  }) async => false;

  @override
  Future<void> markRead(
    String brokerProfileId,
    String eventId, {
    DateTime? readAt,
  }) async {
    markReadCallCount++;
  }

  @override
  Future<void> persistAttentionEventsPage({
    required String brokerProfileId,
    required AttentionEventsPage page,
  }) async {}
}
