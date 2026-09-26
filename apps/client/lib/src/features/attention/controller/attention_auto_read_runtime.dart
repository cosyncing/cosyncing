import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Root-app runtime: a session on screen, in the foreground, reads its own
/// notifications.
///
/// - A finished or failed turn (and a finished goal) of that session is
///   marked read, which clears its OS notification and syncs to the broker.
/// - A pending permission request or question only loses its OS
///   notification; its inbox row stays until the request is answered.
///
/// It re-runs whenever the visible set changes, a feed page lands (a turn can
/// finish while the user watches), or the app returns to the foreground.
final attentionAutoReadRuntimeProvider = Provider<void>((ref) {
  final runtime = _AttentionAutoReadRuntime(ref);
  ref
    ..listen(visibleAttentionSessionsProvider, (_, _) => runtime.schedule())
    ..listen(attentionInboxRevisionProvider, (_, _) => runtime.schedule());
  final subscription = ref
      .watch(sessionNotificationLifecycleMonitorProvider)
      .stateChanges
      .listen((state) {
        if (state == BrokerAppLifecycleState.resumed) runtime.schedule();
      });
  ref.onDispose(() {
    runtime.dispose();
    unawaited(subscription.cancel());
  });
});

final class _AttentionAutoReadRuntime {
  _AttentionAutoReadRuntime(this._ref);

  final Ref _ref;
  bool _running = false;
  bool _rerun = false;
  bool _disposed = false;

  /// Request notifications already cleared, by event id and presentation
  /// revision, so a watched request is cleared once and a reminder that
  /// arrives while it stays on screen is cleared again.
  final Set<String> _clearedRequests = {};

  void schedule() {
    if (_disposed) return;
    if (_running) {
      _rerun = true;
      return;
    }
    unawaited(_run());
  }

  void dispose() => _disposed = true;

  Future<void> _run() async {
    _running = true;
    try {
      do {
        _rerun = false;
        await _readVisibleSessions();
      } while (_rerun && !_disposed);
    } on Object {
      // Best effort: the next trigger retries.
    } finally {
      _running = false;
    }
  }

  Future<void> _readVisibleSessions() async {
    final lifecycle = _ref.read(sessionNotificationLifecycleMonitorProvider);
    if (lifecycle.currentState != BrokerAppLifecycleState.resumed) return;
    final claims = [
      for (final claim in _ref.read(visibleAttentionSessionsProvider))
        if (_stillVisible(claim)) claim,
    ];
    if (claims.isEmpty) return;

    final profiles = await _ref.read(brokerProfileListProvider.future);
    final repository = _ref.read(attentionRepositoryProvider);
    final actions = _ref.read(attentionInboxActionsProvider);
    final requestIds = <String>{};

    for (final claim in claims) {
      final profile = _profileFor(profiles, claim.source);
      if (profile == null || _disposed) continue;
      final events = await repository.loadEvents(claim.source.storageKey);
      for (final event in events) {
        if (event.dismissedAt != null || !_belongsTo(event, claim)) continue;
        final type = attentionNotificationTypeOf(event);
        if (type == null) continue;
        if (type.isSessionOutcome) {
          final entry = AttentionInboxEntry(profile: profile, event: event);
          if (!entry.isUnread) continue;
          try {
            await actions.acknowledge(entry);
          } on Object {
            // Read state is durable locally; the mutation drain retries the
            // broker post.
          }
        } else if (type.isRequest && event.state == 'active') {
          final key = '${event.id}#${event.presentationRevision}';
          if (_clearedRequests.add(key)) {
            requestIds.addAll(
              attentionNotificationIdsForEvent(
                brokerProfileId: profile.id,
                event: event,
              ),
            );
          }
        }
      }
    }
    if (requestIds.isEmpty) return;
    try {
      await _ref
          .read(sessionLocalNotificationSinkProvider)
          .clearMany(requestIds);
    } on Object {
      // Platform cleanup is best effort.
    }
  }

  static bool _stillVisible(VisibleAttentionSession claim) {
    try {
      return claim.isStillVisible();
    } on Object {
      return false;
    }
  }

  static bool _belongsTo(AttentionEvent event, VisibleAttentionSession claim) {
    final sessionId = event.action.sessionId ?? event.sessionId;
    final tool = event.action.tool ?? event.agent;
    return sessionId == claim.sessionId && tool == claim.tool;
  }

  static BrokerProfile? _profileFor(
    List<BrokerProfile> profiles,
    RosterSource source,
  ) {
    for (final profile in profiles) {
      if (RosterSource.ofProfile(profile) == source) return profile;
    }
    return null;
  }
}
