import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_profile_sync_gate.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:dio/dio.dart';

/// Maximum batch size used by the attention worker when fetching the feed.
const int defaultAttentionFeedPageSize = 100;

/// Maximum long-poll wait used by the attention worker.
const Duration defaultAttentionFeedWait = Duration(seconds: 15);

/// Initial transient retry delay for fetch failures.
const Duration defaultAttentionFeedInitialRetryDelay = Duration(
  milliseconds: 250,
);

/// Maximum transient retry delay for fetch failures.
const Duration defaultAttentionFeedMaxRetryDelay = Duration(minutes: 1);

/// Returns whether the current UI state is the foreground target for a run
/// failure.
typedef AttentionFeedRunFailureFocusMatcher =
    bool Function({
      required String? tool,
      required String? agent,
      required String? sessionId,
    });

/// Handles foreground notification callbacks for eligible attention events.
typedef AttentionFeedForegroundHandler =
    Future<void> Function(
      AttentionEventView event,
    );

/// Feed capability state for compatibility fallback selection.
enum AttentionFeedSupportState {
  /// No request has proved support or lack of support yet.
  unknown,

  /// At least one attention page was fetched successfully.
  supported,

  /// The broker returned the dedicated old-broker 404 result.
  unsupported,
}

/// Observes a support-state transition.
typedef AttentionFeedSupportHandler =
    void Function(
      AttentionFeedSupportState state,
    );

/// Observes a page only after its events and cursor are durable.
typedef AttentionFeedPersistedHandler =
    Future<void> Function(
      AttentionEventsPage page,
    );

/// Abstraction for deterministic delay injection in tests.
typedef AttentionFeedDelay = Future<void> Function(Duration duration);

/// Pure notification policy for one broker profile's attention feed.
class AttentionFeedWorker implements AttentionFeedRunner {
  /// Creates a one-profile attention feed worker.
  AttentionFeedWorker({
    required this.brokerClient,
    required this.repository,
    required this.brokerProfileId,
    required this.clientId,
    required this.lifecycleMonitor,
    required this.notificationSink,
    required this.onForegroundEvent,
    String? brokerScopeKey,
    this.pageSize = defaultAttentionFeedPageSize,
    this.longPollWait = defaultAttentionFeedWait,
    this.initialRetryDelay = defaultAttentionFeedInitialRetryDelay,
    this.maxRetryDelay = defaultAttentionFeedMaxRetryDelay,
    this.now,
    this.sleep = Future<void>.delayed,
    this.focusMatcher = _noForegroundFocus,
    this.onSupportChanged,
    this.onPagePersisted,
    this.localizations,
    AttentionProfileSyncGate? profileSyncGate,
  }) : assert(pageSize > 0, 'pageSize must be greater than zero'),
       assert(
         pageSize <= 200,
         'pageSize must not exceed attention endpoint cap',
       ),
       brokerScopeKey = brokerScopeKey ?? brokerProfileId,
       _profileSyncGate = profileSyncGate ?? sharedAttentionProfileSyncGate {
    _deliveryProcessor = AttentionFeedDeliveryProcessor(
      repository: repository,
      brokerProfileId: brokerProfileId,
      brokerScopeKey: this.brokerScopeKey,
      lifecycleMonitor: lifecycleMonitor,
      notificationSink: notificationSink,
      onForegroundEvent: onForegroundEvent,
      isCurrentSource: _ownsDeliverySource,
      focusMatcher: focusMatcher,
      now: now,
      localizations: localizations,
    );
  }

  /// Primary broker API client for attention polling and ack/dismiss.
  final BrokerClient brokerClient;

  /// Durable repository for feed persistence and presentation state.
  final AttentionRepository repository;

  /// Broker profile id owning this worker.
  final String brokerProfileId;

  /// Exact durable source key owning this worker's rows and cursor.
  final String brokerScopeKey;

  /// Locale snapshot for background notification copy.
  final AppLocalizations? localizations;

  /// Stable attention client identifier.
  final String clientId;

