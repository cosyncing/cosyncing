/// Typed `/api/schedules` wire models.
///
/// The broker owns scheduling and recurrence. Clients convert local date/time
/// choices to epoch milliseconds and send an IANA time zone for repeats.
library;

import 'package:broker_contract/src/models/session_info.dart';

Map<String, dynamic> _modelSelectionJson(
  SessionCurrentModel model,
) => <String, dynamic>{
  'providerID': model.providerID,
  'modelID': model.modelID,
  if (model.variant != null) 'variant': model.variant,
  if (model.reasoningEffort != null) 'reasoningEffort': model.reasoningEffort,
};

/// Schedule target kind.
enum ScheduleKind {
  /// A one-shot prompt for an existing session.
  message('message'),

  /// A new session plus its first prompt.
  newSession('new-session'),

  /// A future value unknown to this client.
  unknown('unknown');

  const ScheduleKind(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Tolerantly parses a broker value.
  static ScheduleKind fromWire(Object? value) => switch (value) {
    'message' => ScheduleKind.message,
    'new-session' => ScheduleKind.newSession,
    _ => ScheduleKind.unknown,
  };
}

/// Supported recurrence rules for new-session schedules.
enum ScheduleRepeat {
  /// Repeat every local calendar day.
  daily('daily'),

  /// Repeat Monday through Friday in the schedule's time zone.
  weekdays('weekdays');

  const ScheduleRepeat(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a recurrence value, returning `null` when absent or unknown.
  static ScheduleRepeat? fromWire(Object? value) => switch (value) {
    'daily' => ScheduleRepeat.daily,
    'weekdays' => ScheduleRepeat.weekdays,
    _ => null,
  };
}

/// Typed class for a failed schedule delivery.
enum ScheduleFailureKind {
  /// Agent/session delivery failed.
  delivery('delivery'),

  /// A native quota signal exhausted the occurrence.
  quota('quota'),

  /// A future broker value.
  unknown('unknown');

  const ScheduleFailureKind(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Tolerantly parses a broker value.
  static ScheduleFailureKind? fromWire(Object? value) => switch (value) {
    'delivery' => ScheduleFailureKind.delivery,
    'quota' => ScheduleFailureKind.quota,
    null => null,
    _ => ScheduleFailureKind.unknown,
  };
}

/// Retry-delay growth policy.
enum ScheduleRetryBackoff {
  /// Reuse the configured delay for every retry.
  fixed('fixed'),

  /// Double the delay between retries (broker-capped).
  exponential('exponential');

  const ScheduleRetryBackoff(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Parses a checked retry policy value.
  static ScheduleRetryBackoff fromWire(Object? value) => switch (value) {
    'fixed' => ScheduleRetryBackoff.fixed,
    'exponential' => ScheduleRetryBackoff.exponential,
    _ => throw FormatException('Unknown schedule retry backoff: $value'),
  };
}

/// Standard five-field numeric cron expression in one IANA time zone.
final class ScheduleCron {
  /// Creates cron timing.
  const ScheduleCron({required this.expression, required this.timeZone});

  /// Decodes cron timing.
  factory ScheduleCron.fromJson(Map<String, dynamic> json) => ScheduleCron(
    expression: _requiredString(json, 'expression'),
    timeZone: _requiredString(json, 'timeZone'),
  );

  /// Five-field cron expression.
  final String expression;

  /// IANA time zone.
  final String timeZone;

  /// Encodes cron timing.
  Map<String, dynamic> toJson() => {
    'expression': expression,
    'timeZone': timeZone,
  };
}

/// Bounded broker-owned retry policy.
final class ScheduleRetryPolicy {
  /// Creates a retry policy.
  const ScheduleRetryPolicy({
    required this.maxRetries,
    required this.delayMs,
    required this.backoff,
    required this.retryOn,
  });

