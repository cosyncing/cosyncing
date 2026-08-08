/// Durable events emitted from the broker attention inbox.
///
/// The broker contract intentionally leaves the event kind open so old clients
/// can preserve unknown kinds safely. This codec therefore does not use an
/// exhaustive enum for kinds or actions.
library;

/// Known attention kinds used by the current contract.
///
/// New kinds are not rejected; they are parsed as opaque strings in
/// the raw kind field and rendered via generic fallbacks.
const Set<String> knownAttentionEventKinds = <String>{
  'permission-required',
  'question-required',
  'goal-finished',
  'run-finished',
  'run-failed',
  'runtime-update-ready',
  'sync-degraded',
  'device-paired',
  'security-alert',
  'usage-threshold',
  'broker-health',
  'scheduled-send',
  'scheduled-send-failed',
};

/// Known action kinds used by the current contract.
///
/// New action kinds are tolerated in [AttentionEventAction.kind].
const Set<String> knownAttentionActionKinds = <String>{
  'open-session',
  'open-runtime-settings',
  'open-attention-inbox',
  'open-quota-settings',
  'open-broker-health',
};

/// Action payload for an attention event.
class AttentionEventAction {
  /// Creates an [AttentionEventAction].
  const AttentionEventAction({
    required this.kind,
    this.tool,
    this.sessionId,
    this.agent,
    this.raw,
  });

