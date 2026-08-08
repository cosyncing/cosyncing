import 'dart:async';
import 'dart:ui' as ui;

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/view/attention_event_copy.dart';
import 'package:flutter/foundation.dart';

/// Matches event metadata for foreground run-failed suppression.
typedef AttentionFeedRunFailureFocusMatcher =
    bool Function({
      required String? tool,
      required String? agent,
      required String? sessionId,
    });

/// Handles foreground rendering for eligible events.
typedef AttentionFeedForegroundHandler =
    Future<void> Function(
      AttentionEventView event,
    );

/// Answers whether this processor still owns its exact attention source.
typedef AttentionDeliveryAdmission = FutureOr<bool> Function();

/// Stable local-notification id for one durable event presentation.
String attentionNotificationId({
  required String brokerProfileId,
  required String eventId,
  String? dedupeKey,
  int? presentationRevision,
}) {
  final normalizedDedupeKey = dedupeKey?.trim();
  final baseId = normalizedDedupeKey != null && normalizedDedupeKey.isNotEmpty
      ? brokerAttentionNotificationId(
          brokerProfileId: brokerProfileId,
          dedupeKey: normalizedDedupeKey,
        )
      : 'attention:$brokerProfileId:$eventId';
  final revision = presentationRevision;
  if (revision != null && revision > 1) {
    return '$baseId:presentation:$revision';
  }
  return baseId;
}

/// Exact current notification identity plus pre-F4b aliases for one event.
Set<String> attentionNotificationIdsForEvent({
  required String brokerProfileId,
  required AttentionEvent event,
}) {
  final dedupeKey = attentionNotificationCoalescingKey(event);
  return {
    attentionNotificationId(
      brokerProfileId: brokerProfileId,
      eventId: event.id,
      dedupeKey: dedupeKey,
      presentationRevision: event.presentationRevision,
    ),
    attentionNotificationId(
      brokerProfileId: brokerProfileId,
      eventId: event.id,
      dedupeKey: dedupeKey,
    ),
    if (dedupeKey != null)
      attentionNotificationId(
        brokerProfileId: brokerProfileId,
        eventId: event.id,
      ),
  };
}

/// Broker semantic identity used only where the legacy live policy can
/// present the same durable event during feed support discovery.
String? attentionNotificationCoalescingKey(AttentionEvent event) {
  if (!event.isPermissionRequired && !event.isQuestionRequired) return null;
  final key = event.dedupeKey.trim();
  return key.isEmpty ? null : key;
}

/// Reconciles persisted attention events into durable mutations and
/// presentations.
class AttentionFeedDeliveryProcessor {
  /// Creates a reconciler for one broker profile.
  AttentionFeedDeliveryProcessor({
    required this.repository,
    required this.brokerProfileId,
    required this.lifecycleMonitor,
    required this.notificationSink,
    required this.onForegroundEvent,
    String? brokerScopeKey,
    this.isCurrentSource = _alwaysCurrent,
    this.focusMatcher = _neverMatched,
    this.now,
    AppLocalizations? localizations,
  }) : brokerScopeKey = brokerScopeKey ?? brokerProfileId,
       localizations =
           localizations ??
           lookupAppLocalizations(
             ui.PlatformDispatcher.instance.locale,
           );

  /// Repository for durable attention state.
  final AttentionRepository repository;

  /// Broker profile owning this reconciler.
  final String brokerProfileId;

  /// Exact durable source key owning event state and mutation authority.
  final String brokerScopeKey;

  /// App lifecycle source for in-app banner delivery.
  final BrokerAppLifecycleMonitor lifecycleMonitor;

  /// Notification sink used for background presentation.
  final BrokerNotificationSink notificationSink;

  /// Foreground callback for eligible presentation events.
  final AttentionFeedForegroundHandler onForegroundEvent;

  /// Revalidates source ownership across every asynchronous reconciliation
  /// seam.
  final AttentionDeliveryAdmission isCurrentSource;

  /// Detects whether a failed run belongs to the currently focused session.
  final AttentionFeedRunFailureFocusMatcher focusMatcher;

