import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_schedule_diagnostics.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// U6: Chat's inline schedule refresh is bound to the session transport it
/// already renders. These cases drive the REAL connection lifecycle — the
/// scripted `SessionDetailConnection` feeding the real controller — rather than
/// poking the schedule controller directly, so a regression in the wiring
/// between the two is caught here and not only in the controller unit tests.
void main() {
  const pollInterval = Duration(seconds: 15);

  group('Session Detail inline schedule lifecycle', () {
    testWidgets(
      'offline poll intervals make no request, keep the card, and show no '
      'inline error; reconnect refreshes exactly once',
      (tester) async {
        useRoomyTestViewport(tester);
        final broker = _CountingScheduleBrokerClient()
          ..scheduleRows.add(_scheduledRow());
        final connection = ScriptedSessionDetailConnection(events: const []);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: broker,
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text(_scheduledText), findsOneWidget);
        expect(broker.listCalls, 1, reason: 'one connected initial read');

        // The transport drops. Three poll intervals elapse.
        connection.emitState(SessionDetailConnectionStatus.reconnecting);
        await tester.pump();
        await tester.pump(pollInterval);
        await tester.pump(pollInterval);
        await tester.pump(pollInterval);

        expect(
          broker.listCalls,
          1,
          reason: 'no passive schedule request while reconnecting',
        );
        expect(
          find.text(_scheduledText),
          findsOneWidget,
          reason: 'cached cards survive the drop',
        );
        expect(find.byKey(const Key('schedule-inline-error')), findsNothing);

        connection.emitState(SessionDetailConnectionStatus.connected);
        await tester.pump();
        await tester.pump();

        expect(broker.listCalls, 2, reason: 'exactly one reconnect refresh');
        expect(find.text(_scheduledText), findsOneWidget);
        expect(find.byKey(const Key('schedule-inline-error')), findsNothing);

        // Settle the armed poll timer before the binding checks for it.
        connection.emitState(SessionDetailConnectionStatus.closed);
        await tester.pump();
        await tester.pump();
      },
    );

    testWidgets(
      'hidden document cancels schedule work and resume refreshes once',
      (tester) async {
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        useRoomyTestViewport(tester);
        final broker = _CountingScheduleBrokerClient()
          ..scheduleRows.add(_scheduledRow());
        final connection = ScriptedSessionDetailConnection(events: const []);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: broker,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(broker.listCalls, 1);
        expect(find.text(_scheduledText), findsOneWidget);

        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        await tester.pump();
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.hidden,
        );
        await tester.pump();
        await tester.pump();
        await tester.pump(pollInterval * 3);

        expect(
          broker.listCalls,
          1,
          reason: 'hidden documents issue no inline schedule reads',
        );
        expect(
          find.text(_scheduledText),
          findsOneWidget,
          reason: 'lifecycle suspension keeps the cached bounded card state',
        );

        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        await tester.pump();
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        await tester.pump();
        expect(broker.listCalls, 2, reason: 'one resume catch-up read');

        await tester.pump(pollInterval);
        await tester.pump();
        expect(broker.listCalls, 3, reason: 'one polling timer was re-armed');

        connection.emitState(SessionDetailConnectionStatus.closed);
        await tester.pump();
        await tester.pump();
      },
    );

    testWidgets(
      'a failing passive refresh while connected shows no inline error',
      (tester) async {
        useRoomyTestViewport(tester);
        final broker = _CountingScheduleBrokerClient()
          ..scheduleRows.add(_scheduledRow());
        final connection = ScriptedSessionDetailConnection(events: const []);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: broker,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text(_scheduledText), findsOneWidget);

        broker.listError = const BrokerException(message: 'connection refused');
        await tester.pump(pollInterval);
        await tester.pump();

        expect(broker.listCalls, 2);
        expect(
          find.byKey(const Key('schedule-inline-error')),
          findsNothing,
          reason:
              'a passive failure is connectivity noise, not a schedule '
              'failure the user can act on',
        );
        expect(
          find.text(_scheduledText),
          findsOneWidget,
          reason: 'a failed read has no newer snapshot to replace rows with',
        );

        connection.emitState(SessionDetailConnectionStatus.closed);
        await tester.pump();
        await tester.pump();
      },
    );

    testWidgets(
      'navigating Chat -> Status disposes the controller and stops the timer',
      (tester) async {
        useRoomyTestViewport(tester);
        final broker = _CountingScheduleBrokerClient()
          ..scheduleRows.add(_scheduledRow());
        final connection = ScriptedSessionDetailConnection(events: const []);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: broker,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text(_scheduledText), findsOneWidget);
        expect(broker.listCalls, 1);

        // Real navigation, not a synthetic listener drop: leaving Chat unmounts
        // the transcript, which is what auto-disposes the schedule controller.
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');
        expect(find.text(_scheduledText), findsNothing);

        await tester.pump(pollInterval);
        await tester.pump(pollInterval);
        await tester.pump(pollInterval);
        expect(
          broker.listCalls,
          1,
          reason: 'the poll timer went with the disposed controller',
        );

        connection.emitState(SessionDetailConnectionStatus.closed);
        await tester.pump();
        await tester.pump();
      },
    );

    testWidgets(
      'Debug still reports freshness after Chat unmounts, with no timer left',
      (tester) async {
        useRoomyTestViewport(tester);
        final broker = _CountingScheduleBrokerClient()
          ..scheduleRows.add(_scheduledRow());
        final connection = ScriptedSessionDetailConnection(events: const []);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: broker,
            showDebugViews: true,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(broker.listCalls, 1);

        // Make the rows stale through a suppressed passive failure, with a
        // broker body far larger than anything Debug should retain or render.
        broker.listError = BrokerException(
          message: 'connection refused ${'x' * 5000}',
        );
        await tester.pump(pollInterval);
        await tester.pump();
        expect(find.byKey(const Key('schedule-inline-error')), findsNothing);

        await openSessionDetailTestTab(tester, 'session-detail-tab-debug');
        final freshness = find.byKey(
          const Key('session-detail-debug-schedule-freshness'),
        );
        expect(freshness, findsOneWidget);
        expect(
          find.descendant(
            of: freshness,
            matching: find.textContaining('stale'),
          ),
          findsOneWidget,
          reason: 'the suppressed staleness is observable in Debug',
        );
        expect(
          find.descendant(
            of: freshness,
            matching: find.textContaining('offline'),
          ),
          findsOneWidget,
          reason: 'and so is its classified cause',
        );
        final rendered = tester
            .widget<SelectableText>(
              find.descendant(
                of: freshness,
                matching: find.byType(SelectableText),
              ),
            )
            .data!;
        expect(
          rendered.length,
          lessThan(1000),
          reason:
              'Debug discloses a BOUNDED diagnostic; a 5000-character broker '
              'body must not reach the panel verbatim',
        );
        expect(
          rendered,
          contains(InlineScheduleDiagnostics.truncationMarker),
          reason: 'a cut body must never read as complete',
        );

        final callsAtDebug = broker.listCalls;
        await tester.pump(pollInterval);
        await tester.pump(pollInterval);
        expect(
          broker.listCalls,
          callsAtDebug,
          reason: 'Debug reads a snapshot; it does not keep polling alive',
        );

        connection.emitState(SessionDetailConnectionStatus.closed);
        await tester.pump();
        await tester.pump();
      },
    );

    testWidgets(
      'a profile switch does not read schedules on the old transport report',
      (tester) async {
        useRoomyTestViewport(tester);
        final broker = _CountingScheduleBrokerClient()
          ..scheduleRows.add(_scheduledRow());
        final connection = ScriptedSessionDetailConnection(events: const []);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: broker,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(broker.listCalls, 1, reason: 'first profile initial read');

        // The page's own container, so the switch goes through the same
        // provider the app reads rather than a parallel one.
        final container = ProviderScope.containerOf(
          tester.element(find.byType(MaterialApp)),
        );

        // Switch the active profile. Session Detail resets to a disconnected
        // default for the new profile (`forActiveSource`), so no schedule read
        // may be issued on the previous transport's authority.
        container
            .read(activeBrokerProfileProvider.notifier)
            .state = BrokerProfile(
          id: 'second',
          displayName: 'second',
          baseUri: Uri.parse('http://second.test'),
          createdAt: DateTime(2026, 7, 27),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump(pollInterval);
        await tester.pump(pollInterval);

        expect(
          broker.listCalls,
          1,
          reason:
              'the new profile has not connected; nothing may be read for '
              "it on the old profile's connected report",
        );
        // No trailing close to emit: a cross-source attach supersedes the old
        // lane and disposes the retired socket, so this connection is already
        // gone by here.
      },
    );

    testWidgets(
      'Debug shows no previous broker data for the same session id after a '
      'profile switch',
      (tester) async {
        useRoomyTestViewport(tester);
        final broker = _CountingScheduleBrokerClient()
          ..scheduleRows.add(_scheduledRow());
        final connection = ScriptedSessionDetailConnection(events: const []);

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: broker,
            showDebugViews: true,
          ),
        );
        await tester.pump();
        await tester.pump();

        // Give the first profile a distinctive suppressed failure to record.
        broker.listError = const BrokerException(
          message: 'first-broker-secret',
          error: BrokerError(
            error: 'first-broker-secret',
            code: 'FIRST_BROKER_ONLY',
          ),
        );
        await tester.pump(pollInterval);
        await tester.pump();

        await openSessionDetailTestTab(tester, 'session-detail-tab-debug');
        final freshness = find.byKey(
          const Key('session-detail-debug-schedule-freshness'),
        );
        expect(
          find.descendant(
            of: freshness,
            matching: find.textContaining('FIRST_BROKER_ONLY'),
          ),
          findsOneWidget,
        );

        // The second broker serves the SAME tool/session id.
        ProviderScope.containerOf(
          tester.element(find.byType(MaterialApp)),
        ).read(activeBrokerProfileProvider.notifier).state = BrokerProfile(
          id: 'second',
          displayName: 'second',
          baseUri: Uri.parse('http://second.test'),
          createdAt: DateTime(2026, 7, 28),
        );
        await tester.pump();
        await tester.pump();

        expect(
          find.descendant(
            of: freshness,
            matching: find.textContaining('FIRST_BROKER_ONLY'),
          ),
          findsNothing,
          reason:
              "the second broker must not display the first broker's raw "
              'failure detail',
        );
        expect(
          find.descendant(
            of: freshness,
            matching: find.textContaining('no canonical read yet'),
          ),
          findsOneWidget,
          reason: 'the new profile has read nothing of its own yet',
        );
        // As above: the retired socket was disposed by the superseding attach.
      },
    );

    for (final brightness in Brightness.values) {
      testWidgets(
        'an explicit cancel failure renders localized, token-colored recovery '
        'copy in ${brightness.name} mode',
        (tester) async {
          useRoomyTestViewport(tester);
          final spec = themeSpecById(kDefaultThemeId);
          final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
          final broker = _CountingScheduleBrokerClient()
            ..scheduleRows.add(_scheduledRow())
            ..deleteError = const BrokerException(
              message: 'cancel refused',
              statusCode: 500,
            );
          final connection = ScriptedSessionDetailConnection(events: const []);

          await tester.pumpWidget(
            buildSessionDetailTestPage(
              events: const [],
              connection: connection,
              brokerClient: broker,
              theme: ThemeData(
                brightness: brightness,
                extensions: [tokens],
              ),
            ),
          );
          await tester.pump();
          await tester.pump();
          expect(find.text(_scheduledText), findsOneWidget);

          await tester.tap(
            find.byKey(const ValueKey('schedule-inline-cancel-$_scheduleId')),
          );
          await tester.pump();
          await tester.pump();

          final errorFinder = find.byKey(const Key('schedule-inline-error'));
          expect(errorFinder, findsOneWidget);
          final text = tester.widget<Text>(errorFinder);
          expect(
            text.data,
            "Couldn't update this scheduled message. The server ran into a "
            'problem on its end. Try again in a moment.',
            reason:
                'localized lead plus classified recovery advice, and no '
                'raw broker text',
          );
          expect(text.style?.color, tokens.statusError);
          expect(
            find.text(_scheduledText),
            findsOneWidget,
            reason: 'the row the user tried to cancel stays available',
          );

          connection.emitState(SessionDetailConnectionStatus.closed);
          await tester.pump();
          await tester.pump();
        },
      );
    }
  });
}

