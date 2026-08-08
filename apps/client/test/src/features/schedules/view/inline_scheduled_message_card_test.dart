import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/schedules/view/inline_scheduled_message_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders full future prompt and edit/cancel affordances', (
    tester,
  ) async {
    final schedule = ScheduleRecord(
      id: 'schedule-1',
      kind: ScheduleKind.message,
      tool: 'codex',
      sessionId: 'session-1',
      text: 'A complete prompt that must not be clipped',
      at: DateTime(2026, 7, 18, 9).millisecondsSinceEpoch,
      state: ScheduleState.scheduled,
      createdAt: 1,
      updatedAt: 1,
    );
    var editCount = 0;
    var cancelCount = 0;

    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(
          themeSpecById(kDefaultThemeId).light,
          Brightness.light,
        ),
        home: Scaffold(
          body: InlineScheduledMessageCard(
            schedule: schedule,
            busy: false,
            onEdit: () => editCount += 1,
            onCancel: () => cancelCount += 1,
          ),
        ),
      ),
    );

    expect(find.text(schedule.text), findsOneWidget);
    expect(find.text('Scheduled'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('schedule-inline-edit-schedule-1')),
    );
    await tester.tap(
      find.byKey(const ValueKey('schedule-inline-cancel-schedule-1')),
    );
    expect(editCount, 1);
    expect(cancelCount, 1);
  });
}