  /// Decodes a retry policy.
  factory ScheduleRetryPolicy.fromJson(Map<String, dynamic> json) {
    final rawRetryOn = json['retryOn'];
    if (rawRetryOn is! List) {
      throw const FormatException('retryOn must be a list');
    }
    return ScheduleRetryPolicy(
      maxRetries: _requiredInt(json, 'maxRetries'),
      delayMs: _requiredInt(json, 'delayMs'),
      backoff: ScheduleRetryBackoff.fromWire(json['backoff']),
      retryOn: rawRetryOn
          .map(ScheduleFailureKind.fromWire)
          .whereType<ScheduleFailureKind>()
          .toList(growable: false),
    );
  }

  /// Retry count after the first attempt.
  final int maxRetries;

  /// Delay before the first retry.
  final int delayMs;

  /// Delay growth policy.
  final ScheduleRetryBackoff backoff;

  /// Failure classes eligible for retry.
  final List<ScheduleFailureKind> retryOn;

  /// Encodes the policy.
  Map<String, dynamic> toJson() => {
    'maxRetries': maxRetries,
    'delayMs': delayMs,
    'backoff': backoff.wireValue,
    'retryOn': retryOn.map((value) => value.wireValue).toList(),
  };
}

/// Outcome of a fired schedule occurrence.
enum ScheduleOutcome {
  /// The prompt reached the agent.
  delivered('delivered'),

  /// Attach or prompt handoff failed synchronously.
  failed('failed'),

  /// The broker woke at least 30 minutes after the occurrence.
  missed('missed'),

  /// A future value unknown to this client.
  unknown('unknown');

  const ScheduleOutcome(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Tolerantly parses a broker value.
  static ScheduleOutcome? fromWire(Object? value) => switch (value) {
    'delivered' => ScheduleOutcome.delivered,
    'failed' => ScheduleOutcome.failed,
    'missed' => ScheduleOutcome.missed,
    null => null,
    _ => ScheduleOutcome.unknown,
  };
}

/// Current schedule lifecycle state.
enum ScheduleState {
  /// Waiting for its next occurrence.
  scheduled('scheduled'),

  /// Temporarily disabled while retaining its recurrence.
  paused('paused'),

  /// One-shot prompt handoff succeeded.
  delivered('delivered'),

  /// One-shot prompt handoff failed.
  failed('failed'),

  /// One-shot occurrence exceeded the missed-fire grace.
  missed('missed'),

  /// Canceled by the user.
  canceled('canceled'),

  /// A future value unknown to this client.
  unknown('unknown');

  const ScheduleState(this.wireValue);

  /// Broker wire value.
  final String wireValue;

  /// Whether the row can be canceled.
  bool get isLive =>
      this == ScheduleState.scheduled || this == ScheduleState.paused;

  /// Tolerantly parses a broker value.
  static ScheduleState fromWire(Object? value) => switch (value) {
    'scheduled' => ScheduleState.scheduled,
    'paused' => ScheduleState.paused,
    'delivered' => ScheduleState.delivered,
    'failed' => ScheduleState.failed,
    'missed' => ScheduleState.missed,
    'canceled' => ScheduleState.canceled,
    _ => ScheduleState.unknown,
  };
}

/// Complete schedule row returned by the broker.
final class ScheduleRecord {
  /// Creates a schedule row.
  const ScheduleRecord({
    required this.id,
    required this.kind,
    required this.tool,
    required this.text,
    required this.at,
    required this.state,
    required this.createdAt,
    required this.updatedAt,
    this.revision = 1,
    this.sessionId,
    this.sessionTitle,
    this.directory,
    this.title,
    this.model,
    this.repeat,
    this.cron,
    this.retryPolicy,
    this.timeZone,
    this.recurrenceTime,
    this.lastFiredAt,
    this.lastOutcome,
    this.lastError,
    this.lastFailureKind,
    this.retryAttempt,
    this.nextRetryAt,
    this.occurrenceAt,
    this.pendingSessionId,
    this.lastFailedSessionId,
    this.createdSessionId,
  });