  /// Creates an [AttentionEventAction] from JSON.
  ///
  /// Unknown action kinds and future payload shapes are preserved in [raw] so
  /// they can round-trip without loss.
  factory AttentionEventAction.fromJson(Map<String, dynamic> json) {
    return AttentionEventAction(
      kind: json['kind'] as String? ?? 'open-attention-inbox',
      tool: json['tool'] as String?,
      sessionId: json['sessionId'] as String?,
      agent: json['agent'] as String?,
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// Raw action kind.
  final String kind;

  /// Session-aware action target (`open-session`).
  final String? tool;

  /// Session-aware action target (`open-session`).
  final String? sessionId;

  /// Runtime settings action target (`open-runtime-settings`).
  final String? agent;

  /// Full raw action payload for forward-compatible fields.
  final Map<String, dynamic>? raw;

  /// `kind == 'open-session'`.
  bool get isOpenSession => kind == 'open-session';

  /// `kind == 'open-runtime-settings'`.
  bool get isOpenRuntimeSettings => kind == 'open-runtime-settings';

  /// `kind == 'open-attention-inbox'`.
  bool get isOpenAttentionInbox => kind == 'open-attention-inbox';

  /// `kind == 'open-quota-settings'`.
  bool get isOpenQuotaSettings => kind == 'open-quota-settings';

  /// `kind == 'open-broker-health'`.
  bool get isOpenBrokerHealth => kind == 'open-broker-health';

  /// `true` when this action kind is recognized by the current client.
  bool get isKnownKind => knownAttentionActionKinds.contains(kind);

  /// Converts this [AttentionEventAction] to JSON.
  Map<String, dynamic> toJson() {
    final output = raw != null
        ? Map<String, dynamic>.of(raw!)
        : <String, dynamic>{};
    output['kind'] = kind;
    if (tool != null) output['tool'] = tool;
    if (sessionId != null) output['sessionId'] = sessionId;
    if (agent != null) output['agent'] = agent;
    return output;
  }
}

/// A single attention event delivered by `/api/attention-events`.
class AttentionEvent {
  /// Creates an [AttentionEvent].
  const AttentionEvent({
    required this.id,
    required this.cursor,
    required this.revision,
    required this.presentationRevision,
    required this.kind,
    required this.state,
    required this.severity,
    required this.dedupeKey,
    required this.createdAt,
    required this.updatedAt,
    required this.title,
    required this.action,
    this.presentationStage,
    this.resolvedAt,
    this.agent,
    this.sessionId,
    this.sessionTitle,
    this.requestId,
    this.turnId,
    this.goalKey,
    this.summary,
    this.raw = const <String, dynamic>{},
  });

  /// Creates an [AttentionEvent] from JSON.
  factory AttentionEvent.fromJson(Map<String, dynamic> json) {
    final rawAction = json['action'];
    return AttentionEvent(
      id: json['id'] as String? ?? '',
      cursor: (json['cursor'] as num?)?.toInt() ?? 0,
      revision: (json['revision'] as num?)?.toInt() ?? 0,
      presentationRevision:
          (json['presentationRevision'] as num?)?.toInt() ?? 0,
      presentationStage: json['presentationStage'] as String?,
      kind: json['kind'] as String? ?? 'unknown',
      state: json['state'] as String? ?? 'active',
      severity: json['severity'] as String? ?? 'informational',
      dedupeKey: json['dedupeKey'] as String? ?? '',
      createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      resolvedAt: (json['resolvedAt'] as num?)?.toInt(),
      agent: json['agent'] as String?,
      sessionId: json['sessionId'] as String?,
      sessionTitle: json['sessionTitle'] as String?,
      requestId: json['requestId'] as String?,
      turnId: json['turnId'] as String?,
      goalKey: json['goalKey'] as String?,
      title: json['title'] as String? ?? '',
      summary: json['summary'] as String?,
      action: rawAction is Map<String, dynamic>
          ? AttentionEventAction.fromJson(rawAction)
          : const AttentionEventAction(kind: 'open-attention-inbox'),
      raw: Map<String, dynamic>.of(json),
    );
  }

  /// The stable event id in the current broker.
  final String id;

  /// Cursor returned by attention store; for polling with `after`.
  final int cursor;

  /// Event revision (version history).
  final int revision;

  /// Last rendered presentation revision.
  final int presentationRevision;

  /// Current reminder stage (free-form in broker).
  final String? presentationStage;

  /// Stringly-typed kind, preserving unknown future kinds.
  final String kind;

  /// Event lifecycle state.
  final String state;

  /// Event severity.
  final String severity;

  /// Deduplication key for idempotent upstream churn control.
  final String dedupeKey;

  /// Epoch millis when created.
  final int createdAt;

  /// Epoch millis when last updated.
  final int updatedAt;

  /// Epoch millis when resolved.
  final int? resolvedAt;

  /// Optional agent scope.
  final String? agent;

  /// Optional session scope.
  final String? sessionId;

  /// Display-only session name captured when the broker created the event.
  final String? sessionTitle;

  /// Optional request id scope.
  final String? requestId;

  /// Optional turn id scope.
  final String? turnId;

  /// Optional goal key scope.
  final String? goalKey;

  /// Event headline.
  final String title;

  /// Optional event details.
  final String? summary;

  /// Navigation/action payload.
  final AttentionEventAction action;

  /// Raw JSON payload for forward-compatible fields.
  final Map<String, dynamic> raw;

  /// `kind == 'permission-required'`.
  bool get isPermissionRequired => kind == 'permission-required';

  /// `kind == 'question-required'`.
  bool get isQuestionRequired => kind == 'question-required';

  /// `kind == 'goal-finished'`.
  bool get isGoalFinished => kind == 'goal-finished';

  /// `kind == 'run-finished'`.
  bool get isRunFinished => kind == 'run-finished';

  /// `kind == 'run-failed'`.
  bool get isRunFailed => kind == 'run-failed';

  /// `kind == 'runtime-update-ready'`.
  bool get isRuntimeUpdateReady => kind == 'runtime-update-ready';

  /// `kind == 'sync-degraded'`.
  bool get isSyncDegraded => kind == 'sync-degraded';

  /// `kind == 'device-paired'`.
  bool get isDevicePaired => kind == 'device-paired';

  /// Whether this event reports a broker/device security incident.
  bool get isSecurityAlert => kind == 'security-alert';

  /// `kind == 'usage-threshold'`.
  bool get isUsageThreshold => kind == 'usage-threshold';

  /// `kind == 'broker-health'`.
  bool get isBrokerHealth => kind == 'broker-health';

  /// A scheduled prompt reached its target session.
  bool get isScheduledSend => kind == 'scheduled-send';

  /// A scheduled prompt failed or missed its occurrence.
  bool get isScheduledSendFailed => kind == 'scheduled-send-failed';

  /// `true` when this kind is a known client-supported value.
  bool get isKnownKind => knownAttentionEventKinds.contains(kind);

  /// Converts this [AttentionEvent] to JSON.
  ///
  /// `ok` wrappers and omitted optional values from the broker are not emitted.
  Map<String, dynamic> toJson() {
    final output = Map<String, dynamic>.of(raw)
      ..remove('ok')
      ..['id'] = id
      ..['cursor'] = cursor
      ..['revision'] = revision
      ..['presentationRevision'] = presentationRevision
      ..['kind'] = kind
      ..['state'] = state
      ..['severity'] = severity
      ..['dedupeKey'] = dedupeKey
      ..['createdAt'] = createdAt
      ..['updatedAt'] = updatedAt
      ..['title'] = title
      ..['action'] = action.toJson();

    if (presentationStage == null) {
      output.remove('presentationStage');
    } else {
      output['presentationStage'] = presentationStage;
    }
    if (resolvedAt == null) {
      output.remove('resolvedAt');
    } else {
      output['resolvedAt'] = resolvedAt;
    }
    if (agent == null) {
      output.remove('agent');
    } else {
      output['agent'] = agent;
    }
    if (sessionId == null) {
      output.remove('sessionId');
    } else {
      output['sessionId'] = sessionId;
    }
    if (sessionTitle == null) {
      output.remove('sessionTitle');
    } else {
      output['sessionTitle'] = sessionTitle;
    }
    if (requestId == null) {
      output.remove('requestId');
    } else {
      output['requestId'] = requestId;
    }
    if (turnId == null) {
      output.remove('turnId');
    } else {
      output['turnId'] = turnId;
    }
    if (goalKey == null) {
      output.remove('goalKey');
    } else {
      output['goalKey'] = goalKey;
    }
    if (summary == null) {
      output.remove('summary');
    } else {
      output['summary'] = summary;
    }
    return output;
  }
}

/// A single attention event as seen by a specific client.
class AttentionEventView extends AttentionEvent {
  /// Creates an [AttentionEventView].
  const AttentionEventView({
    required super.id,
    required super.cursor,
    required super.revision,
    required super.presentationRevision,
    required super.kind,
    required super.state,
    required super.severity,
    required super.dedupeKey,
    required super.createdAt,
    required super.updatedAt,
    required super.title,
    required super.action,
    super.presentationStage,
    super.resolvedAt,
    super.agent,
    super.sessionId,
    super.sessionTitle,
    super.requestId,
    super.turnId,
    super.goalKey,
    super.summary,
    super.raw,
    this.readAt,
    this.dismissedAt,
    this.historicalBaseline = false,
  });

  /// Creates an [AttentionEventView] from JSON.
  factory AttentionEventView.fromJson(Map<String, dynamic> json) {
    final event = AttentionEvent.fromJson(json);
    return AttentionEventView(
      id: event.id,
      cursor: event.cursor,
      revision: event.revision,
      presentationRevision: event.presentationRevision,
      presentationStage: event.presentationStage,
      kind: event.kind,
      state: event.state,
      severity: event.severity,
      dedupeKey: event.dedupeKey,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      resolvedAt: event.resolvedAt,
      agent: event.agent,
      sessionId: event.sessionId,
      sessionTitle: event.sessionTitle,
      requestId: event.requestId,
      turnId: event.turnId,
      goalKey: event.goalKey,
      title: event.title,
      summary: event.summary,
      action: event.action,
      raw: event.raw,
      readAt: (json['readAt'] as num?)?.toInt(),
      dismissedAt: (json['dismissedAt'] as num?)?.toInt(),
    );
  }

  /// Epoch millis at which this event became read for the client.
  final int? readAt;

  /// Epoch millis at which this event was dismissed by the client.
  final int? dismissedAt;

  /// Whether this row is part of the first synced historical baseline.
  final bool historicalBaseline;

  /// Converts this [AttentionEventView] to JSON.
  @override
  Map<String, dynamic> toJson() {
    final output = super.toJson();
    if (readAt == null) {
      output.remove('readAt');
    } else {
      output['readAt'] = readAt;
    }
    if (dismissedAt == null) {
      output.remove('dismissedAt');
    } else {
      output['dismissedAt'] = dismissedAt;
    }
    return output;
  }
}

/// Bounded attention feed page.
class AttentionEventsPage {
  /// Creates an [AttentionEventsPage].
  const AttentionEventsPage({
    required this.events,
    required this.cursor,
    required this.reset,
    required this.hasMore,
    this.baselineThroughCursor,
  });

  /// Creates an [AttentionEventsPage] from JSON.
  factory AttentionEventsPage.fromJson(Map<String, dynamic> json) {
    final rawEvents = json['events'];
    final events = rawEvents is List<dynamic>
        ? rawEvents
              .whereType<Map<String, dynamic>>()
              .map(AttentionEventView.fromJson)
              .toList()
        : <AttentionEventView>[];
    return AttentionEventsPage(
      events: events,
      cursor: (json['cursor'] as num?)?.toInt() ?? 0,
      reset: json['reset'] as bool? ?? false,
      hasMore: json['hasMore'] as bool? ?? false,
      baselineThroughCursor: (json['baselineThroughCursor'] as num?)?.toInt(),
    );
  }

  /// Page events.
  final List<AttentionEventView> events;

  /// Opaque cursor cursor for `/api/attention-events?after=...`.
  final int cursor;

  /// Whether the page is invalid due restart/gap and should trigger a reset.
  final bool reset;

  /// Whether more events are available beyond this page.
  final bool hasMore;

  /// Broker-provided first-catchup history cursor floor.
  ///
  /// Null for older clients/brokers and when the first boundary has not been
  /// reported yet.
  final int? baselineThroughCursor;

  /// Converts this page to JSON.
  Map<String, dynamic> toJson() {
    final payload = <String, dynamic>{
      'events': events.map((event) => event.toJson()).toList(),
      'cursor': cursor,
      'reset': reset,
      'hasMore': hasMore,
    };
    if (baselineThroughCursor != null) {
      payload['baselineThroughCursor'] = baselineThroughCursor;
    }
    return payload;
  }
}

/// Hard cap for one exact-snapshot bulk dismissal request.
const int attentionBulkDismissMax = 2000;

/// One exact event revision captured from a successfully loaded inbox.
final class AttentionBulkDismissItem {
  /// Creates an exact event revision identity.
  const AttentionBulkDismissItem({
    required this.eventId,
    required this.revision,
  });

  /// Parses an exact event revision identity.
  factory AttentionBulkDismissItem.fromJson(Map<String, dynamic> json) {
    return AttentionBulkDismissItem(
      eventId: json['eventId'] as String? ?? '',
      revision: (json['revision'] as num?)?.toInt() ?? 0,
    );
  }

  /// Stable broker event id.
  final String eventId;

  /// Exact broker event revision.
  final int revision;

  /// Converts this identity to JSON.
  Map<String, dynamic> toJson() => {
    'eventId': eventId,
    'revision': revision,
  };
}

/// One exact event revision accepted by a bulk dismissal.
final class AttentionBulkDismissAccepted extends AttentionBulkDismissItem {
  /// Creates an accepted result.
  const AttentionBulkDismissAccepted({
    required super.eventId,
    required super.revision,
    required this.dismissedAt,
  });

  /// Parses an accepted result.
  factory AttentionBulkDismissAccepted.fromJson(Map<String, dynamic> json) {
    final item = AttentionBulkDismissItem.fromJson(json);
    return AttentionBulkDismissAccepted(
      eventId: item.eventId,
      revision: item.revision,
      dismissedAt: (json['dismissedAt'] as num?)?.toInt() ?? 0,
    );
  }

  /// Broker dismissal time in epoch milliseconds.
  final int dismissedAt;

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'dismissedAt': dismissedAt,
  };
}

/// One requested revision refused because the broker event is newer.
final class AttentionBulkDismissStale extends AttentionBulkDismissItem {
  /// Creates a stale result.
  const AttentionBulkDismissStale({
    required super.eventId,
    required super.revision,
    required this.currentRevision,
  });

