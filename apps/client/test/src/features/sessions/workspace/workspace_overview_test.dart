import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_repository.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/overview_quota_preferences.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_overview.dart';
import 'package:cosyncing_client/src/features/settings/data/managed_runtime_api.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

BrokerProfile _profile(String host) => BrokerProfile(
  id: 'same-profile',
  displayName: host,
  baseUri: Uri.parse('http://$host'),
  createdAt: DateTime(2026),
);

SessionInfo _session(String id, SessionStatus status, {String? parent}) =>
    SessionInfo(
      id: id,
      nativeId: id,
      tool: 'claude',
      title: id,
      status: status,
      parentThreadId: parent,
      attachMode: AttachMode.observe,
    );

AttentionInboxEntry _completion(
  String id,
  BrokerProfile profile, {
  String kind = 'run-finished',
}) => AttentionInboxEntry(
  profile: profile,
  event: AttentionEventView.fromJson({
    'id': id,
    'cursor': 1,
    'kind': kind,
    'state': 'active',
    'severity': 'info',
    'title': 'Completed $id',
    'agent': 'claude',
    'sessionId': id,
    'sessionTitle': 'Result $id',
    'updatedAt': 1,
    'createdAt': 1,
    'actions': <Object>[],
  }),
);

void main() {
  final source = _profile('machine-a');
  final sessions = [
    _session('parent', SessionStatus.working),
    _session('child', SessionStatus.needsInput, parent: 'parent'),
  ];
  Widget host({
    ListSessionsResponse? Function()? roster,
    UsageReportResponse? usage,
    SessionListStatus status = SessionListStatus.loaded,
    List<AttentionInboxEntry> events = const [],
    ValueChanged<SessionRef>? onOpen,
  }) => ProviderScope(
    overrides: [
      overviewQuotaPreferencesProvider.overrideWith(_NoQuotaChoices.new),
      managedRuntimeQuotaProvider.overrideWith((ref) async => null),
      activeBrokerProfileProvider.overrideWith((ref) => source),
      sessionListControllerProvider.overrideWith(() => _LoadedList(status)),
      workspaceOverviewRosterProvider.overrideWith(
        (ref) => roster == null
            ? ListSessionsResponse(sessions: sessions)
            : roster(),
      ),
      attentionInboxProvider.overrideWith(
        (ref) async => AttentionInboxSections.fromEntries(events),
      ),
      usageReportProvider.overrideWith((ref, query) async => usage),
    ],
    child: MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(
        themeSpecById(kDefaultThemeId).light,
        Brightness.light,
      ),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: Scaffold(body: WorkspaceOverview(onOpen: onOpen ?? (_) {})),
    ),
  );

  testWidgets('counts child input without changing parent execution state', (
    tester,
  ) async {
    await tester.pumpWidget(host());
    await tester.pumpAndSettle();
    Finder count(String kind, String value) => find.descendant(
      of: find.byKey(Key('workspace-overview-count-$kind')),
      matching: find.text(value),
    );
    expect(count('running', '1'), findsOneWidget);
    expect(count('waiting', '1'), findsOneWidget);
    expect(count('completions', '0'), findsOneWidget);
    expect(find.text('Untitled session'), findsOneWidget);
    await tester.tap(find.text('Running').first);
    await tester.pumpAndSettle();
    expect(find.text('Working'), findsOneWidget);
    expect(find.text('Needs input'), findsNothing);
  });

  testWidgets(
    'completion count is exact-source scoped and opens identity only',
    (tester) async {
      final opened = <SessionRef>[];
      await tester.pumpWidget(
        host(
          events: [
            _completion('a', source),
            _completion('goal', source, kind: 'goal-finished'),
            _completion('b', _profile('machine-b')),
          ],
          onOpen: opened.add,
        ),
      );
      await tester.pumpAndSettle();
      // The queue opens on Waiting for you; completions list under their own
      // count.
      expect(find.text('Result a'), findsNothing);
      await tester.tap(
        find.byKey(const Key('workspace-overview-count-completions')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Result a'), findsOneWidget);
      expect(find.text('Result b'), findsNothing);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(WorkspaceOverview)),
      );
      expect(container.read(workspaceUnreadCompletionKeysProvider), {
        'claude/a',
        'claude/goal',
      });
      await tester.ensureVisible(find.text('Result a'));
      await tester.tap(find.text('Result a'));
      expect(opened.single.key, 'claude/a');
      expect(opened.single.status, isNull);
    },
  );

  testWidgets('the queue names one bucket at a time, with no union filter', (
    tester,
  ) async {
    await tester.pumpWidget(host(events: [_completion('a', source)]));
    await tester.pumpAndSettle();

    final queueCount = find.byKey(const Key('workspace-overview-queue-count'));
    expect(tester.widget<Text>(queueCount).data, '1');
    expect(find.text('Needs attention'), findsNothing);
    final filter = find.byKey(const Key('workspace-overview-filter'));
    await tester.ensureVisible(filter);
    await tester.pumpAndSettle();
    await tester.tap(filter);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('workspace-overview-filter-attention')),
      findsNothing,
    );
    for (final kind in ['working', 'input', 'completions']) {
      expect(
        find.byKey(Key('workspace-overview-filter-$kind')),
        findsOneWidget,
        reason: kind,
      );
    }
    expect(find.text('Questions and approvals'), findsOneWidget);
  });

  testWidgets('loading current counts never invents zero', (tester) async {
    await tester.pumpWidget(
      host(roster: () => null, status: SessionListStatus.loading),
    );
    await tester.pump();
    expect(find.text('—'), findsNWidgets(6));
    expect(find.text('Loading current data…'), findsOneWidget);
    final container = ProviderScope.containerOf(
      tester.element(find.byType(WorkspaceOverview)),
    );
    (container.read(sessionListControllerProvider.notifier) as _LoadedList)
        .setStatus(SessionListStatus.error);
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Current activity is unavailable'),
      findsOneWidget,
    );
  });

  testWidgets('a partial roster never claims a missing active count is zero', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        roster: () => ListSessionsResponse(
          sessions: [_session('known', SessionStatus.working)],
          complete: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byKey(const Key('workspace-overview-count-running')),
        matching: find.text('1'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('workspace-overview-count-waiting')),
        matching: find.text('—'),
      ),
      findsOneWidget,
    );
    final l10n = AppLocalizations.of(
      tester.element(find.byType(WorkspaceOverview)),
    );
    expect(find.text(l10n.workspacePartialRoster), findsOneWidget);
    expect(find.text(l10n.workspaceNothingHere), findsNothing);
  });

  testWidgets('daily usage preserves partial and estimate disclosures', (
    tester,
  ) async {
    final usage = UsageReportResponse.fromJson({
      'ok': true,
      'data': {
        'range': {'from': '2026-09-28', 'to': '2026-09-28', 'recognized': true},
        'runtime': {
          'version': '2.6.4',
          'minimumVersion': '2.6.0',
          'belowMinimum': false,
        },
        'totals': {
          'tokens': 1234000,
          'cost': 0,
          'requests': 8,
          'tokensInput': 1000000,
          'tokensOutput': 234000,
          'tokensCache': 0,
        },
        'activeTime': {
          'estimated': true,
          'activeMsSum': 3600000,
          'gapCapMs': 300000,
        },
        'sourceErrors': ['Unavailable source'],
        'coverage': {
          'sourceCount': 1,
          'storedSources': ['claude'],
          'liveSources': <Object>[],
        },
        'timezone': 'Europe/London',
      },
    });
    await tester.pumpWidget(host(usage: usage));
    await tester.pumpAndSettle();
    expect(find.text('1.2M'), findsOneWidget);
    expect(find.text('Time'), findsOneWidget);
    expect(find.text('Cost · USD'), findsOneWidget);
    expect(find.text('Messages'), findsOneWidget);
    expect(find.textContaining('Input:'), findsNothing);
    tester.view.physicalSize = const Size(320, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpAndSettle();
    expect(
      tester.getTopLeft(find.text('Time')).dy,
      tester.getTopLeft(find.text('Tokens')).dy,
    );
    expect(
      tester.getTopLeft(find.text('Cost · USD')).dy,
      tester.getTopLeft(find.text('Messages')).dy,
    );
    expect(
      tester.getTopLeft(find.text('Cost · USD')).dy,
      greaterThan(tester.getTopLeft(find.text('Time')).dy),
    );
    expect(tester.takeException(), isNull);
    expect(find.textContaining('Partial usage:'), findsOneWidget);
    // How the estimate is made, where days begin and how many sources were
    // read are the report's caveats; the summary states only its figures.
    expect(find.textContaining('summed across agents'), findsNothing);
    expect(
      find.textContaining('Concurrent sessions add together.'),
      findsNothing,
    );
    expect(find.textContaining('local midnight'), findsNothing);
    expect(find.textContaining('tool sources'), findsNothing);
  });

  test(
    'overview reuses the source roster without fetching another window',
    () async {
      final repository = InMemorySessionListRepository(sessions: sessions);
      final container = ProviderContainer(
        overrides: [
          activeBrokerProfileProvider.overrideWith((ref) => source),
          sessionListControllerProvider.overrideWith(_LoadedList.new),
          sessionListRepositoryProvider.overrideWith((ref) async => repository),
        ],
      );
      addTearDown(container.dispose);
      final response = container.read(workspaceOverviewRosterProvider);
      expect(response!.sessions.length, 2);
      expect(repository.fetchCount, 0);
      final subscription = container.listen(
        workspaceOverviewRosterProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      final controller =
          (container.read(sessionListControllerProvider.notifier)
                as _LoadedList)
            ..republish();
      expect(container.read(workspaceOverviewRosterProvider), same(response));
      controller.setStatus(SessionListStatus.error);
      // The projection changes in this frame, without a FutureProvider turn.
      expect(container.read(workspaceOverviewRosterProvider), isNull);
    },
  );
}

class _LoadedList extends SessionListController {
  _LoadedList([this.initialStatus = SessionListStatus.loaded]);
  final SessionListStatus initialStatus;

  void setStatus(SessionListStatus status) =>
      state = state.copyWith(status: status);
  void republish() => state = state.copyWith();

  @override
  SessionListState build() => SessionListState(
    status: initialStatus,
    source: RosterSource.ofProfile(_profile('machine-a')),
    sessions: [
      _session('parent', SessionStatus.working),
      _session('child', SessionStatus.needsInput, parent: 'parent'),
    ],
  );
}

class _NoQuotaChoices extends OverviewQuotaPreferences {
  @override
  Future<List<String>> build() async => const [];
}