  /// Decodes a checked broker row.
  factory ScheduleRecord.fromJson(Map<String, dynamic> json) {
    return ScheduleRecord(
      id: _requiredString(json, 'id'),
      revision: _optionalInt(json['revision']) ?? 1,
      kind: ScheduleKind.fromWire(json['kind']),
      tool: _requiredString(json, 'tool'),
      sessionId: _optionalString(json['sessionId']),
      sessionTitle: _optionalString(json['sessionTitle']),
      directory: _optionalString(json['directory']),
      title: _optionalString(json['title']),
      model: switch (json['model']) {
        final Map<Object?, Object?> value => SessionCurrentModel.fromJson(
          Map<String, dynamic>.from(value),
        ),
        _ => null,
      },
      text: _requiredString(json, 'text', allowEmpty: true),
      at: _requiredInt(json, 'at'),
      repeat: ScheduleRepeat.fromWire(json['repeat']),
      cron: switch (json['cron']) {
        final Map<Object?, Object?> value => ScheduleCron.fromJson(
          Map<String, dynamic>.from(value),
        ),
        _ => null,
      },
      retryPolicy: switch (json['retryPolicy']) {
        final Map<Object?, Object?> value => ScheduleRetryPolicy.fromJson(
          Map<String, dynamic>.from(value),
        ),
        _ => null,
      },
      timeZone: _optionalString(json['timeZone']),
      recurrenceTime: _optionalString(json['recurrenceTime']),
      state: ScheduleState.fromWire(json['state']),
      createdAt: _requiredInt(json, 'createdAt'),
      updatedAt: _requiredInt(json, 'updatedAt'),
      lastFiredAt: _optionalInt(json['lastFiredAt']),
      lastOutcome: ScheduleOutcome.fromWire(json['lastOutcome']),
      lastError: _optionalString(json['lastError']),
      lastFailureKind: ScheduleFailureKind.fromWire(json['lastFailureKind']),
      retryAttempt: _optionalInt(json['retryAttempt']),
      nextRetryAt: _optionalInt(json['nextRetryAt']),
      occurrenceAt: _optionalInt(json['occurrenceAt']),
      pendingSessionId: _optionalString(json['pendingSessionId']),
      lastFailedSessionId: _optionalString(json['lastFailedSessionId']),
      createdSessionId: _optionalString(json['createdSessionId']),
    );
  }

  /// Stable schedule id.
  final String id;

  /// Monotonic optimistic-concurrency revision.
  final int revision;

  /// Existing-message or new-session kind.
  final ScheduleKind kind;

  /// Target tool id.
  final String tool;

  /// Existing-session id for [ScheduleKind.message].
  final String? sessionId;

  /// Display snapshot for an existing target.
  final String? sessionTitle;

  /// New-session working directory.
  final String? directory;

  /// New-session title.
  final String? title;

  /// Exact optional model for new-session creation.
  final SessionCurrentModel? model;

  /// Full prompt text.
  final String text;

  /// Next fire time in epoch milliseconds.
  final int at;

  /// Optional recurrence for new sessions.
  final ScheduleRepeat? repeat;

  /// Arbitrary cron recurrence, mutually exclusive with [repeat].
  final ScheduleCron? cron;

  /// Optional bounded retry policy.
  final ScheduleRetryPolicy? retryPolicy;

  /// IANA time zone owning a repeating wall clock.
  final String? timeZone;

  /// Broker-owned stable local recurrence anchor.
  final String? recurrenceTime;

  /// Current lifecycle state.
  final ScheduleState state;

  /// Creation timestamp in epoch milliseconds.
  final int createdAt;

  /// Last update timestamp in epoch milliseconds.
  final int updatedAt;

  /// Most recent occurrence timestamp.
  final int? lastFiredAt;

  /// Most recent occurrence outcome for a repeating row.
  final ScheduleOutcome? lastOutcome;

  /// Honest broker failure or missed-fire detail.
  final String? lastError;

  /// Typed failure class for the latest exhausted occurrence.
  final ScheduleFailureKind? lastFailureKind;

  /// Current retry attempt, when retrying.
  final int? retryAttempt;

  /// Next retry time in epoch milliseconds.
  final int? nextRetryAt;

  /// Original occurrence while [at] points to a retry.
  final int? occurrenceAt;

  /// Durable new-session target for the current occurrence.
  final String? pendingSessionId;

  /// Reusable target from the most recent failed occurrence.
  final String? lastFailedSessionId;

  /// Session created by the most recent successful new-session occurrence.
  final String? createdSessionId;

