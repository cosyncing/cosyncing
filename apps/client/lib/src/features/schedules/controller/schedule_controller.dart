import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/schedule_conflict.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Typed presentation-only schedule failures.
///
/// Controllers retain the semantic condition; widgets resolve localized copy.
enum SchedulePresentationIssue {
  /// An explicit model catalog belongs to a different broker incarnation.
  modelSourceMismatch,
}

/// Schedule list/action state.
@immutable
final class ScheduleStateModel {
  /// Creates schedule state.
  const ScheduleStateModel({
    this.schedules = const [],
    this.loading = false,
    this.mutatingIds = const {},
    this.error,
    this.presentationIssue,
  });

  /// Broker-ordered rows: live first, then terminal.
  final List<ScheduleRecord> schedules;

  /// Whether the prompt-bearing list is loading.
  final bool loading;

  /// Rows currently being created, edited, acted on, canceled, or removed.
  final Set<String> mutatingIds;

  /// Last honest API error.
  final String? error;

  /// Last typed failure that requires localized presentation.
  final SchedulePresentationIssue? presentationIssue;

  /// Returns a copy with selected fields replaced.
  ScheduleStateModel copyWith({
    List<ScheduleRecord>? schedules,
    bool? loading,
    Set<String>? mutatingIds,
    String? error,
    SchedulePresentationIssue? presentationIssue,
    bool clearError = false,
  }) => ScheduleStateModel(
    schedules: schedules ?? this.schedules,
    loading: loading ?? this.loading,
    mutatingIds: mutatingIds ?? this.mutatingIds,
    error: clearError ? null : error ?? this.error,
    presentationIssue:
        presentationIssue ?? (clearError ? null : this.presentationIssue),
  );
}

/// Shared controller for list/create and Cancel→Remove semantics.
///
/// Governing doc: `docs/architecture/client-ui.md`.
final scheduleControllerProvider =
    AutoDisposeNotifierProvider<ScheduleController, ScheduleStateModel>(
      ScheduleController.new,
    );

/// Owns the token-gated schedule REST lifecycle.
final class ScheduleController extends AutoDisposeNotifier<ScheduleStateModel> {
  int _listGeneration = 0;

  @override
  ScheduleStateModel build() {
    // Full schedule rows contain prompt text, so they are rebuilt on any change
    // of the exact broker SOURCE — (profile, endpoint) — not the profile id. A
    // profile is an editable pointer: re-pointing it at another machine keeps
    // the id, and an id-keyed rebuild left the previous machine's prompts on
    // screen and admitted its late answer under the new one.
    ref.watch(activeBrokerProfileProvider.select(RosterSource.of));
    _listGeneration += 1;
    return const ScheduleStateModel();
  }

