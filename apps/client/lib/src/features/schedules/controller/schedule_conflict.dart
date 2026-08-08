import 'package:broker_contract/broker_contract.dart';

/// Whether [error] is a broker schedule conflict the caller should treat as
/// "this schedule changed on another client; refresh before retrying".
///
/// Shared by the global schedule manager and the inline session controllers so
/// the recognized error-code set stays in one place.
bool isScheduleConflict(Object error) {
  if (error is! BrokerException) return false;
  final code = error.error?.code;
  return error.statusCode == 409 ||
      code == 'SCHEDULE_STALE' ||
      code == 'SCHEDULE_INVALID_STATE';
}