  /// Encodes the complete row.
  Map<String, dynamic> toJson() => <String, dynamic>{
    'id': id,
    'revision': revision,
    'kind': kind.wireValue,
    'tool': tool,
    if (sessionId != null) 'sessionId': sessionId,
    if (sessionTitle != null) 'sessionTitle': sessionTitle,
    if (directory != null) 'directory': directory,
    if (title != null) 'title': title,
    if (model != null) 'model': _modelSelectionJson(model!),
    'text': text,
    'at': at,
    if (repeat != null) 'repeat': repeat!.wireValue,
    if (cron != null) 'cron': cron!.toJson(),
    if (retryPolicy != null) 'retryPolicy': retryPolicy!.toJson(),
    if (timeZone != null) 'timeZone': timeZone,
    if (recurrenceTime != null) 'recurrenceTime': recurrenceTime,
    'state': state.wireValue,
    'createdAt': createdAt,
    'updatedAt': updatedAt,
    if (lastFiredAt != null) 'lastFiredAt': lastFiredAt,
    if (lastOutcome != null) 'lastOutcome': lastOutcome!.wireValue,
    if (lastError != null) 'lastError': lastError,
    if (lastFailureKind != null) 'lastFailureKind': lastFailureKind!.wireValue,
    if (retryAttempt != null) 'retryAttempt': retryAttempt,
    if (nextRetryAt != null) 'nextRetryAt': nextRetryAt,
    if (occurrenceAt != null) 'occurrenceAt': occurrenceAt,
    if (pendingSessionId != null) 'pendingSessionId': pendingSessionId,
    if (lastFailedSessionId != null) 'lastFailedSessionId': lastFailedSessionId,
    if (createdSessionId != null) 'createdSessionId': createdSessionId,
  };
}

/// Typed body accepted by `POST /api/schedules`.
sealed class ScheduleCreate {
  /// Creates shared schedule fields.
  const ScheduleCreate({
    required this.tool,
    required this.text,
    this.retryPolicy,
  });

  /// Target tool id.
  final String tool;

  /// Prompt sent at fire time.
  final String text;

  /// Optional broker retry policy.
  final ScheduleRetryPolicy? retryPolicy;

  /// First fire time when the request is not cron-based.
  int? get at;

  /// Encodes the discriminated request.
  Map<String, dynamic> toJson();
}

/// One-shot prompt into an existing session.
final class MessageScheduleCreate extends ScheduleCreate {
  /// Creates an existing-session schedule.
  const MessageScheduleCreate({
    required super.tool,
    required this.sessionId,
    required super.text,
    required this.at,
    super.retryPolicy,
    this.sessionTitle,
  });

  /// Target session id.
  final String sessionId;

  /// Optional display snapshot.
  final String? sessionTitle;

  /// One-shot fire time in epoch milliseconds.
  @override
  final int at;

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
    'kind': ScheduleKind.message.wireValue,
    'tool': tool,
    'sessionId': sessionId,
    if (sessionTitle != null) 'sessionTitle': sessionTitle,
    'text': text,
    'at': at,
    if (retryPolicy != null) 'retryPolicy': retryPolicy!.toJson(),
  };
}

/// New session plus its required first prompt.
final class NewSessionScheduleCreate extends ScheduleCreate {
  /// Creates a new-session schedule.
  const NewSessionScheduleCreate({
    required super.tool,
    required super.text,
    super.retryPolicy,
    this.at,
    this.directory,
    this.title,
    this.model,
    this.repeat,
    this.timeZone,
    this.cron,
  }) : assert(
         (at != null) != (cron != null),
         'Provide exactly one of at or cron',
       ),
       assert(
         cron == null || (repeat == null && timeZone == null),
         'cron is mutually exclusive with repeat/timeZone',
       ),
       assert(
         timeZone == null || repeat != null,
         'timeZone is valid only for a repeating new-session schedule',
       );

  /// Optional working directory.
  final String? directory;

  /// First fire time in epoch milliseconds when [cron] is absent.
  @override
  final int? at;

  /// Optional session title.
  final String? title;

  /// Exact optional model; null keeps the tool default.
  final SessionCurrentModel? model;

