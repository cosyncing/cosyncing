import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_presentation_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';

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

/// This device's effective setting for one notification type. On Android the
/// `enabled` flag comes from the type's system channel.
typedef AttentionNotificationSettingResolver =
    Future<AttentionNotificationTypeSetting> Function(
      AttentionNotificationType type,
    );

/// Observes every OS presentation attempt (Settings shows the last one).
typedef AttentionNotificationDeliveryObserver =
    void Function(
      AttentionNotificationType type,
      BrokerNotificationDeliveryResult result,
    );

/// Platform notification id for the slot [event] occupies, or null when the
/// event is never an OS notification.
///
/// A slot is per request, per session outcome, or per event (see
/// [attentionNotificationCollapseKey]), so presenting into it replaces what is
/// there and a reminder re-alerts in place.
String? attentionNotificationSlotId({
  required String brokerProfileId,
  required AttentionEvent event,
}) {
  final type = attentionNotificationTypeOf(event);
  if (type == null) return null;
  return brokerAttentionNotificationId(
    brokerProfileId: brokerProfileId,
    dedupeKey: attentionNotificationCollapseKey(event, type),
  );
}

/// Ids a client from before per-type notifications may have used for
/// [event]: one per presentation revision, keyed by the permission/question
/// dedupe key or the event id. Bounded to the latest revisions.
Set<String> legacyAttentionNotificationIds({
  required String brokerProfileId,
  required AttentionEvent event,
  int? presentedRevision,
}) {
  final key = event.isPermissionRequired || event.isQuestionRequired
      ? event.dedupeKey.trim()
      : '';
  final bases = {
    'attention:$brokerProfileId:${event.id}',
    if (key.isNotEmpty)
      brokerAttentionNotificationId(
        brokerProfileId: brokerProfileId,
        dedupeKey: key,
      ),
  };
  final newest = [
    event.presentationRevision,
    presentedRevision ?? 0,
  ].reduce((a, b) => a > b ? a : b);
  final oldest = newest - _legacyRevisionWindow + 1;
  return {
    for (final base in bases) ...{
      base,
      for (
        var revision = oldest < 2 ? 2 : oldest;
        revision <= newest;
        revision++
      )
        '$base:presentation:$revision',
    },
  };
}

const _legacyRevisionWindow = 16;

/// Every platform id that may be showing [event]: its current slot plus the
/// ids an older client used.
Set<String> attentionNotificationIdsForEvent({
  required String brokerProfileId,
  required AttentionEvent event,
}) {
  final slot = attentionNotificationSlotId(
    brokerProfileId: brokerProfileId,
    event: event,
  );
  return {
    ?slot,
    ...legacyAttentionNotificationIds(
      brokerProfileId: brokerProfileId,
      event: event,
    ),
  };
}