const _scheduleId = 'inline-schedule-1';
const _scheduledText = 'Run the nightly report';

ScheduleRecord _scheduledRow() => ScheduleRecord(
  id: _scheduleId,
  kind: ScheduleKind.message,
  tool: 'claude',
  sessionId: 'session-1',
  text: _scheduledText,
  at: DateTime(2026, 7, 27, 9).millisecondsSinceEpoch,
  state: ScheduleState.scheduled,
  createdAt: 1,
  updatedAt: 1,
);

/// Counts inline-schedule list calls so "no request while offline" is asserted
/// on the wire rather than inferred from what happens to be on screen.
final class _CountingScheduleBrokerClient extends FakeBrokerClient {
  int listCalls = 0;
  Object? listError;
  Object? deleteError;

  @override
  Future<ScheduleListResponse> listSchedules({
    CancelToken? cancelToken,
  }) async {
    listCalls += 1;
    final error = listError;
    if (error != null) Error.throwWithStackTrace(error, StackTrace.current);
    return super.listSchedules(cancelToken: cancelToken);
  }

  @override
  Future<ScheduleDeleteResponse> deleteSchedule(String id) async {
    final error = deleteError;
    if (error != null) Error.throwWithStackTrace(error, StackTrace.current);
    scheduleRows.removeWhere((row) => row.id == id);
    return ScheduleCanceledResponse(
      schedule: _scheduledRow(),
    );
  }
}