  /// Optional recurrence.
  final ScheduleRepeat? repeat;

  /// IANA time zone required by repeating client flows.
  final String? timeZone;

  /// Optional arbitrary cron recurrence.
  final ScheduleCron? cron;

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
    'kind': ScheduleKind.newSession.wireValue,
    'tool': tool,
    if (directory != null) 'directory': directory,
    if (title != null) 'title': title,
    if (model != null) 'model': _modelSelectionJson(model!),
    'text': text,
    if (at != null) 'at': at,
    if (repeat != null) 'repeat': repeat!.wireValue,
    if (timeZone != null) 'timeZone': timeZone,
    if (cron != null) 'cron': cron!.toJson(),
    if (retryPolicy != null) 'retryPolicy': retryPolicy!.toJson(),
  };
}

/// Typed body for `PATCH /api/schedules/:id`.
final class ScheduleUpdate {
  /// Creates a revision-checked schedule edit.
  const ScheduleUpdate({
    required this.expectedRevision,
    this.text,
    this.at,
    this.repeat,
    this.cron,
    this.retryPolicy,
    this.timeZone,
    this.sessionTitle,
    this.directory,
    this.title,
    this.clearRepeat = false,
    this.clearCron = false,
    this.clearRetryPolicy = false,
    this.clearTimeZone = false,
    this.clearSessionTitle = false,
    this.clearDirectory = false,
    this.clearTitle = false,
  });

  /// Expected current broker revision.
  final int expectedRevision;
  final String? text;
  final int? at;
  final ScheduleRepeat? repeat;
  final ScheduleCron? cron;
  final ScheduleRetryPolicy? retryPolicy;
  final String? timeZone;
  final String? sessionTitle;
  final String? directory;
  final String? title;
  final bool clearRepeat;
  final bool clearCron;
  final bool clearRetryPolicy;
  final bool clearTimeZone;
  final bool clearSessionTitle;
  final bool clearDirectory;
  final bool clearTitle;

  /// Encodes only fields selected by the caller.
  Map<String, dynamic> toJson() => {
    'expectedRevision': expectedRevision,
    if (text != null) 'text': text,
    if (at != null) 'at': at,
    if (repeat != null || clearRepeat) 'repeat': repeat?.wireValue,
    if (cron != null || clearCron) 'cron': cron?.toJson(),
    if (retryPolicy != null || clearRetryPolicy)
      'retryPolicy': retryPolicy?.toJson(),
    if (timeZone != null || clearTimeZone) 'timeZone': timeZone,
    if (sessionTitle != null || clearSessionTitle) 'sessionTitle': sessionTitle,
    if (directory != null || clearDirectory) 'directory': directory,
    if (title != null || clearTitle) 'title': title,
  };
}

/// Broker-owned schedule lifecycle action.
enum ScheduleAction {
  pause('pause'),
  resume('resume'),
  runNow('run-now'),
  recoverQuota('recover-quota');

  const ScheduleAction(this.wireValue);

  /// Broker wire value.
  final String wireValue;
}

/// Revision-checked schedule action request.
final class ScheduleActionRequest {
  /// Creates an action request.
  const ScheduleActionRequest({
    required this.action,
    required this.expectedRevision,
  });

  final ScheduleAction action;
  final int expectedRevision;

  /// Encodes the action request.
  Map<String, dynamic> toJson() => {
    'action': action.wireValue,
    'expectedRevision': expectedRevision,
  };
}

/// Response shared by PATCH and action routes.
final class ScheduleMutationResponse {
  /// Creates a mutation response.
  const ScheduleMutationResponse({required this.schedule});

  /// Decodes a mutation response.
  factory ScheduleMutationResponse.fromJson(Map<String, dynamic> json) {
    _requireOk(json);
    return ScheduleMutationResponse(
      schedule: ScheduleRecord.fromJson(
        _requiredMap(json['schedule'], 'schedule'),
      ),
    );
  }

  final ScheduleRecord schedule;

