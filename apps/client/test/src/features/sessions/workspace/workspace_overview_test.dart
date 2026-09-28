import 'dart:async';

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
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_overview.dart';
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
    Future<ListSessionsResponse?> Function()? roster,
    UsageReportResponse? usage,
    List<AttentionInboxEntry> events = const [],
    ValueChanged<SessionRef>? onOpen,
  }) => ProviderScope(
    overrides: [
      activeBrokerProfileProvider.overrideWith((ref) => source),
      workspaceOverviewRosterProvider.overrideWith(
        (ref) =>
            roster?.call() ??
            Future.value(ListSessionsResponse(sessions: sessions)),
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

  testWidgets('loading current counts never invents zero', (tester) async {
    final pending = Completer<ListSessionsResponse?>();
    await tester.pumpWidget(host(roster: () => pending.future));
    await tester.pump();
    expect(find.text('—'), findsNWidgets(4));
    expect(find.text('Loading current data…'), findsOneWidget);
    pending.complete(null);
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Current activity is unavailable'),
      findsOneWidget,
    );
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
    expect(find.text('Estimated agent activity'), findsOneWidget);
    expect(
      find.textContaining('Concurrent sessions add together.'),
      findsOneWidget,
    );
    expect(find.textContaining('Partial usage:'), findsOneWidget);
    expect(find.textContaining('Europe/London'), findsOneWidget);
  });

  test(
    'overview fetches complete roster independent of sidebar window',
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
      final response = await container.read(
        workspaceOverviewRosterProvider.future,
      );
      expect(response!.sessions.length, 2);
      expect(repository.fetchCount, 1);
    },
  );
}

class _LoadedList extends SessionListController {
  @override
  SessionListState build() =>
      const SessionListState(status: SessionListStatus.loaded);
}