  /// Lifecycle adapter for app visibility.
  final BrokerAppLifecycleMonitor lifecycleMonitor;

  /// Sink for background platform notifications.
  final BrokerNotificationSink notificationSink;

  /// Foreground callback for eligible in-app presentation.
  final AttentionFeedForegroundHandler onForegroundEvent;

  /// Maximum size of a request page.
  final int pageSize;

  /// Duration of long poll requests when catching up.
  final Duration longPollWait;

  /// Initial retry delay for transient failures.
  final Duration initialRetryDelay;

  /// Maximum retry delay for transient failures.
  final Duration maxRetryDelay;

  /// Optional deterministic clock for metadata.
  final DateTime Function()? now;

  /// Deterministic delay function for tests.
  final AttentionFeedDelay sleep;

  /// Maps foreground UI state to affected run-failed event scope.
  final AttentionFeedRunFailureFocusMatcher focusMatcher;

  /// Optional compatibility-state observer.
  final AttentionFeedSupportHandler? onSupportChanged;

  /// Optional durable-page observer for inbox/badge refresh.
  final AttentionFeedPersistedHandler? onPagePersisted;

  /// Reconciles durable mutation state and presentation state.
  late final AttentionFeedDeliveryProcessor _deliveryProcessor;

  /// Shared per-profile serialization for poll and opaque-wake cycles.
  final AttentionProfileSyncGate _profileSyncGate;

  /// Whether this worker has observed a successful feed page.
  bool get supportsFeed => supportState == AttentionFeedSupportState.supported;

  /// Current compatibility state.
  AttentionFeedSupportState get supportState => _supportState;

  /// Starts the worker loop for this profile.
  @override
  void start() {
    if (_loopFuture != null) {
      return;
    }

    final token = CancelToken();
    _cancelToken = token;
    _stopSignal = Completer<void>();
    final loop = _run(token);
    _loopFuture = loop.whenComplete(() {
      if (identical(_cancelToken, token)) {
        _cancelToken = null;
      }
      _loopFuture = null;
    });
  }

  /// Stops polling and waits for loop completion.
  @override
  Future<void> stop() async {
    if (_loopFuture == null) {
      return;
    }

    _cancelToken?.cancel('attention-worker-stop');
    if (!_stopSignal.isCompleted) {
      _stopSignal.complete();
    }
    await _loopFuture;
  }

  /// Marks an attention event as read and posts read state to broker.
  Future<void> acknowledgeAttentionEvent(String eventId) async {
    await repository.markRead(brokerScopeKey, eventId);
    await brokerClient.acknowledgeAttentionEvent(
      eventId,
      clientId: clientId,
    );
  }

  /// Marks an attention event as dismissed and posts dismissal to broker.
  ///
  /// Local dismissal persists before the broker call to ensure suppression
  /// behavior survives transient POST failures.
  Future<void> dismissAttentionEvent(String eventId) async {
    await repository.markDismissed(brokerScopeKey, eventId);
    await brokerClient.dismissAttentionEvent(
      eventId,
      clientId: clientId,
    );
  }