  /// Encodes the response.
  Map<String, dynamic> toJson() => {
    'ok': true,
    'schedule': schedule.toJson(),
  };
}

/// Response from `GET /api/schedules`.
final class ScheduleListResponse {
  /// Creates a list response.
  const ScheduleListResponse({required this.schedules});

  /// Decodes a checked list response.
  factory ScheduleListResponse.fromJson(Map<String, dynamic> json) {
    _requireOk(json);
    final raw = json['schedules'];
    if (raw is! List<dynamic>) {
      throw const FormatException('schedules must be a list');
    }
    return ScheduleListResponse(
      schedules: raw
          .map(
            (value) => ScheduleRecord.fromJson(
              _requiredMap(value, 'schedule'),
            ),
          )
          .toList(growable: false),
    );
  }

  /// Broker-ordered schedule rows.
  final List<ScheduleRecord> schedules;

  /// Encodes the response.
  Map<String, dynamic> toJson() => <String, dynamic>{
    'ok': true,
    'schedules': schedules.map((value) => value.toJson()).toList(),
  };
}

/// Response from `POST /api/schedules`.
final class ScheduleCreateResponse {
  /// Creates a create response.
  const ScheduleCreateResponse({required this.schedule});

  /// Decodes a checked create response.
  factory ScheduleCreateResponse.fromJson(Map<String, dynamic> json) {
    _requireOk(json);
    return ScheduleCreateResponse(
      schedule: ScheduleRecord.fromJson(
        _requiredMap(json['schedule'], 'schedule'),
      ),
    );
  }

  /// Created schedule row.
  final ScheduleRecord schedule;

  /// Encodes the response.
  Map<String, dynamic> toJson() => <String, dynamic>{
    'ok': true,
    'schedule': schedule.toJson(),
  };
}

/// Response from `DELETE /api/schedules/:id`.
sealed class ScheduleDeleteResponse {
  /// Creates a delete response.
  const ScheduleDeleteResponse();

  /// Decodes cancel-versus-remove behavior.
  factory ScheduleDeleteResponse.fromJson(Map<String, dynamic> json) {
    _requireOk(json);
    if (json['removed'] == true) {
      return const ScheduleRemovedResponse();
    }
    final rawSchedule = json['schedule'];
    if (rawSchedule is Map<String, dynamic>) {
      return ScheduleCanceledResponse(
        schedule: ScheduleRecord.fromJson(rawSchedule),
      );
    }
    throw const FormatException(
      'schedule delete response must contain schedule or removed',
    );
  }

  /// Encodes the response.
  Map<String, dynamic> toJson();
}

/// First DELETE canceled a live row.
final class ScheduleCanceledResponse extends ScheduleDeleteResponse {
  /// Creates a cancel response.
  const ScheduleCanceledResponse({required this.schedule});

  /// Canceled row retained by the broker.
  final ScheduleRecord schedule;

  @override
  Map<String, dynamic> toJson() => <String, dynamic>{
    'ok': true,
    'schedule': schedule.toJson(),
  };
}

/// DELETE removed a terminal row.
final class ScheduleRemovedResponse extends ScheduleDeleteResponse {
  /// Creates a remove response.
  const ScheduleRemovedResponse();

  @override
  Map<String, dynamic> toJson() => const <String, dynamic>{
    'ok': true,
    'removed': true,
  };
}

void _requireOk(Map<String, dynamic> json) {
  if (json['ok'] != true) {
    throw const FormatException('schedule response must contain ok: true');
  }
}

Map<String, dynamic> _requiredMap(Object? value, String field) {
  if (value is Map<String, dynamic>) return value;
  throw FormatException('$field must be an object');
}

String _requiredString(
  Map<String, dynamic> json,
  String field, {
  bool allowEmpty = false,
}) {
  final value = json[field];
  if (value is String && (allowEmpty || value.isNotEmpty)) return value;
  throw FormatException('$field must be a string');
}

String? _optionalString(Object? value) => value is String ? value : null;

int _requiredInt(Map<String, dynamic> json, String field) {
  final value = json[field];
  if (value is num && value.isFinite) return value.toInt();
  throw FormatException('$field must be a finite number');
}

int? _optionalInt(Object? value) {
  return value is num && value.isFinite ? value.toInt() : null;
}
