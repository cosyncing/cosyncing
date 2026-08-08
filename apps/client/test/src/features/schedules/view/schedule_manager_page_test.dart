import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_manager_page.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('keeps broker order and exposes Cancel then Remove', (
    tester,
  ) async {
    final fake = _FakeBrokerClient();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [brokerClientProvider.overrideWith((ref) async => fake)],
        child: MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: ThemeData(
            extensions: [themeSpecById(kDefaultThemeId).light],
          ),
          home: const ScheduleManagerPage(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final rows = find.byWidgetPredicate(
      (widget) =>
          widget.key is ValueKey<String> &&
          (widget.key! as ValueKey<String>).value.startsWith('schedule-row-'),
    );
    expect(rows, findsNWidgets(2));
    expect(
      tester.widget(rows.at(0)).key,
      const ValueKey<String>('schedule-row-live'),
    );
    expect(find.text('Cancel'), findsOneWidget);
    expect(find.text('Remove'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('schedule-delete-live')));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('schedule-row-live')),
        matching: find.text('Remove'),
      ),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('schedule-delete-live')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('schedule-row-live')), findsNothing);
  });
}

ScheduleRecord _row(String id, ScheduleState state, int at) => ScheduleRecord(
  id: id,
  kind: ScheduleKind.message,
  tool: 'codex',
  sessionId: id,
  sessionTitle: id,
  text: 'Prompt for $id',
  at: at,
  state: state,
  createdAt: 1,
  updatedAt: 1,
);

final class _FakeBrokerClient extends BrokerClient {
  _FakeBrokerClient()
    : rows = [
        _row('live', ScheduleState.scheduled, 1000),
        _row('done', ScheduleState.delivered, 500),
      ],
      super(baseUrl: 'http://test');

  List<ScheduleRecord> rows;

  @override
  Future<ScheduleListResponse> listSchedules({
    CancelToken? cancelToken,
  }) async => ScheduleListResponse(schedules: rows);

  @override
  Future<ScheduleDeleteResponse> deleteSchedule(String id) async {
    final index = rows.indexWhere((row) => row.id == id);
    if (rows[index].state.isLive) {
      final canceled = _row(id, ScheduleState.canceled, rows[index].at);
      rows = [...rows]..[index] = canceled;
      return ScheduleCanceledResponse(schedule: canceled);
    }
    rows = [...rows]..removeAt(index);
    return const ScheduleRemovedResponse();
  }
}