  Future<void> _run(CancelToken cancelToken) async {
    var retryDelay = initialRetryDelay;
    var cursor = await repository.loadCursor(brokerScopeKey);
    var waitForLongPoll = false;
    while (!cancelToken.isCancelled && !_stopSignal.isCompleted) {
      try {
        if (_stopSignal.isCompleted) {
          return;
        }
        final cycle = await _profileSyncGate.run(
          brokerScopeKey,
          () async {
            if (_isStopped(cancelToken)) {
              return null;
            }
            await _deliveryProcessor.reconcile(
              brokerClient: brokerClient,
              clientId: clientId,
            );
            if (_isStopped(cancelToken)) return null;
            final page = await _fetchPage(
              cursor: cursor,
              waitForLongPoll: waitForLongPoll,
              cancelToken: cancelToken,
            );
            if (_isStopped(cancelToken)) {
              return null;
            }
            await repository.persistAttentionEventsPage(
              brokerProfileId: brokerScopeKey,
              page: page,
            );
            // Persistence cannot be cancelled atomically. A stop/repoint may
            // therefore complete while the repository awaits its commit. The
            // retired source may keep its exact-scoped rows, but it must never
            // publish support, callbacks, or presentation afterward.
            if (_isStopped(cancelToken)) return null;
            // Once the fetched page is durable, this feed owns presentation
            // for the profile. Publish support before presenting those rows so
            // an attached session cannot race the same event through the
            // legacy notification path.
            if (_isStopped(cancelToken)) return null;
            _setSupportState(AttentionFeedSupportState.supported);
            if (_isStopped(cancelToken)) return null;
            await onPagePersisted?.call(page);
            if (_isStopped(cancelToken)) return null;
            final durableCursor = await repository.loadCursor(brokerScopeKey);
            if (_isStopped(cancelToken)) return null;
            await _deliveryProcessor.reconcile(
              brokerClient: brokerClient,
              clientId: clientId,
            );
            if (_isStopped(cancelToken)) return null;
            return (page: page, durableCursor: durableCursor);
          },
        );
        if (cycle == null) return;

        retryDelay = initialRetryDelay;
        cursor = cycle.durableCursor;
        waitForLongPoll = !cycle.page.hasMore;
        // A successful long poll is itself the wait. Yield once so a synthetic
        // immediate broker/test double cannot starve stop/dispose callbacks.
        await Future<void>.delayed(Duration.zero);
      } on AttentionFeedUnsupportedException {
        if (_isStopped(cancelToken)) return;
        _setSupportState(AttentionFeedSupportState.unsupported);
        await _sleepWithBoundedBackoff(retryDelay);
        retryDelay = _nextRetryDelay(retryDelay);
      } on DioException catch (error) {
        if (cancelToken.isCancelled || error.type == DioExceptionType.cancel) {
          return;
        }
        await _sleepWithBoundedBackoff(retryDelay);
        retryDelay = _nextRetryDelay(retryDelay);
      } on Object {
        await _sleepWithBoundedBackoff(retryDelay);
        retryDelay = _nextRetryDelay(retryDelay);
      }
    }
  }

  Future<void> _sleepWithBoundedBackoff(
    Duration duration,
  ) async {
    if (duration <= Duration.zero) {
      await sleep(Duration.zero);
      return;
    }
    if (_cancelToken?.isCancelled ?? false) {
      return;
    }

    await Future.any([
      sleep(duration),
      _stopSignal.future,
    ]);
  }

  Future<AttentionEventsPage> _fetchPage({
    required int cursor,
    required bool waitForLongPoll,
    required CancelToken cancelToken,
  }) {
    final waitMs = waitForLongPoll ? longPollWait.inMilliseconds : 0;
    return brokerClient.getAttentionEvents(
      clientId: clientId,
      after: cursor,
      limit: pageSize,
      waitMs: waitMs <= 0 ? null : waitMs,
      cancelToken: cancelToken,
    );
  }

  AttentionFeedSupportState _supportState = AttentionFeedSupportState.unknown;
  Future<void>? _loopFuture;
  CancelToken? _cancelToken;
  Completer<void> _stopSignal = Completer<void>();

  Duration _nextRetryDelay(Duration currentDelay) {
    final doubled = currentDelay * 2;
    if (doubled >= maxRetryDelay) {
      return maxRetryDelay;
    }
    return doubled;
  }

  void _setSupportState(AttentionFeedSupportState next) {
    if (_supportState == next) return;
    _supportState = next;
    onSupportChanged?.call(next);
  }

  bool _isStopped(CancelToken cancelToken) =>
      cancelToken.isCancelled || _stopSignal.isCompleted;

  bool _ownsDeliverySource() {
    final token = _cancelToken;
    return token != null && !_isStopped(token);
  }
}

bool _noForegroundFocus({
  required String? tool,
  required String? agent,
  required String? sessionId,
}) {
  return false;
}
