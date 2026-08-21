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
  }) : goals = List.unmodifiable(goals),
       taskLists = List.unmodifiable(taskLists),
       activities = List.unmodifiable(activities);

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

  /// Applies one live delta without rescanning retained transcript history.
  SessionLiveState applyMessage(AgentMessage message) {
    final goals = {for (final value in this.goals) value.key: value};
    final taskLists = {
      for (final value in this.taskLists) value.key: value,
    };
    final activities = {
      for (final value in this.activities) value.key: value,
    };

    // `agent-activity` is a volatile progress overlay. A canonical idle status
    // is the authoritative turn boundary and prevents a missed terminal
    // activity frame from leaving a forever-running card. Only a `status`
    // frame carries that boundary, and the sweep runs ALONGSIDE the type
    // dispatch below: chaining it in front dropped any state frame that also
    // reported a status.
    if (message.type == AgentMessageType.status &&
        message.agentMessageStatus == AgentMessageStatus.idle) {
      activities.clear();
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
          activities[activity.key] = activity;
        case AgentActivityStatus.done:
        case AgentActivityStatus.error:
        case AgentActivityStatus.unknown:
          activities.remove(activity.key);
      }
    } else if (message.type == AgentMessageType.agentActivity) {
      final key = _stateKey(message);
      if (key != null) activities.remove(key);
    }
    return SessionLiveState(
      goals: goals.values.toList(growable: false),
      taskLists: taskLists.values.toList(growable: false),
      activities: activities.values.toList(growable: false),
    );
  }

  /// Active, paused, or blocked goals, one per broker key.
  final List<GoalStateSnapshot> goals;

  /// Running or completed task ledgers, one per broker key.
  final List<TaskListStateSnapshot> taskLists;

  /// Currently running subagents/workflows, one per broker key.
  final List<AgentActivitySnapshot> activities;

  /// Whether there is any state surface to display.
  bool get isEmpty => goals.isEmpty && taskLists.isEmpty && activities.isEmpty;
}

/// Whether [message] belongs on the pinned session-state surface.
bool isSessionLiveStateMessage(AgentMessage message) {
  return message.type == AgentMessageType.goalState ||
      message.type == AgentMessageType.taskListState ||
      message.type == AgentMessageType.agentActivity;
}

String? _stateKey(AgentMessage message, {String? fallback}) {
  final rawKey = message.raw['key'];
  if (rawKey is String && rawKey.trim().isNotEmpty) return rawKey.trim();
  return fallback;
}
