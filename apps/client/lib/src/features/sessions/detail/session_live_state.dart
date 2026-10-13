import 'package:broker_contract/broker_contract.dart';

/// Current keyed session state projected from replay plus live messages.
///
/// Goal and task messages are state replacements, not durable transcript
/// bubbles. Rebuilding this projection from the current history epoch keeps a
/// reconnect/reset deterministic and prevents obsolete updates from stacking.
final class SessionLiveState {
  /// Creates an immutable session-state projection.
  SessionLiveState({
    required List<GoalStateSnapshot> goals,
    required List<TaskListStateSnapshot> taskLists,
    required List<AgentActivitySnapshot> activities,
  }) : this._(goals, taskLists, activities, const {}, 0);

  SessionLiveState._(
    List<GoalStateSnapshot> goals,
    List<TaskListStateSnapshot> taskLists,
    List<AgentActivitySnapshot> activities,
    Map<String, SessionActivityOrder> activityOrder,
    this._nextOrdinal,
  ) : goals = List.unmodifiable(goals),
      taskLists = List.unmodifiable(taskLists),
      activities = List.unmodifiable(activities),
      _activityOrder = Map.unmodifiable(activityOrder);

  /// Builds the latest visible state for every canonical upsert key.
  factory SessionLiveState.fromMessages(Iterable<AgentMessage> messages) {
    var state = SessionLiveState(
      goals: const [],
      taskLists: const [],
      activities: const [],
    );
    for (final message in messages) {
      state = state.applyMessage(message);
    }
    return state;
  }

  /// How many order entries may outlive their activity, beyond the live ones.
  ///
  /// A swept subagent keeps its entry so the next progress frame puts it back
  /// where it was; one that never comes back is pruned past this slack.
  static const int _orderSlack = 64;

  /// Applies one live delta without rescanning retained transcript history.
  SessionLiveState applyMessage(AgentMessage message) {
    final goals = {for (final value in this.goals) value.key: value};
    final taskLists = {
      for (final value in this.taskLists) value.key: value,
    };
    final activities = {
      for (final value in this.activities) value.key: value,
    };
    final order = Map<String, SessionActivityOrder>.of(_activityOrder);
    var nextOrdinal = _nextOrdinal;

    // An incremental reconnect preserves old cards. A bounded broker ledger can
    // forget withdrawals, so reconcile only Codex running identities.
    // Completed results and other agents' activities stay until dismissed.
    if (message.eventName == 'codex.background-running-snapshot') {
      final payload = message.raw['payload'];
      final keys = payload is Map ? payload['keys'] : null;
      if (keys is List &&
          keys.length <= 128 &&
          keys.every((key) => key is String && key.startsWith('cmd:codex:'))) {
        final retained = keys.toSet();
        activities.removeWhere((key, activity) {
          final forgotten =
              key.startsWith('cmd:codex:') &&
              activity.kind == AgentActivityKind.command &&
              activity.status == AgentActivityStatus.running &&
              !retained.contains(key);
          if (forgotten) order.remove(key);
          return forgotten;
        });
      }
    }

    // `agent-activity` is a volatile progress overlay. A canonical idle status
    // is the authoritative turn boundary and prevents a missed terminal
    // activity frame from leaving a forever-running card. Only a `status`
    // frame carries that boundary, and the sweep runs ALONGSIDE the type
    // dispatch below: chaining it in front dropped any state frame that also
    // reported a status.
    //
    // A background command is exempt: it outlives the turn that launched it,
    // which is the whole reason it is surfaced. Sweeping it here would retire
    // the card at the exact moment it becomes the only sign that work is still
    // running, and its own terminal frame is what retires it instead.
    //
    // A swept card keeps its order entry. A background subagent outlives the
    // turn too, so its next progress frame often brings it straight back, and
    // re-entering the map would otherwise file it behind every card that
    // finished in the meantime.
    if (message.type == AgentMessageType.status &&
        message.agentMessageStatus == AgentMessageStatus.idle) {
      activities.removeWhere(
        (_, activity) =>
            activity.status == AgentActivityStatus.running &&
            activity.kind != AgentActivityKind.command,
      );
    }

    if (GoalStateSnapshot.fromMessage(message)
        case final GoalStateSnapshot goal) {
      switch (goal.status) {
        case GoalStateStatus.active:
        case GoalStateStatus.paused:
        case GoalStateStatus.blocked:
          goals[goal.key] = goal;
        case GoalStateStatus.done:
        case GoalStateStatus.error:
        case GoalStateStatus.cleared:
        case GoalStateStatus.unknown:
          goals.remove(goal.key);
      }
    } else if (message.type == AgentMessageType.goalState) {
      // A future/malformed lifecycle value must not leave an older actionable
      // goal visible. Fail closed for the affected key.
      goals.remove(_stateKey(message, fallback: 'current'));
    } else if (TaskListStateSnapshot.fromMessage(message)
        case final TaskListStateSnapshot taskList) {
      switch (taskList.status) {
        case TaskListStateStatus.running:
        case TaskListStateStatus.done:
          taskLists[taskList.key] = taskList;
        case TaskListStateStatus.cleared:
        case TaskListStateStatus.unknown:
          taskLists.remove(taskList.key);
      }
    } else if (message.type == AgentMessageType.taskListState) {
      final key = _stateKey(message);
      if (key != null) taskLists.remove(key);
    } else if (AgentActivitySnapshot.fromMessage(message)
        case final AgentActivitySnapshot activity) {
      switch (activity.status) {
        case AgentActivityStatus.running:
        case AgentActivityStatus.done:
        case AgentActivityStatus.error:
          activities[activity.key] = activity;
          final previous = order[activity.key];
          final seen = previous?.seen ?? nextOrdinal++;
          final ended = activity.status == AgentActivityStatus.running
              ? null
              : previous?.ended ?? nextOrdinal++;
          if (previous == null ||
              previous.seen != seen ||
              previous.ended != ended) {
            order[activity.key] = SessionActivityOrder(
              seen: seen,
              ended: ended,
            );
          }
        // `retired` is a withdrawal, not an outcome: the server can no longer
        // vouch for the card. It shares the fail-closed removal that an
        // unrecognized future value already gets.
        case AgentActivityStatus.retired:
        case AgentActivityStatus.unknown:
          activities.remove(activity.key);
          order.remove(activity.key);
      }
    } else if (message.type == AgentMessageType.agentActivity) {
      final key = _stateKey(message);
      if (key != null) {
        activities.remove(key);
        order.remove(key);
      }
    }
    if (order.length > activities.length + _orderSlack) {
      final stale =
          order.entries
              .where((entry) => !activities.containsKey(entry.key))
              .toList()
            ..sort((a, b) => a.value.seen.compareTo(b.value.seen));
      for (final entry in stale) {
        if (order.length <= activities.length + _orderSlack) break;
        order.remove(entry.key);
      }
    }
    return SessionLiveState._(
      goals.values.toList(growable: false),
      taskLists.values.toList(growable: false),
      activities.values.toList(growable: false),
      order,
      nextOrdinal,
    );
  }

