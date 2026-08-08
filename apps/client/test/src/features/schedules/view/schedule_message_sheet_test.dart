import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_message_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('creates a one-shot message schedule with no repeat control', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [brokerClientProvider.overrideWith((ref) async => fake)],
        child: MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => unawaited(
                  showScheduleMessageSheet(
                    context,
                    tool: 'codex',
                    sessionId: 's1',
                    sessionTitle: 'Review',
                    text: 'Continue later',
                  ),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Repeat'), findsNothing);
    await tester.tap(find.byKey(const Key('schedule-message-submit')));
    await tester.pumpAndSettle();

    final request = fake.requests.single as MessageScheduleCreate;
    expect(request.tool, 'codex');
    expect(request.sessionId, 's1');
    expect(request.text, 'Continue later');
  });

  testWidgets(
    'edit sheet prefills the row and returns its revision-checked fields',
    (tester) async {
      final at = DateTime.now().add(const Duration(hours: 2));
      final schedule = ScheduleRecord(
        id: 'schedule-1',
        revision: 12,
        kind: ScheduleKind.message,
        tool: 'codex',
        sessionId: 's1',
        sessionTitle: 'Review',
        text: 'Original scheduled prompt',
        at: at.millisecondsSinceEpoch,
        state: ScheduleState.scheduled,
        createdAt: 1,
        updatedAt: 1,
      );
      ScheduleUpdate? result;

      await tester.pumpWidget(
        MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  result = await showScheduleMessageEditSheet(
                    context,
                    schedule: schedule,
                  );
                },
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('schedule-message-text')))
            .controller!
            .text,
        schedule.text,
      );
      expect(
        find.byKey(const Key('schedule-message-at-value')),
        findsOneWidget,
      );

      await tester.enterText(
        find.byKey(const Key('schedule-message-text')),
        'Edited scheduled prompt',
      );
      await tester.tap(find.byKey(const Key('schedule-message-edit-submit')));
      await tester.pumpAndSettle();

      expect(result?.toJson(), {
        'expectedRevision': 12,
        'text': 'Edited scheduled prompt',
        'at': at.millisecondsSinceEpoch,
      });
    },
  );
}

final class _FakeBrokerClient extends BrokerClient {
  _FakeBrokerClient() : super(baseUrl: 'http://test');

  final List<ScheduleCreate> requests = [];

  @override
  Future<ScheduleCreateResponse> createSchedule(ScheduleCreate request) async {
    requests.add(request);
    return ScheduleCreateResponse(
      schedule: ScheduleRecord(
        id: 'one',
        kind: ScheduleKind.message,
        tool: request.tool,
        sessionId: (request as MessageScheduleCreate).sessionId,
        text: request.text,
        at: request.at,
        state: ScheduleState.scheduled,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
  }
}