  /// Deterministic clock for testability and payload metadata.
  final DateTime Function()? now;

  /// Locale snapshot used by background OS presentation.
  final AppLocalizations localizations;

  /// Reconciles pending ACK/DISMISS mutations and pending presentation events.
  Future<void> reconcile({
    required BrokerClient brokerClient,
    required String clientId,
  }) async {
    await _reconcileMutations(
      brokerClient: brokerClient,
      clientId: clientId,
    );
    if (!await _isAdmitted()) return;
    await _reconcilePresentations();
  }

  /// Reconciles only pending read/dismiss mutations.
  Future<int> reconcileMutations({
    required BrokerClient brokerClient,
    required String clientId,
  }) async {
    return _reconcileMutations(
      brokerClient: brokerClient,
      clientId: clientId,
    );
  }

  Future<int> _reconcileMutations({
    required BrokerClient brokerClient,
    required String clientId,
  }) async {
    final states = await repository.loadPendingMutations(brokerScopeKey);
    if (!await _isAdmitted()) return 0;

    for (final state in states) {
      if (!await _isAdmitted()) return 0;
      await _reconcileReadMutation(
        state: state,
        brokerClient: brokerClient,
        clientId: clientId,
      );
      if (state.localDismissedRevision == null) {
        if (!await _isAdmitted()) return 0;
        await _reconcileDismissMutation(
          state: state,
          brokerClient: brokerClient,
          clientId: clientId,
        );
      }
    }

    final bulkStates = states
        .where(
          (state) =>
              state.localDismissedAt != null &&
              state.localDismissedRevision != null &&
              (state.brokerDismissedAt == null ||
                  state.localDismissedAt! > state.brokerDismissedAt!),
        )
        .toList(growable: false);
    var releasedStale = 0;
    for (
      var offset = 0;
      offset < bulkStates.length;
      offset += attentionBulkDismissMax
    ) {
      if (!await _isAdmitted()) return releasedStale;
      final nextOffset = offset + attentionBulkDismissMax;
      final end = nextOffset < bulkStates.length
          ? nextOffset
          : bulkStates.length;
      releasedStale += await _reconcileBulkDismissMutations(
        states: bulkStates.sublist(offset, end),
        brokerClient: brokerClient,
        clientId: clientId,
      );
    }
    return releasedStale;
  }

  Future<int> _reconcileBulkDismissMutations({
    required List<AttentionDeliveryState> states,
    required BrokerClient brokerClient,
    required String clientId,
  }) async {
    if (states.isEmpty) return 0;
    if (!await _isAdmitted()) return 0;
    try {
      final result = await brokerClient.dismissAttentionEvents(
        states
            .map(
              (state) => AttentionBulkDismissItem(
                eventId: state.event.id,
                revision: state.localDismissedRevision!,
              ),
            )
            .toList(growable: false),
        clientId: clientId,
      );
      if (!await _isAdmitted()) return 0;
      return repository.reconcileBulkDismissResult(
        brokerProfileId: brokerScopeKey,
        result: result,
      );
    } on Object {
      // Keep revision-scoped local dismissals persistent and retry the bounded
      // profile batch on a future reconcile.
      return 0;
    }
  }

  Future<void> _reconcileReadMutation({
    required AttentionDeliveryState state,
    required BrokerClient brokerClient,
    required String clientId,
  }) async {
    final localReadAt = state.localReadAt;
    if (localReadAt == null) {
      return;
    }
    final brokerReadAt = state.brokerReadAt;
    if (brokerReadAt != null && localReadAt <= brokerReadAt) {
      return;
    }

    if (!await _isAdmitted()) return;
    try {
      await brokerClient.acknowledgeAttentionEvent(
        state.event.id,
        clientId: clientId,
      );
      if (!await _isAdmitted()) return;
      await repository.markBrokerReadSynced(
        brokerProfileId: brokerScopeKey,
        eventId: state.event.id,
        brokerReadAt: DateTime.fromMillisecondsSinceEpoch(localReadAt),
      );
    } on Object {
      // Keep local read state persistent and retry on a future reconcile.
    }
  }

