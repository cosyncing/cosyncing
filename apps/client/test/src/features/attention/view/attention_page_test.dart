import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_badge_seen_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/view/attention_page.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('uses Notifications naming in English and Chinese', (
    tester,
  ) async {
    Future<void> pump(Locale locale) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            attentionInboxProvider.overrideWith(
              (_) async => AttentionInboxSections.fromEntries(const []),
            ),
            attentionBadgeSeenStoreProvider.overrideWithValue(
              _MemoryBadgeSeenStore(),
            ),
          ],
          child: _localizedApp(const AttentionPage(), locale: locale),
        ),
      );
      await tester.pumpAndSettle();
    }

    await pump(const Locale('en'));
    expect(find.widgetWithText(AppBar, 'Notifications'), findsOneWidget);
    expect(find.text('Attention'), findsNothing);

    await pump(const Locale('zh'));
    expect(find.widgetWithText(AppBar, '通知'), findsOneWidget);
  });

  testWidgets('empty and failure explanations remain selectable', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionInboxProvider.overrideWith(
            (_) async => AttentionInboxSections.fromEntries(const []),
          ),
          attentionBadgeSeenStoreProvider.overrideWithValue(
            _MemoryBadgeSeenStore(),
          ),
        ],
        child: _localizedApp(const AttentionPage()),
      ),
    );
    await tester.pumpAndSettle();

    final emptyBody = find.text(
      'Action requests, background run results, runtime updates, quota '
      'warnings, and server health notices appear here.',
    );
    expect(emptyBody, findsOneWidget);
    expect(
      find.ancestor(of: emptyBody, matching: find.byType(SelectionArea)),
      findsWidgets,
    );
  });

  testWidgets('S2 presentation evidence covers locale theme and density', (
    tester,
  ) async {
    tester.view
      ..physicalSize = const Size(720, 520)
      ..devicePixelRatio = 1;
    addTearDown(() {
      tester.view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    });
    final spec = themeSpecById(kDefaultThemeId);
    final cases =
        <
          ({
            String name,
            Locale locale,
            Brightness brightness,
            UiDensity density,
          })
        >[
          (
            name: 'notifications_light_compact_en',
            locale: const Locale('en'),
            brightness: Brightness.light,
            density: UiDensity.compact,
          ),
          (
            name: 'notifications_dark_compact_zh',
            locale: const Locale('zh'),
            brightness: Brightness.dark,
            density: UiDensity.compact,
          ),
          (
            name: 'notifications_light_roomy_zh',
            locale: const Locale('zh'),
            brightness: Brightness.light,
            density: UiDensity.spacious,
          ),
          (
            name: 'notifications_dark_roomy_en',
            locale: const Locale('en'),
            brightness: Brightness.dark,
            density: UiDensity.spacious,
          ),
        ];

    for (final evidence in cases) {
      final tokens = evidence.brightness == Brightness.dark
          ? spec.dark
          : spec.light;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            attentionInboxProvider.overrideWith(
              (_) async => AttentionInboxSections.fromEntries(const []),
            ),
            attentionBadgeSeenStoreProvider.overrideWithValue(
              _MemoryBadgeSeenStore(),
            ),
          ],
          child: MaterialApp(
            locale: evidence.locale,
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: buildAppTheme(
              tokens,
              evidence.brightness,
              density: evidence.density.visualDensity,
            ),
            home: const AttentionPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(AttentionPage),
        matchesGoldenFile('goldens/${evidence.name}.png'),
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    }
  });

  testWidgets('renders reviewed priority sections and unknown kinds', (
    tester,
  ) async {
    final sections = AttentionInboxSections.fromEntries([
      _entry('question', 'question-required', title: 'Permission needed'),
      _entry('runtime', 'runtime-update-ready', title: 'Codex update ready'),
      _entry('future', 'future-kind', title: 'Future broker notice'),
      _entry(
        'done',
        'run-finished',
        title: 'Long run finished',
        state: 'resolved',
      ),
    ]);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionInboxProvider.overrideWith((_) async => sections),
          attentionBadgeSeenStoreProvider.overrideWithValue(
            _MemoryBadgeSeenStore(),
          ),
        ],
        child: _localizedApp(const AttentionPage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Your input is needed'), findsOneWidget);
    expect(find.text('Unread completions'), findsOneWidget);
    expect(find.text('Permission needed'), findsOneWidget);
    expect(find.text('Future broker notice'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Recent activity · 2 unread'),
      300,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pumpAndSettle();
    expect(find.text('Recent activity · 2 unread'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('pending and activity filters stay independent at 320px', (
    tester,
  ) async {
    tester.view
      ..physicalSize = const Size(320, 568)
      ..devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final sections = AttentionInboxSections.fromEntries([
      _entry('request', 'question-required', title: 'Respond to a question'),
      _entry('finished', 'run-finished', title: 'Inspect the result'),
      _entry('other', 'future-kind', title: 'Another update'),
    ]);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionInboxProvider.overrideWith((_) async => sections),
          attentionBadgeSeenStoreProvider.overrideWithValue(
            _MemoryBadgeSeenStore(),
          ),
        ],
        child: _localizedApp(const AttentionPage()),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('attention-pending-filter')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Unread completions').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attention-event-request')), findsNothing);
    expect(find.byKey(const Key('attention-event-finished')), findsOneWidget);
    expect(find.byKey(const Key('attention-event-other')), findsOneWidget);
    await tester.tap(find.byKey(const Key('attention-jump-activity')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('attention-unread-filter')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attention-event-request')), findsNothing);
    expect(find.byKey(const Key('attention-event-finished')), findsOneWidget);
    expect(find.byKey(const Key('attention-event-other')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'populated inbox visual evidence at phone tablet and desktop widths',
    (tester) async {
      final font = FontLoader('Lato')
        ..addFont(rootBundle.load('assets/fonts/Lato-Regular.ttf'))
        ..addFont(rootBundle.load('assets/fonts/Lato-Semibold.ttf'))
        ..addFont(rootBundle.load('assets/fonts/Lato-Bold.ttf'));
      await font.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      for (final width in [320, 390, 820, 1440]) {
        for (final brightness in Brightness.values) {
          tester.view
            ..physicalSize = Size(width.toDouble(), 844)
            ..devicePixelRatio = 1;
          final spec = themeSpecById(kDefaultThemeId);
          final sections = AttentionInboxSections.fromEntries([
            _entry(
              'question',
              'question-required',
              title: 'Choose how session details open',
            ),
            _entry(
              'completion',
              'run-finished',
              title: 'Review the reconnect tests',
            ),
            _entry(
              'update',
              'runtime-update-ready',
              title: 'Agent runtime update available',
            ),
          ]);
          await tester.pumpWidget(
            ProviderScope(
              overrides: [
                attentionInboxProvider.overrideWith((_) async => sections),
                attentionBadgeSeenStoreProvider.overrideWithValue(
                  _MemoryBadgeSeenStore(),
                ),
              ],
              child: MaterialApp(
                localizationsDelegates: AppLocalizations.localizationsDelegates,
                supportedLocales: AppLocalizations.supportedLocales,
                theme: buildAppTheme(
                  brightness == Brightness.dark ? spec.dark : spec.light,
                  brightness,
                ),
                home: const AttentionPage(),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          await expectLater(
            find.byType(AttentionPage),
            matchesGoldenFile(
              'goldens/inbox_populated_${width}_${brightness.name}.png',
            ),
          );
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
        }
      }
    },
  );

  testWidgets('renders compact empty state without overflow', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionInboxProvider.overrideWith(
            (_) async => AttentionInboxSections.fromEntries(const []),
          ),
          attentionBadgeSeenStoreProvider.overrideWithValue(
            _MemoryBadgeSeenStore(),
          ),
        ],
        child: _localizedApp(const AttentionPage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Nothing needs your attention'), findsOneWidget);
    expect(find.byKey(const Key('attention-clear-all')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Clear activity preserves pending requests and uses exact revisions',
    (
      tester,
    ) async {
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final repository = DriftAttentionRepository(database);
      final visibleEntry = _entry(
        'clear-me',
        'runtime-update-ready',
        title: 'Runtime update',
      );
      final pending = _entry(
        'keep-me',
        'question-required',
        title: 'Question waiting',
      );
      await repository.persistAttentionEventsPage(
        brokerProfileId: _scope(visibleEntry.profile),
        page: AttentionEventsPage(
          events: [visibleEntry.event, pending.event],
          cursor: 1,
          reset: false,
          hasMore: false,
        ),
      );
      final client = _PageBrokerClient();
      final sink = _PageNotificationSink();
      final sections = AttentionInboxSections.fromEntries([
        visibleEntry,
        pending,
      ]);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            attentionInboxProvider.overrideWith((_) async => sections),
            attentionBadgeSeenStoreProvider.overrideWithValue(
              _MemoryBadgeSeenStore(),
            ),
            attentionRepositoryProvider.overrideWithValue(repository),
            attentionProfileClientProvider.overrideWith((_, _) async => client),
            attentionClientIdProvider.overrideWith((_) async => 'page-client'),
            sessionLocalNotificationSinkProvider.overrideWithValue(sink),
          ],
          child: _localizedApp(const AttentionPage()),
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(const Key('attention-activity-actions')),
      );
      await tester.tap(find.byKey(const Key('attention-activity-actions')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('attention-clear-all')));
      await tester.pumpAndSettle();
      expect(
        client.bulkRequests,
        isEmpty,
        reason: 'Undo precedes durable dismissal',
      );
      await tester.tap(find.text('Undo'));
      await tester.pumpAndSettle();
      expect(client.bulkRequests, isEmpty);
      expect(find.byKey(const Key('attention-event-clear-me')), findsOneWidget);
      await tester.ensureVisible(
        find.byKey(const Key('attention-activity-actions')),
      );
      await tester.tap(find.byKey(const Key('attention-activity-actions')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('attention-clear-all')));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();

      expect(client.bulkRequests, [
        [('clear-me', 1)],
      ]);
      expect(sink.clearManyCallCount, 1);
      final after = AttentionInboxSections.fromEntries(
        (await repository.loadEvents(_scope(visibleEntry.profile))).map(
          (event) =>
              AttentionInboxEntry(profile: visibleEntry.profile, event: event),
        ),
      );
      expect(after.all.map((entry) => entry.event.id), ['keep-me']);
      expect(visibleEntry.event.action.kind, 'open-attention-inbox');
    },
  );

  testWidgets('classifies inbox failures without showing exception text', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionInboxProvider.overrideWith(
            (_) => Future<AttentionInboxSections>.error(
              StateError('private inbox diagnostic'),
            ),
          ),
          attentionBadgeSeenStoreProvider.overrideWithValue(
            _MemoryBadgeSeenStore(),
          ),
        ],
        child: _localizedApp(const AttentionPage()),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text(
        "Couldn't load your inbox. Try again. If it keeps happening, the "
        'technical details can help support.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('private inbox diagnostic'), findsNothing);
    expect(find.textContaining('Bad state'), findsNothing);
  });

  testWidgets(
    'successful open clears only the durable badge for every loaded profile',
    (tester) async {
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      final badgeStore = DriftAttentionBadgeSeenStore(database);
      final sections = AttentionInboxSections.fromEntries([
        _entry(
          'a',
          'permission-required',
          title: 'Permission needed',
          profileId: 'profile-a',
          cursor: 4,
        ),
        _entry(
          'b',
          'runtime-update-ready',
          title: 'Update ready',
          profileId: 'profile-b',
          cursor: 7,
        ),
      ]);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            attentionInboxProvider.overrideWith((_) async => sections),
            attentionBadgeSeenStoreProvider.overrideWithValue(badgeStore),
          ],
          child: _localizedApp(const AttentionPage()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        await badgeStore.loadSeenThroughCursor(
          _scope(sections.all[0].profile),
        ),
        4,
      );
      expect(
        await badgeStore.loadSeenThroughCursor(
          _scope(sections.all[1].profile),
        ),
        7,
      );
      expect(
        sections.all.every((entry) => entry.event.readAt == null),
        isTrue,
        reason: 'opening the inbox must not acknowledge actionable rows',
      );
    },
  );

  testWidgets('an arrival while the inbox is open becomes seen after load', (
    tester,
  ) async {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    final badgeStore = DriftAttentionBadgeSeenStore(database);
    var cursor = 1;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionInboxProvider.overrideWith((ref) async {
            ref.watch(attentionInboxRevisionProvider);
            return AttentionInboxSections.fromEntries([
              _entry(
                'arrival-$cursor',
                'runtime-update-ready',
                title: 'Update ready',
                cursor: cursor,
              ),
            ]);
          }),
          attentionBadgeSeenStoreProvider.overrideWithValue(badgeStore),
        ],
        child: _localizedApp(const AttentionPage()),
      ),
    );
    await tester.pumpAndSettle();
    final profile = _entry(
      'scope',
      'runtime-update-ready',
      title: 'Scope',
    ).profile;
    expect(await badgeStore.loadSeenThroughCursor(_scope(profile)), 1);

    cursor = 2;
    final container = ProviderScope.containerOf(
      tester.element(find.byType(AttentionPage)),
    );
    container.read(attentionInboxRevisionProvider.notifier).state += 1;
    await tester.pumpAndSettle();

    expect(await badgeStore.loadSeenThroughCursor(_scope(profile)), 2);
  });
}

String _scope(BrokerProfile profile) =>
    RosterSource.ofProfile(profile).storageKey;

Widget _localizedApp(Widget home, {Locale? locale}) {
  return MaterialApp(
    locale: locale,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ThemeData(
      extensions: [themeSpecById(kDefaultThemeId).light],
    ),
    home: home,
  );
}

final class _MemoryBadgeSeenStore implements AttentionBadgeSeenStore {
  final cursors = <String, int>{};

  @override
  Future<int> loadSeenThroughCursor(String brokerProfileId) async =>
      cursors[brokerProfileId] ?? 0;

  @override
  Future<int> loadUnseenCount(String brokerProfileId) async => 0;

  @override
  Future<bool> markSeenThroughCursor(String brokerProfileId, int cursor) async {
    final prior = cursors[brokerProfileId] ?? 0;
    if (prior >= cursor) return false;
    cursors[brokerProfileId] = cursor;
    return true;
  }
}

AttentionInboxEntry _entry(
  String id,
  String kind, {
  required String title,
  String state = 'active',
  String profileId = 'profile',
  int cursor = 1,
}) {
  return AttentionInboxEntry(
    profile: BrokerProfile(
      id: profileId,
      displayName: 'Test workstation',
      baseUri: Uri.parse('http://127.0.0.1:7734'),
      createdAt: DateTime(2026),
    ),
    event: AttentionEventView(
      id: id,
      cursor: cursor,
      revision: 1,
      presentationRevision: 1,
      kind: kind,
      state: state,
      severity: 'informational',
      dedupeKey: id,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      updatedAt: DateTime.now().millisecondsSinceEpoch,
      resolvedAt: state == 'resolved'
          ? DateTime.now().millisecondsSinceEpoch
          : null,
      title: title,
      action: const AttentionEventAction(kind: 'open-attention-inbox'),
    ),
  );
}

final class _PageBrokerClient extends BrokerClient {
  _PageBrokerClient() : super(baseUrl: 'http://127.0.0.1:7734');

  final bulkRequests = <List<(String, int)>>[];

  @override
  Future<AttentionBulkDismissResponse> dismissAttentionEvents(
    List<AttentionBulkDismissItem> events, {
    required String clientId,
  }) async {
    bulkRequests.add([
      for (final event in events) (event.eventId, event.revision),
    ]);
    return AttentionBulkDismissResponse(
      accepted: [
        for (final event in events)
          AttentionBulkDismissAccepted(
            eventId: event.eventId,
            revision: event.revision,
            dismissedAt: DateTime(2026, 7, 26).millisecondsSinceEpoch,
          ),
      ],
      stale: const [],
      notFound: const [],
    );
  }
}

final class _PageNotificationSink implements BrokerNotificationSink {
  int clearManyCallCount = 0;

  @override
  Future<void> clear(String id) async {}

  @override
  Future<void> clearMany(Iterable<String> ids) async {
    clearManyCallCount += 1;
  }

  @override
  Future<void> clearAll() async {}

  @override
  Future<BrokerNotificationDeliveryResult> show(
    BrokerNotificationRequest request,
  ) async => BrokerNotificationDeliveryResult.shown;
}