  /// Loads the full prompt-bearing schedule list.
  Future<void> load() async {
    final keepAlive = ref.keepAlive();
    final source = _activeSource;
    final generation = ++_listGeneration;
    // Keep the last canonical rows visible while refreshing. Schedule rows
    // contain sensitive prompt text, so a source change still rebuilds this
    // auto-disposed provider and clears the previous broker's state.
    state = state.copyWith(loading: true, clearError: true);
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (client == null) {
        throw StateError('Connect to a server to view scheduled sends.');
      }
      final response = await client.listSchedules();
      if (!_canApplyListResult(source, generation)) return;
      state = state.copyWith(
        schedules: response.schedules,
        loading: false,
        clearError: true,
      );
    } on Object catch (error) {
      if (!_canApplyListResult(source, generation)) return;
      state = state.copyWith(
        loading: false,
        error: userFacingMessage(
          error,
          lead: "Couldn't load scheduled sends.",
        ),
      );
    } finally {
      keepAlive.close();
    }
  }

  /// Creates either checked schedule union variant.
  Future<ScheduleRecord?> create(
    ScheduleCreate request, {
    RosterSource? expectedSource,
  }) async {
    final keepAlive = ref.keepAlive();
    final profile = ref.read(activeBrokerProfileProvider);
    final source = RosterSource.of(profile);
    BrokerClient? operationClient;
    if (expectedSource != null && expectedSource != source) {
      state = state.copyWith(
        presentationIssue: SchedulePresentationIssue.modelSourceMismatch,
        clearError: true,
      );
      keepAlive.close();
      return null;
    }
    _listGeneration += 1;
    state = state.copyWith(clearError: true);
    try {
      final client = expectedSource == null
          ? await ref.read(brokerClientProvider.future)
          : operationClient = await ref.read(brokerClientFactoryProvider)(
              profile!,
            );
      if (client == null) {
        throw StateError('Connect to a server before scheduling a send.');
      }
      final response = await client.createSchedule(request);
      if (!_sourceMatches(source)) return null;
      final rows = _orderedSchedules([
        response.schedule,
        ...state.schedules.where((row) => row.id != response.schedule.id),
      ]);
      state = state.copyWith(schedules: rows, clearError: true);
      return response.schedule;
    } on Object catch (error) {
      if (!_sourceMatches(source)) return null;
      state = state.copyWith(
        error: userFacingMessage(error, lead: "Couldn't schedule that send."),
      );
      return null;
    } finally {
      operationClient?.close();
      keepAlive.close();
    }
  }

  /// Applies a revision-checked edit to a live schedule.
  Future<bool> update(String id, ScheduleUpdate request) {
    return _mutate(
      id,
      (client) => client.updateSchedule(id, request),
    );
  }

  /// Applies a typed lifecycle [action] using the latest rendered revision.
  Future<bool> action(String id, ScheduleAction action) async {
    final schedule = state.schedules.where((row) => row.id == id).firstOrNull;
    if (schedule == null) {
      state = state.copyWith(error: 'The schedule is no longer available.');
      return false;
    }
    return _mutate(
      id,
      (client) => client.applyScheduleAction(
        id,
        ScheduleActionRequest(
          action: action,
          expectedRevision: schedule.revision,
        ),
      ),
    );
  }

  Future<bool> _mutate(
    String id,
    Future<ScheduleMutationResponse> Function(BrokerClient client) mutation,
  ) async {
    if (state.mutatingIds.contains(id)) return false;
    final keepAlive = ref.keepAlive();
    final source = _activeSource;
    _listGeneration += 1;
    state = state.copyWith(
      mutatingIds: {...state.mutatingIds, id},
      clearError: true,
    );
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (client == null) {
        throw StateError('Connect to a server before changing a schedule.');
      }
      final response = await mutation(client);
      if (!_sourceMatches(source)) return false;
      state = state.copyWith(
        schedules: _orderedSchedules([
          for (final row in state.schedules)
            if (row.id == id) response.schedule else row,
        ]),
        mutatingIds: {...state.mutatingIds}..remove(id),
        clearError: true,
      );
      return true;
    } on Object catch (error) {
      if (!_sourceMatches(source)) return false;
      if (isScheduleConflict(error)) {
        await load();
        if (!_sourceMatches(source)) return false;
      }
      state = state.copyWith(
        mutatingIds: {...state.mutatingIds}..remove(id),
        error: _scheduleMutationMessage(error),
      );
      return false;
    } finally {
      keepAlive.close();
    }
  }

  /// Cancels a live row or removes a terminal row with the same DELETE route.
  Future<bool> delete(String id) async {
    if (state.mutatingIds.contains(id)) return false;
    final keepAlive = ref.keepAlive();
    final source = _activeSource;
    _listGeneration += 1;
    state = state.copyWith(
      mutatingIds: {...state.mutatingIds, id},
      clearError: true,
    );
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (client == null) {
        throw StateError('Connect to a server before changing a schedule.');
      }
      final response = await client.deleteSchedule(id);
      if (!_sourceMatches(source)) return false;
      final rows = switch (response) {
        ScheduleCanceledResponse(:final schedule) => _orderedSchedules([
          for (final row in state.schedules)
            if (row.id == id) schedule else row,
        ]),
        ScheduleRemovedResponse() => [
          for (final row in state.schedules)
            if (row.id != id) row,
        ],
      };
      state = state.copyWith(
        schedules: rows,
        mutatingIds: {...state.mutatingIds}..remove(id),
        clearError: true,
      );
      return true;
    } on Object catch (error) {
      if (!_sourceMatches(source)) return false;
      if (isScheduleConflict(error)) {
        await load();
        if (!_sourceMatches(source)) return false;
      }
      state = state.copyWith(
        mutatingIds: {...state.mutatingIds}..remove(id),
        error: _scheduleMutationMessage(error),
      );
      return false;
    } finally {
      keepAlive.close();
    }
  }

  /// The broker this controller is currently allowed to speak for.
  RosterSource? get _activeSource =>
      RosterSource.of(ref.read(activeBrokerProfileProvider));

  bool _sourceMatches(RosterSource? source) => _activeSource == source;

  bool _canApplyListResult(RosterSource? source, int generation) =>
      _sourceMatches(source) && _listGeneration == generation;
}

String _scheduleMutationMessage(Object error) {
  if (isScheduleConflict(error)) {
    return 'This schedule changed on another client. Refresh before retrying.';
  }
  return userFacingMessage(error, lead: "Couldn't update this schedule.");
}

List<ScheduleRecord> _orderedSchedules(Iterable<ScheduleRecord> rows) {
  final result = rows.toList(growable: false)
    ..sort((left, right) {
      if (left.state.isLive != right.state.isLive) {
        return left.state.isLive ? -1 : 1;
      }
      final byTime = left.state.isLive
          ? left.at.compareTo(right.at)
          : right.updatedAt.compareTo(left.updatedAt);
      return byTime != 0 ? byTime : left.id.compareTo(right.id);
    });
  return result;
}