  Future<void> _reconcileDismissMutation({
    required AttentionDeliveryState state,
    required BrokerClient brokerClient,
    required String clientId,
  }) async {
    final localDismissedAt = state.localDismissedAt;
    if (localDismissedAt == null) {
      return;
    }
    final brokerDismissedAt = state.brokerDismissedAt;
    if (brokerDismissedAt != null && localDismissedAt <= brokerDismissedAt) {
      return;
    }

    if (!await _isAdmitted()) return;
    try {
      await brokerClient.dismissAttentionEvent(
        state.event.id,
        clientId: clientId,
      );
      if (!await _isAdmitted()) return;
      await repository.markBrokerDismissedSynced(
        brokerProfileId: brokerScopeKey,
        eventId: state.event.id,
        brokerDismissedAt: DateTime.fromMillisecondsSinceEpoch(
          localDismissedAt,
        ),
      );
    } on Object {
      // Keep local dismiss state persistent and retry on a future reconcile.
    }
  }

  Future<void> _reconcilePresentations() async {
    final states = await repository.loadPendingPresentations(brokerScopeKey);
    if (!await _isAdmitted()) return;
    for (final state in states) {
      if (!await _isAdmitted()) return;
      await _reconcilePresentation(state: state);
    }
  }

  Future<void> _reconcilePresentation({
    required AttentionDeliveryState state,
  }) async {
    final event = state.event;
    if (event.presentationRevision <= 0) {
      return;
    }
    if (state.localPresentedRevision >= event.presentationRevision) {
      return;
    }

    if (_shouldSuppressPresentation(state)) {
      if (!await _isAdmitted()) return;
      await repository.advancePresentedRevision(
        brokerProfileId: brokerScopeKey,
        eventId: event.id,
        presentedRevision: event.presentationRevision,
      );
      return;
    }

    try {
      if (!await _isAdmitted()) return;
      if (_isAppForeground) {
        if (_shouldSuppressTerminalRunInForeground(event)) {
          if (!await _isAdmitted()) return;
          await repository.advancePresentedRevision(
            brokerProfileId: brokerScopeKey,
            eventId: event.id,
            presentedRevision: event.presentationRevision,
          );
          return;
        }
        if (!await _isAdmitted()) return;
        await onForegroundEvent(event);
      } else {
        final request = _notificationRequest(event: event);
        if (!await _isAdmitted()) return;
        await _clearSupersededNotificationAliases(
          state: state,
          currentId: request.id,
        );
        if (!await _isAdmitted()) return;
        await notificationSink.show(request);
      }
      if (!await _isAdmitted()) return;
      await repository.advancePresentedRevision(
        brokerProfileId: brokerScopeKey,
        eventId: event.id,
        presentedRevision: event.presentationRevision,
      );
    } on Object {
      // Keep presentation pending until this method succeeds on a later
      // reconcile.
    }
  }

  bool _shouldSuppressPresentation(AttentionDeliveryState state) {
    final event = state.event;
    if (state.localPresentedRevision >= event.presentationRevision) {
      return false;
    }
    if (event.dismissedAt != null) {
      return true;
    }
    // A successful scheduled send is intentionally a quiet durable inbox row.
    // Advancing its revision prevents both foreground banners and background
    // OS notifications while retaining the broker event for history.
    if (event.isScheduledSend) {
      return true;
    }
    return false;
  }

  /// Whether this TERMINAL run event is already visible to the user (F4c).
  ///
  /// A completion banner is a way of saying "something finished somewhere
  /// else". When the exact profile/tool/session it describes is the Session
  /// Detail on screen, the user is already watching that turn end — the
  /// transcript grows its terminal footer and the header returns to Idle in the
  /// same moment — so the banner is a duplicate of what they can see.
  ///
  /// Deliberately narrow. Only `run-failed` (the pre-existing rule) and
  /// `run-finished` are covered; permission/question (Needs input) always
  /// presents, another profile/tool/session always presents, and background
  /// OS delivery is untouched because this is only consulted in the foreground.
  ///
  /// Suppression still ADVANCES the presentation revision at the call site, so
  /// the durable inbox row, the unread badge, and the broker event are all
  /// retained — and a later reconnect or replay of the same revision cannot
  /// resurrect the banner after the user has navigated away.
  bool _shouldSuppressTerminalRunInForeground(AttentionEventView event) {
    if (!_isAppForeground) return false;
    if (!event.isRunFailed && !event.isRunFinished) return false;

    return focusMatcher(
      tool: event.action.tool,
      agent: event.action.agent ?? event.agent,
      sessionId: event.action.sessionId ?? event.sessionId,
    );
  }