/// Ids to clear once [event] is read or dismissed: the ids an older client
/// used for it, plus its slot unless a newer, still-unhandled event has taken
/// that slot since — a later turn of the same session, or a reminder of the
/// same request. [current] is the profile's stored events.
Set<String> attentionNotificationIdsToClear({
  required String brokerProfileId,
  required AttentionEventView event,
  required Iterable<AttentionEventView> current,
}) {
  final legacy = legacyAttentionNotificationIds(
    brokerProfileId: brokerProfileId,
    event: event,
  );
  final type = attentionNotificationTypeOf(event);
  if (type == null) return legacy;
  final key = attentionNotificationCollapseKey(event, type);
  final slot = brokerAttentionNotificationId(
    brokerProfileId: brokerProfileId,
    dedupeKey: key,
  );
  for (final other in current) {
    final otherType = attentionNotificationTypeOf(other);
    if (otherType == null ||
        attentionNotificationCollapseKey(other, otherType) != key) {
      continue;
    }
    final supersedes = other.id == event.id
        ? other.presentationRevision > event.presentationRevision
        : other.createdAt > event.createdAt &&
              other.readAt == null &&
              other.dismissedAt == null;
    // A request's first legacy id is its slot id; leave that too.
    if (supersedes) return legacy..remove(slot);
  }
  return {...legacy, slot};
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
    this.resolveSetting = _defaultSetting,
    this.onDelivery,
    this.now,
    this.presentationCoordinator = const SingleWindowPresentationCoordinator(),
    AppLocalizations? localizations,
  }) : brokerScopeKey = brokerScopeKey ?? brokerProfileId,
       localizations = localizations ?? resolveAppLocalizations(null);

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

  /// This device's effective per-type setting.
  final AttentionNotificationSettingResolver resolveSetting;

  /// Observes OS presentation attempts.
  final AttentionNotificationDeliveryObserver? onDelivery;

  /// Deterministic clock for testability and payload metadata.
  final DateTime Function()? now;

  /// Keeps this device's windows from presenting one event twice.
  final AttentionPresentationCoordinator presentationCoordinator;

  /// Failed presentation attempts per event revision, bounded so a platform
  /// that keeps failing cannot pin an event pending forever.
  final Map<String, int> _failedAttempts = {};

  /// Open requests the OS refused to show because notifications were not
  /// allowed, kept for this process until shown or resolved. A reminder
  /// re-presents anything older.
  final Set<String> _permissionBlockedRequests = {};

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

  Future<void> _reconcilePresentations() =>
      presentationCoordinator.exclusive(brokerScopeKey, () async {
        // Loaded inside the exclusive section, so a window that waited sees
        // what the previous one presented.
        final states = await repository.loadPendingPresentations(
          brokerScopeKey,
        );
        if (!await _isAdmitted()) return;
        for (final state in states) {
          if (!await _isAdmitted()) return;
          await _reconcilePresentation(state: state);
        }
      });

  /// Presents again the open requests the OS refused while notifications were
  /// not allowed. Call it once permission is granted: a request still waits for
  /// its answer, while finished turns stay in the inbox, so a grant never
  /// releases a burst.
  Future<void> presentPermissionBlockedRequests() async {
    if (_permissionBlockedRequests.isEmpty) return;
    final ids = Set<String>.of(_permissionBlockedRequests);
    _permissionBlockedRequests.clear();
    await presentationCoordinator.exclusive(brokerScopeKey, () async {
      final states = await repository.loadDeliveryStates(brokerScopeKey);
      for (final state in states) {
        final event = state.event;
        if (!ids.contains(event.id) ||
            event.state != 'active' ||
            event.dismissedAt != null) {
          continue;
        }
        if (!await _isAdmitted()) return;
        await _reconcilePresentation(state: state, replay: true);
      }
    });
  }

  Future<void> _reconcilePresentation({
    required AttentionDeliveryState state,
    bool replay = false,
  }) async {
    final event = state.event;
    if (event.presentationRevision <= 0) {
      return;
    }
    if (!replay && state.localPresentedRevision >= event.presentationRevision) {
      return;
    }

    if (_shouldSuppressPresentation(state)) {
      await _advance(event);
      return;
    }

    final type = attentionNotificationTypeOf(event);
    // A request answered before this device presented it has nothing left to
    // ask; clear whatever an earlier revision left on screen instead.
    if (type != null && type.isRequest && event.state != 'active') {
      await _clearEvent(state);
      await _advance(event);
      return;
    }

    try {
      if (!await _isAdmitted()) return;
      final setting = type == null ? null : await resolveSetting(type);
      if (setting != null && !setting.enabled) {
        // Off in Settings (or its Android channel): the inbox keeps the row,
        // and neither a banner nor an OS notification appears.
        onDelivery?.call(
          type!,
          const BrokerNotificationDeliveryResult(
            BrokerNotificationDeliveryOutcome.blocked,
            reason: 'type-off',
          ),
        );
        await _advance(event);
        return;
      }
      if (_isAppForeground) {
        if (event.isSyncDegraded ||
            _shouldSuppressTerminalRunInForeground(event)) {
          await _advance(event);
          return;
        }
        if (!await _isAdmitted()) return;
        await onForegroundEvent(event);
      } else {
        if (type == null || setting == null) {
          // Never an OS notification (scheduled-send success, non-critical
          // health, sync-degraded, unknown kinds).
          await _advance(event);
          return;
        }
        if (await presentationCoordinator.anotherWindowInForeground()) {
          // Another window of this app is in front and shows the event
          // in-app. Leave it pending for that window.
          return;
        }
        final request = _notificationRequest(
          event: event,
          type: type,
          setting: setting,
        );
        if (!await _isAdmitted()) return;
        await _clearSupersededNotificationAliases(
          state: state,
          currentId: request.id,
        );
        if (!await _isAdmitted()) return;
        final result = await notificationSink.show(request);
        onDelivery?.call(type, result);
        if (type.isRequest && result.isPermissionRefusal) {
          _permissionBlockedRequests.add(event.id);
        } else {
          _permissionBlockedRequests.remove(event.id);
        }
        if (result.isRetryable && !_spendFailedAttempt(event)) return;
      }
      await _advance(event);
    } on Object {
      // Keep presentation pending until this method succeeds on a later
      // reconcile.
    }
  }

  /// Clears the OS notification of every request in [events] that is no
  /// longer active (answered anywhere, or its session ended).
  ///
  /// Called with each persisted feed page, so an answer given on another
  /// device, in the agent's terminal, or by the broker's session end removes
  /// the notification here without the user opening anything.
  Future<void> clearResolvedRequests(Iterable<AttentionEvent> events) async {
    final resolved = [
      for (final event in events)
        if (event.state != 'active' &&
            (attentionNotificationTypeOf(event)?.isRequest ?? false))
          event,
    ];
    _permissionBlockedRequests.removeAll(resolved.map((event) => event.id));
    final ids = <String>{
      for (final event in resolved)
        ...attentionNotificationIdsForEvent(
          brokerProfileId: brokerProfileId,
          event: event,
        ),
    };
    if (ids.isEmpty || !await _isAdmitted()) return;
    try {
      await notificationSink.clearMany(ids);
    } on Object {
      // Platform cleanup is best effort; the durable row is already resolved.
    }
  }

  /// Clears the OS notification of every event in [events] that another
  /// client has read or dismissed ([AttentionEvent.seenAt]) and this one has
  /// not handled, unless a newer event has taken its slot since.
  ///
  /// Requests are left alone: they clear when answered, and reading one
  /// elsewhere does not answer it.
  Future<void> clearSeenElsewhere(Iterable<AttentionEventView> events) async {
    final seen = [
      for (final event in events)
        if (_seenElsewhere(event)) event,
    ];
    if (seen.isEmpty || !await _isAdmitted()) return;
    final current = await repository.loadEvents(brokerScopeKey);
    final ids = <String>{
      for (final event in seen)
        ...attentionNotificationIdsToClear(
          brokerProfileId: brokerProfileId,
          event: event,
          current: current,
        ),
    };
    if (ids.isEmpty) return;
    try {
      await notificationSink.clearMany(ids);
    } on Object {
      // Best effort: the event is already handled on the other device.
    }
  }

  static bool _seenElsewhere(AttentionEventView event) {
    final type = attentionNotificationTypeOf(event);
    return event.seenAt != null &&
        event.readAt == null &&
        event.dismissedAt == null &&
        type != null &&
        !type.isRequest;
  }

  Future<void> _advance(AttentionEventView event) async {
    if (!await _isAdmitted()) return;
    _failedAttempts.remove(_attemptKey(event));
    await repository.advancePresentedRevision(
      brokerProfileId: brokerScopeKey,
      eventId: event.id,
      presentedRevision: event.presentationRevision,
    );
  }

  /// Records one failed attempt. Returns true once the budget is spent, so
  /// the caller stops retrying and advances.
  bool _spendFailedAttempt(AttentionEventView event) {
    final key = _attemptKey(event);
    final attempts = (_failedAttempts[key] ?? 0) + 1;
    _failedAttempts[key] = attempts;
    return attempts >= maxFailedPresentationAttempts;
  }

  static String _attemptKey(AttentionEventView event) =>
      '${event.id}#${event.presentationRevision}';

  /// Failed attempts before a presentation is abandoned.
  static const maxFailedPresentationAttempts = 3;

  Future<void> _clearEvent(AttentionDeliveryState state) async {
    if (state.localPresentedRevision <= 0) return;
    try {
      await notificationSink.clearMany(
        attentionNotificationIdsForEvent(
          brokerProfileId: brokerProfileId,
          event: state.event,
        ),
      );
    } on Object {
      // Best effort.
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
    // Already read or dismissed on another device before this one got to it.
    if (_seenElsewhere(event)) {
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
    // Only an event presented before (possibly by an older client, under a
    // per-revision id) can have something else on screen.
    if (state.localPresentedRevision <= 0) return;
    final aliases = legacyAttentionNotificationIds(
      brokerProfileId: brokerProfileId,
      event: state.event,
      presentedRevision: state.localPresentedRevision,
    )..remove(currentId);
    if (aliases.isEmpty) return;
    if (!await _isAdmitted()) return;
    try {
      await notificationSink.clearMany(aliases);
    } on Object {
      // Upgrade/previous-presentation cleanup is best-effort.
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
    required AttentionNotificationType type,
    required AttentionNotificationTypeSetting setting,
  }) {
    return BrokerNotificationRequest(
      id: attentionNotificationSlotId(
        brokerProfileId: brokerProfileId,
        event: event,
      )!,
      title: attentionNotificationTitle(type, localizations),
      body: setting.showSessionTitle ? _body(event) : '',
      channel: attentionNotificationChannel(type, localizations),
      playSound: setting.sound,
      threadKey: attentionNotificationThreadKey(event),
      alertKey: attentionNotificationAlertKey(
        eventId: event.id,
        revision: event.presentationRevision,
      ),
      payload: _notificationPayload(
        eventId: event.id,
        event: event,
      ),
      createdAt: now?.call() ?? DateTime.now(),
    );
  }

  /// The event's own title: the session title for a session event (an
  /// untitled session says so), otherwise the broker's event title.
  String _body(AttentionEventView event) {
    final sessionId = event.action.sessionId ?? event.sessionId;
    final isSessionEvent = sessionId != null && sessionId.trim().isNotEmpty;
    final title = isSessionEvent ? event.sessionTitle?.trim() : event.title;
    if (title == null || title.trim().isEmpty) {
      return isSessionEvent
          ? localizations.foregroundAttentionUntitledSession
          : '';
    }
    return truncateAttentionNotificationText(title);
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
}

Future<AttentionNotificationTypeSetting> _defaultSetting(
  AttentionNotificationType type,
) async => AttentionNotificationTypeSetting.defaultsFor(type);

bool _neverMatched({
  required String? tool,
  required String? agent,
  required String? sessionId,
}) {
  return false;
}

bool _alwaysCurrent() => true;
