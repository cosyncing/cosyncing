import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/schedules/model/schedule_timing.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('combines a local date and clock without a UTC shift', () {
    final value = combineLocalScheduleDateTime(
      DateTime(2026, 10, 25),
      DateTime(2026, 1, 1, 8, 45),
    );

    expect(value, DateTime(2026, 10, 25, 8, 45));
    expect(value.isUtc, isFalse);
  });

  test('repeat exists only for daily and weekdays', () {
    expect(NewSessionStart.now.repeat, isNull);
    expect(NewSessionStart.once.repeat, isNull);
    expect(NewSessionStart.daily.repeat, ScheduleRepeat.daily);
    expect(NewSessionStart.weekdays.repeat, ScheduleRepeat.weekdays);
  });

  test('past tolerance matches the broker one-minute boundary', () {
    final now = DateTime(2026, 7, 16, 12);

    expect(
      scheduleDateTimeIsTooFarPast(
        now.subtract(const Duration(seconds: 59)),
        now,
      ),
      isFalse,
    );
    expect(
      scheduleDateTimeIsTooFarPast(
        now.subtract(const Duration(minutes: 1, seconds: 1)),
        now,
      ),
      isTrue,
    );
  });

  test('prompt length pins the broker 32k character boundary', () {
    expect(
      schedulePromptIsTooLong(List.filled(32000, 'x').join()),
      isFalse,
    );
    expect(
      schedulePromptIsTooLong(List.filled(32001, 'x').join()),
      isTrue,
    );
  });
}