  bool get _isAppForeground =>
      lifecycleMonitor.currentState == BrokerAppLifecycleState.resumed;

  Future<void> _clearSupersededNotificationAliases({
    required AttentionDeliveryState state,
    required String currentId,
  }) async {
    final event = state.event;
    final dedupeKey = attentionNotificationCoalescingKey(event);
    final aliases = <String>{
      attentionNotificationId(
        brokerProfileId: brokerProfileId,
        eventId: event.id,
        dedupeKey: dedupeKey,
      ),
      if (dedupeKey != null)
        attentionNotificationId(
          brokerProfileId: brokerProfileId,
          eventId: event.id,
        ),
      if (state.localPresentedRevision > 0)
        attentionNotificationId(
          brokerProfileId: brokerProfileId,
          eventId: event.id,
          dedupeKey: dedupeKey,
          presentationRevision: state.localPresentedRevision,
        ),
    }..remove(currentId);
    if (aliases.isEmpty) return;
    if (!await _isAdmitted()) return;
    try {
      await notificationSink.clearMany(aliases);
    } on Object {
      // Upgrade/previous-presentation cleanup is best-effort. The
      // revision-qualified current id still preserves Clear-all isolation.
    }
  }

  Future<bool> _isAdmitted() async {
    try {
      return await isCurrentSource();
    } on Object {
      return false;
    }
  }

  BrokerNotificationRequest _notificationRequest({
    required AttentionEventView event,
  }) {
    final mapping = _mappingFor(event);
    return BrokerNotificationRequest(
      id: _notificationId(event),
      title: mapping.title,
      body: mapping.body,
      category: mapping.category,
      importance: mapping.importance,
      payload: _notificationPayload(
        eventId: event.id,
        event: event,
      ),
      createdAt: now?.call() ?? DateTime.now(),
    );
  }

  String _notificationId(AttentionEventView event) {
    return attentionNotificationId(
      brokerProfileId: brokerProfileId,
      eventId: event.id,
      dedupeKey: attentionNotificationCoalescingKey(event),
      presentationRevision: event.presentationRevision,
    );
  }

  Map<String, Object?> _notificationPayload({
    required String eventId,
    required AttentionEventView event,
  }) {
    return {
      'kind': 'attention-event',
      'brokerProfileId': brokerProfileId,
      'brokerScopeKey': brokerScopeKey,
      'eventId': eventId,
      'eventKind': event.kind,
      'attentionDedupeKey': event.dedupeKey,
      'tool': event.action.tool,
      'sessionId': event.action.sessionId,
      'agent': event.action.agent,
      'requestId': event.requestId,
      'turnId': event.turnId,
      'actionKind': event.action.kind,
    };
  }