  /// Parses a stale result.
  factory AttentionBulkDismissStale.fromJson(Map<String, dynamic> json) {
    final item = AttentionBulkDismissItem.fromJson(json);
    return AttentionBulkDismissStale(
      eventId: item.eventId,
      revision: item.revision,
      currentRevision: (json['currentRevision'] as num?)?.toInt() ?? 0,
    );
  }

  /// Current broker event revision.
  final int currentRevision;

  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'currentRevision': currentRevision,
  };
}

/// Structured, idempotent bulk dismissal result.
final class AttentionBulkDismissResponse {
  /// Creates a bulk dismissal response.
  const AttentionBulkDismissResponse({
    required this.accepted,
    required this.stale,
    required this.notFound,
  });

  /// Parses a bulk dismissal response.
  factory AttentionBulkDismissResponse.fromJson(Map<String, dynamic> json) {
    List<T> parse<T>(
      Object? value,
      T Function(Map<String, dynamic>) fromJson,
    ) {
      return value is List<dynamic>
          ? value
                .whereType<Map<String, dynamic>>()
                .map(fromJson)
                .toList(growable: false)
          : <T>[];
    }

    return AttentionBulkDismissResponse(
      accepted: parse(
        json['accepted'],
        AttentionBulkDismissAccepted.fromJson,
      ),
      stale: parse(json['stale'], AttentionBulkDismissStale.fromJson),
      notFound: parse(
        json['notFound'],
        AttentionBulkDismissItem.fromJson,
      ),
    );
  }

  /// Exact revisions accepted by the broker.
  final List<AttentionBulkDismissAccepted> accepted;

  /// Exact revisions refused because their event moved forward.
  final List<AttentionBulkDismissStale> stale;

  /// Event identities no longer retained by the broker.
  final List<AttentionBulkDismissItem> notFound;
}