  /// Active, paused, or blocked goals, one per broker key.
  final List<GoalStateSnapshot> goals;

  /// Running or completed task ledgers, one per broker key.
  final List<TaskListStateSnapshot> taskLists;

  /// Latest subagent/workflow state, including terminal evidence until archived.
  ///
  /// The list is in map order, which is NOT a display order: read
  /// [activityOrder] for when each card was first seen and when it finished.
  final List<AgentActivitySnapshot> activities;

  final Map<String, SessionActivityOrder> _activityOrder;
  final int _nextOrdinal;

  /// When the activity under [key] was first seen and, once terminal, when it
  /// first reported finishing — as ordinals of this projection, so they compare
  /// across every harness whether or not its adapter stamps a start time.
  SessionActivityOrder? activityOrder(String key) => _activityOrder[key];

  /// Whether there is any state surface to display.
  bool get isEmpty => goals.isEmpty && taskLists.isEmpty && activities.isEmpty;
}

/// Where one activity sits in the projection's timeline.
///
/// Both values are ordinals of the frames that set them, not clock times: a
/// replayed history and a live stream assign them in the same order, and no
/// adapter has to report a start or end time for them to exist.
final class SessionActivityOrder {
  /// Creates an order entry.
  const SessionActivityOrder({required this.seen, this.ended});

  /// Ordinal of the frame that first surfaced the activity.
  ///
  /// It survives the idle sweep, so a swept card that comes back keeps it.
  final int seen;

  /// Ordinal of the frame that first reported it done or failed; null while it
  /// runs.
  final int? ended;
}

/// Whether [message] belongs on the pinned session-state surface.
bool isSessionLiveStateMessage(AgentMessage message) {
  return message.type == AgentMessageType.goalState ||
      message.type == AgentMessageType.taskListState ||
      message.type == AgentMessageType.agentActivity ||
      message.eventName == 'codex.background-running-snapshot';
}

String? _stateKey(AgentMessage message, {String? fallback}) {
  final rawKey = message.raw['key'];
  if (rawKey is String && rawKey.trim().isNotEmpty) return rawKey.trim();
  return fallback;
}