  _AttentionFeedPresentationMapping _mappingFor(AttentionEventView event) {
    final sessionMapping = _sessionMappingFor(event);
    if (sessionMapping != null) return sessionMapping;
    if (event.isPermissionRequired || event.isQuestionRequired) {
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationSessionActionTitle,
        body: localizations.notificationSessionActionBody,
        category: BrokerNotificationCategory.actionRequired,
        importance: BrokerNotificationImportance.high,
      );
    }
    if (event.isRunFailed) {
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationRunFailedTitle,
        body: localizations.notificationRunFailedBody,
        category: BrokerNotificationCategory.error,
        importance: BrokerNotificationImportance.high,
      );
    }
    if (event.isScheduledSendFailed) {
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationScheduledFailedTitle,
        body: localizations.notificationScheduledFailedBody,
        category: BrokerNotificationCategory.actionRequired,
        importance: BrokerNotificationImportance.high,
      );
    }
    if (event.isSecurityAlert) {
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationSecurityTitle,
        body: localizations.notificationSecurityBody,
        category: BrokerNotificationCategory.actionRequired,
        importance: BrokerNotificationImportance.high,
      );
    }
    if (event.isDevicePaired) {
      // Successful pairing is informational; access loss and auth incidents
      // use `security-alert`. See
      // docs/architecture/client-ui.md
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationDevicePairedTitle,
        body: localizations.notificationDevicePairedBody,
        category: BrokerNotificationCategory.info,
        importance: BrokerNotificationImportance.normal,
      );
    }
    if (event.isGoalFinished || event.isRunFinished) {
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationSessionStatusTitle,
        body: localizations.notificationSessionStatusBody,
        category: BrokerNotificationCategory.info,
        importance: BrokerNotificationImportance.normal,
      );
    }
    if (event.isBrokerHealth &&
        (event.severity == 'action-required' || event.severity == 'critical')) {
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationBrokerHealthTitle,
        body: localizations.notificationBrokerHealthBody,
        category: BrokerNotificationCategory.actionRequired,
        importance: BrokerNotificationImportance.high,
      );
    }
    if (event.isRuntimeUpdateReady ||
        event.isSyncDegraded ||
        event.isUsageThreshold ||
        event.isBrokerHealth) {
      return _AttentionFeedPresentationMapping(
        title: localizations.notificationMaintenanceTitle,
        body: localizations.notificationMaintenanceBody,
        category: BrokerNotificationCategory.maintenance,
        importance: BrokerNotificationImportance.normal,
      );
    }

    return _AttentionFeedPresentationMapping(
      title: localizations.notificationGenericTitle,
      body: localizations.notificationGenericBody,
      category: BrokerNotificationCategory.info,
      importance: BrokerNotificationImportance.normal,
    );
  }

  _AttentionFeedPresentationMapping? _sessionMappingFor(
    AttentionEventView event,
  ) {
    final sessionId = event.action.sessionId ?? event.sessionId;
    if (sessionId == null || sessionId.trim().isEmpty) return null;
    final base = switch (event) {
      _ when event.isPermissionRequired || event.isQuestionRequired =>
        const _AttentionFeedPresentationMapping(
          title: '',
          body: '',
          category: BrokerNotificationCategory.actionRequired,
          importance: BrokerNotificationImportance.high,
        ),
      _ when event.isRunFailed => const _AttentionFeedPresentationMapping(
        title: '',
        body: '',
        category: BrokerNotificationCategory.error,
        importance: BrokerNotificationImportance.high,
      ),
      _ when event.isGoalFinished || event.isRunFinished =>
        const _AttentionFeedPresentationMapping(
          title: '',
          body: '',
          category: BrokerNotificationCategory.info,
          importance: BrokerNotificationImportance.normal,
        ),
      _ when event.isSyncDegraded => const _AttentionFeedPresentationMapping(
        title: '',
        body: '',
        category: BrokerNotificationCategory.maintenance,
        importance: BrokerNotificationImportance.normal,
      ),
      _ => null,
    };
    if (base == null) return null;
    return _AttentionFeedPresentationMapping(
      title: attentionSessionIdentity(event, localizations),
      body: attentionSessionEventTitle(event, localizations),
      category: base.category,
      importance: base.importance,
    );
  }
}

@immutable
class _AttentionFeedPresentationMapping {
  const _AttentionFeedPresentationMapping({
    required this.title,
    required this.body,
    required this.category,
    required this.importance,
  });

  /// Notification title.
  final String title;

  /// Notification body.
  final String body;

  /// Notification channel/category.
  final BrokerNotificationCategory category;

  /// Notification importance.
  final BrokerNotificationImportance importance;
}

bool _neverMatched({
  required String? tool,
  required String? agent,
  required String? sessionId,
}) {
  return false;
}

bool _alwaysCurrent() => true;
