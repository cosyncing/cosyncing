import 'package:broker_contract/broker_contract.dart';

/// Maximum prompt length accepted by the broker schedule API.
const int schedulePromptMaxCharacters = 32000;

/// Whether [text] exceeds the broker's schedule prompt bound.
bool schedulePromptIsTooLong(String text) =>
    text.length > schedulePromptMaxCharacters;

/// User-facing start choices in the New Session flow.
enum NewSessionStart {
  /// Create immediately.
  now,

  /// Create once at a future local date/time.
  once,

  /// Create every local calendar day.
  daily,

  /// Create Monday through Friday in the selected device zone.
  weekdays,

  /// Create on a standard five-field cron schedule.
  cron;

  /// Whether this choice creates a broker schedule.
  bool get isScheduled => this != NewSessionStart.now;

  /// Broker recurrence, absent for now and one-shot later.
  ScheduleRepeat? get repeat => switch (this) {
    NewSessionStart.daily => ScheduleRepeat.daily,
    NewSessionStart.weekdays => ScheduleRepeat.weekdays,
    NewSessionStart.now || NewSessionStart.once || NewSessionStart.cron => null,
  };
}

/// Default first occurrence: one hour from [now], rounded to the minute.
DateTime defaultScheduleDateTime(DateTime now) {
  final value = now.add(const Duration(hours: 1));
  return DateTime(value.year, value.month, value.day, value.hour, value.minute);
}

/// Combines local calendar and clock choices without applying a UTC shift.
DateTime combineLocalScheduleDateTime(DateTime date, DateTime time) =>
    DateTime(date.year, date.month, date.day, time.hour, time.minute);

/// Whether [value] is outside the broker's one-minute past tolerance.
bool scheduleDateTimeIsTooFarPast(DateTime value, DateTime now) =>
    value.isBefore(now.subtract(const Duration(minutes: 1)));
