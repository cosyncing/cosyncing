import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/schedule_controller.dart';
import 'package:cosyncing_client/src/features/schedules/model/schedule_timing.dart';
import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_date_time_field.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_model_preference_store.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum _NewSessionIssue {
  noAgents,
  modelRetired,
  firstMessageRequired,
  firstMessageTooLong,
  timeInPast,
  timeZoneRequired,
  cronRequired,
}

/// Result from the shared New Session input flow.
sealed class NewSessionFlowResult {
  const NewSessionFlowResult();
}

/// An accepted immediate request that should move to the page-level launcher.
final class ImmediateNewSessionResult extends NewSessionFlowResult {
  /// Creates the result.
  const ImmediateNewSessionResult(this.request);

  /// Values accepted by the sheet.
  final NewSessionLaunchRequest request;
}

/// A future/repeating session schedule.
final class ScheduledNewSessionResult extends NewSessionFlowResult {
  /// Creates the result.
  const ScheduledNewSessionResult(this.schedule);

  /// Created broker schedule.
  final ScheduleRecord schedule;
}

/// Opens the unified global/project-scoped New Session flow.
///
/// Governing docs: `docs/architecture/client-ui.md`
/// and `docs/architecture/client-ui.md`.
Future<NewSessionFlowResult?> showNewSessionSheet(
  BuildContext context, {
  required ValueChanged<NewSessionLaunchRequest> onImmediateLaunch,
  String initialDirectory = '',
  String? projectName,
}) {
  return showModalBottomSheet<NewSessionFlowResult>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _NewSessionSheet(
      initialDirectory: initialDirectory,
      projectName: projectName,
      onImmediateLaunch: onImmediateLaunch,
    ),
  );
}

class _NewSessionSheet extends ConsumerStatefulWidget {
  const _NewSessionSheet({
    required this.initialDirectory,
    required this.projectName,
    required this.onImmediateLaunch,
  });

  final String initialDirectory;
  final String? projectName;
  final ValueChanged<NewSessionLaunchRequest> onImmediateLaunch;

  @override
  ConsumerState<_NewSessionSheet> createState() => _NewSessionSheetState();
}

class _NewSessionSheetState extends ConsumerState<_NewSessionSheet> {
  late final TextEditingController _directoryController;
  late final TextEditingController _titleController;
  late final TextEditingController _promptController;
  late final TextEditingController _cronController;
  late final TextEditingController _timeZoneController;
  NewSessionStart _start = NewSessionStart.now;
  late DateTime _at;
  String? _selectedTool;
  SessionCurrentModel? _selectedModel;
  String? _selectedModelLabel;
  _NewSessionIssue? _localIssue;
  bool _submittingImmediate = false;
  bool _submittingSchedule = false;

  /// Tools whose explicit "Default" choice suppresses the per-tool prefill
  /// for the rest of this sheet's lifetime. Tracked PER TOOL: switching to
  /// another tool and back must not resurrect a remembered model the user
  /// already declined. Cleared only when the broker source changes or the
  /// sheet closes.
  final Set<String> _declinedDefaultTools = {};

  /// N3b: this editor's value lives only in widget state — there is nowhere to
  /// flush it to, and returning to the underlying route after a web-update
  /// handoff would discard it silently. Holding defers the handoff for as long
  /// as the editor is open; closing it signals readiness immediately.
  VoidCallback? _releaseHandoffHold;

  @override
  void initState() {
    super.initState();
    _directoryController = TextEditingController(text: widget.initialDirectory);
    _titleController = TextEditingController();
    _promptController = TextEditingController();
    _cronController = TextEditingController(text: '0 9 * * 1-5');
    _timeZoneController = TextEditingController();
    _at = defaultScheduleDateTime(DateTime.now());
    _releaseHandoffHold = WebHandoffParticipants.instance.hold();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        unawaited(_loadAgents());
      }
    });
  }

  Future<void> _loadAgents() async {
    await ref.read(newSessionControllerProvider.notifier).loadAgents();
    if (!mounted || _selectedTool != null) return;
    final first = ref.read(newSessionControllerProvider).agents.firstOrNull;
    if (first != null) {
      setState(() => _selectedTool = first.id);
      await ref
          .read(newSessionControllerProvider.notifier)
          .loadModels(first.id);
      await _applyToolModelDefault(first.id);
    }
  }

  Future<void> _selectTool(String tool) async {
    setState(() {
      _selectedTool = tool;
      _selectedModel = null;
      _selectedModelLabel = null;
      _localIssue = null;
    });
    await ref.read(newSessionControllerProvider.notifier).loadModels(tool);
    await _applyToolModelDefault(tool);
  }

  /// Preselects the model dropdown from the per-tool "last picked" fallback
  /// when the user has not chosen a model for this tool yet.
  ///
  /// The stored selection is admitted only when the freshly loaded catalog for
  /// THIS broker still advertises the exact provider/model/variant — the same
  /// freshness rule `_submit` enforces for an explicit pick — so a retired or
  /// other-broker model silently stays dormant instead of failing creation.
  Future<void> _applyToolModelDefault(String tool) async {
    if (_selectedModel != null || _declinedDefaultTools.contains(tool)) return;
    final source = RosterSource.of(ref.read(activeBrokerProfileProvider));
    if (source == null) return;
    // Best-effort, like the write side: a preference read failure must leave
    // the sheet on the tool default, never break sheet setup or tool changes.
    final SessionCurrentModel? saved;
    try {
      saved = await ref
          .read(sessionModelPreferenceStoreProvider)
          .loadToolDefault(brokerProfileId: source.storageKey, tool: tool);
    } on Object {
      return;
    }
    if (!mounted ||
        saved == null ||
        _selectedModel != null ||
        _declinedDefaultTools.contains(tool) ||
        _selectedTool != tool) {
      return;
    }
    final state = ref.read(newSessionControllerProvider);
    if (state.modelTool != tool ||
        state.modelCatalogPhase != NewSessionModelCatalogPhase.ready ||
        state.modelCatalogSource != source) {
      return;
    }
    for (final option in state.models) {
      final selection = _selectionOf(
        option,
        preferredEffort: saved.reasoningEffort,
      );
      if (_modelKey(selection) == _modelKey(saved)) {
        setState(() {
          _selectedModel = selection;
          _selectedModelLabel = option.label;
        });
        return;
      }
    }
  }

  String _modelKey(SessionCurrentModel model) =>
      '${model.providerID}\u0000${model.modelID}\u0000${model.variant ?? ''}';

  String _modelTooltip(ModelOption option) {
    final provider = option.providerLabel ?? option.providerID;
    final variant = option.variant;
    final variantSuffix = variant == null || variant == option.providerLabel
        ? ''
        : ' · $variant';
    return '$provider/${option.modelID}$variantSuffix';
  }

  String? _effortFor(ModelOption option, {String? preferred}) {
    final efforts = option.reasoningEfforts ?? const <ReasoningEffort>[];
    if (efforts.isEmpty) return null;
    if (preferred != null &&
        efforts.any((candidate) => candidate.effort == preferred)) {
      return preferred;
    }
    final advertisedDefault = option.defaultReasoningEffort;
    if (advertisedDefault != null &&
        efforts.any((candidate) => candidate.effort == advertisedDefault)) {
      return advertisedDefault;
    }
    return efforts.first.effort;
  }

  SessionCurrentModel _selectionOf(
    ModelOption option, {
    String? preferredEffort,
  }) => SessionCurrentModel(
    providerID: option.providerID,
    modelID: option.modelID,
    variant: option.variant,
    reasoningEffort: _effortFor(option, preferred: preferredEffort),
  );

  void _selectReasoningEffort({
    required String tool,
    required RosterSource? renderedSource,
    required String effort,
  }) {
    final selected = _selectedModel;
    final source = RosterSource.of(ref.read(activeBrokerProfileProvider));
    final catalog = ref.read(newSessionControllerProvider);
    if (selected == null ||
        source == null ||
        renderedSource != source ||
        catalog.modelTool != tool ||
        catalog.modelCatalogSource != source) {
      return;
    }
    ModelOption? option;
    for (final candidate in catalog.models) {
      if (_modelKey(_selectionOf(candidate)) == _modelKey(selected)) {
        option = candidate;
        break;
      }
    }
    if (option == null ||
        !(option.reasoningEfforts ?? const <ReasoningEffort>[]).any(
          (candidate) => candidate.effort == effort,
        )) {
      return;
    }
    final updated = SessionCurrentModel(
      providerID: selected.providerID,
      modelID: selected.modelID,
      variant: selected.variant,
      reasoningEffort: effort,
    );
    setState(() {
      _selectedModel = updated;
      _localIssue = null;
    });
    unawaited(
      ref
          .read(sessionModelPreferenceStoreProvider)
          .saveToolDefault(
            brokerProfileId: source.storageKey,
            tool: tool,
            model: updated,
          )
          .catchError((Object _, StackTrace _) {}),
    );
  }

  @override
  void dispose() {
    _releaseHandoffHold?.call();
    _releaseHandoffHold = null;
    _directoryController.dispose();
    _titleController.dispose();
    _promptController.dispose();
    _cronController.dispose();
    _timeZoneController.dispose();
    super.dispose();
  }

  Future<void> _submit(List<AgentInfo> agents) async {
    final tool = _selectedTool ?? agents.firstOrNull?.id;
    if (tool == null) {
      setState(() => _localIssue = _NewSessionIssue.noAgents);
      return;
    }
    final modelState = ref.read(newSessionControllerProvider);
    final currentSource = RosterSource.of(
      ref.read(activeBrokerProfileProvider),
    );
    var selectedModel = _selectedModel;
    if (selectedModel != null) {
      ModelOption? selectedOption;
      for (final option in modelState.models) {
        if (_modelKey(_selectionOf(option)) == _modelKey(selectedModel)) {
          selectedOption = option;
          break;
        }
      }
      final selectedIsFresh =
          modelState.modelCatalogPhase == NewSessionModelCatalogPhase.ready &&
          modelState.modelTool == tool &&
          modelState.modelCatalogSource == currentSource &&
          selectedOption != null;
      if (!selectedIsFresh) {
        setState(() => _localIssue = _NewSessionIssue.modelRetired);
        return;
      }
      selectedModel = _selectionOf(
        selectedOption,
        preferredEffort: selectedModel.reasoningEffort,
      );
    }
    setState(() => _localIssue = null);
    if (!_start.isScheduled) {
      if (_submittingImmediate) return;
      final request = NewSessionLaunchRequest(
        tool: tool,
        directory: _directoryController.text,
        title: _titleController.text,
        model: selectedModel,
        modelSource: selectedModel == null
            ? null
            : modelState.modelCatalogSource,
      );
      setState(() => _submittingImmediate = true);
      widget.onImmediateLaunch(request);
      if (mounted) {
        Navigator.of(context).pop(ImmediateNewSessionResult(request));
      }
      return;
    }

    final text = _promptController.text.trim();
    if (text.isEmpty) {
      setState(() => _localIssue = _NewSessionIssue.firstMessageRequired);
      return;
    }
    if (schedulePromptIsTooLong(text)) {
      setState(() => _localIssue = _NewSessionIssue.firstMessageTooLong);
      return;
    }
    if (_start != NewSessionStart.cron &&
        scheduleDateTimeIsTooFarPast(_at, DateTime.now())) {
      setState(() => _localIssue = _NewSessionIssue.timeInPast);
      return;
    }
    setState(() => _submittingSchedule = true);
    String? timeZone;
    final repeat = _start.repeat;
    if (repeat != null || _start == NewSessionStart.cron) {
      timeZone = _timeZoneController.text.trim();
      if (timeZone.isEmpty) {
        timeZone = await ref.read(deviceTimeZoneResolverProvider)();
      }
      if (timeZone == null || timeZone.isEmpty) {
        if (mounted) {
          setState(() {
            _submittingSchedule = false;
            _localIssue = _NewSessionIssue.timeZoneRequired;
          });
        }
        return;
      }
    }
    final directory = _directoryController.text.trim();
    final title = _titleController.text.trim();
    final cronExpression = _cronController.text.trim();
    if (_start == NewSessionStart.cron && cronExpression.isEmpty) {
      setState(() {
        _submittingSchedule = false;
        _localIssue = _NewSessionIssue.cronRequired;
      });
      return;
    }
    final schedule = await ref
        .read(scheduleControllerProvider.notifier)
        .create(
          NewSessionScheduleCreate(
            tool: tool,
            directory: directory.isEmpty ? null : directory,
            title: title.isEmpty ? null : title,
            model: selectedModel,
            text: text,
            at: _start == NewSessionStart.cron
                ? null
                : _at.millisecondsSinceEpoch,
            repeat: repeat,
            timeZone: repeat == null ? null : timeZone,
            cron: _start == NewSessionStart.cron
                ? ScheduleCron(
                    expression: cronExpression,
                    timeZone: timeZone!,
                  )
                : null,
          ),
          expectedSource: selectedModel == null
              ? null
              : modelState.modelCatalogSource,
        );
    if (!mounted) return;
    setState(() => _submittingSchedule = false);
    if (schedule != null) {
      Navigator.of(context).pop(ScheduledNewSessionResult(schedule));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    ref.listen<RosterSource?>(
      activeBrokerProfileProvider.select(RosterSource.of),
      (previous, next) {
        if (previous == next || !mounted) return;
        setState(() {
          _selectedTool = null;
          _selectedModel = null;
          _selectedModelLabel = null;
          _declinedDefaultTools.clear();
          _localIssue = null;
        });
        // The source-qualified controller also rebuilds from this profile
        // change. Start the replacement request after that rebuild, never
        // through the dependency-stale notifier from the previous broker.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) unawaited(_loadAgents());
        });
      },
    );
    final state = ref.watch(newSessionControllerProvider);
    final scheduleState = ref.watch(scheduleControllerProvider);
    final scheduleError = switch (scheduleState.presentationIssue) {
      SchedulePresentationIssue.modelSourceMismatch =>
        l10n.newSessionModelSourceMismatch,
      null when scheduleState.error != null => localizedFailureText(
        l10n,
        scheduleState.error!,
      ),
      null => null,
    };
    final displayError = _localIssue == null
        ? state.error == null
              ? scheduleError
              : localizedFailureText(l10n, state.error!)
        : _newSessionIssueMessage(l10n, _localIssue!);
    final agents = state.agents;
    final effectiveTool = agents.any((agent) => agent.id == _selectedTool)
        ? _selectedTool
        : agents.firstOrNull?.id;
    final modelOptions = state.modelTool == effectiveTool
        ? state.models
        : const <ModelOption>[];
    final selectedModelKey = _selectedModel == null
        ? ''
        : _modelKey(_selectedModel!);
    final selectedModelOption = _selectedModel == null
        ? null
        : modelOptions
              .where(
                (option) => _modelKey(_selectionOf(option)) == selectedModelKey,
              )
              .firstOrNull;
    final selectedIsInCatalog =
        _selectedModel == null || selectedModelOption != null;
    final reasoningEfforts =
        selectedModelOption?.reasoningEfforts ?? const <ReasoningEffort>[];
    final selectedReasoningEffort = selectedModelOption == null
        ? null
        : _effortFor(
            selectedModelOption,
            preferred: _selectedModel?.reasoningEffort,
          );
    final projectLabel = widget.projectName?.trim();
    final projectContextLabel = projectLabel == null || projectLabel.isEmpty
        ? l10n.newSessionProjectFallback
        : projectLabel;
    final busy = state.isBusy || _submittingImmediate || _submittingSchedule;
    // Immediate creation has already left the sheet for the page-level flow.
    // Only an in-flight scheduled create keeps this sheet and button busy.
    final submitting = _submittingSchedule;
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + bottomInset),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SelectableText(
              l10n.newSessionTitle,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            if (widget.initialDirectory.trim().isNotEmpty) ...[
              const SizedBox(height: 8),
              SelectableText(
                '$projectContextLabel · ${widget.initialDirectory}',
                key: const Key('new-session-project-context'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            const SizedBox(height: 16),
            KeyedSubtree(
              key: const Key('new-session-agent'),
              child: DropdownButtonFormField<String>(
                key: ValueKey(effectiveTool),
                initialValue: effectiveTool,
                decoration: InputDecoration(
                  labelText: l10n.newSessionAgentLabel,
                ),
                items: [
                  for (final agent in agents)
                    DropdownMenuItem(
                      value: agent.id,
                      child: Text(agent.displayName),
                    ),
                ],
                onChanged: busy
                    ? null
                    : (value) {
                        if (value != null) unawaited(_selectTool(value));
                      },
              ),
            ),
            if (state.phase == NewSessionPhase.loadingAgents)
              const LinearProgressIndicator(
                key: Key('new-session-agent-loading'),
              ),
            if (!state.isBusy && agents.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: SelectableText(l10n.newSessionNoAgents),
              ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              // The selection is part of the key because FormFieldState
              // latches initialValue only at creation: an async per-tool
              // default prefill (or any programmatic selection change) must
              // recreate the field, or it keeps DISPLAYING "Default" while
              // _submit sends the remembered model.
              key: ValueKey(
                'new-session-model-${effectiveTool ?? 'none'}-'
                '${state.modelCatalogPhase.name}-$selectedModelKey',
              ),
              initialValue: selectedModelKey,
              decoration: InputDecoration(
                labelText: l10n.newSessionModelLabel,
              ),
              items: [
                DropdownMenuItem(
                  value: '',
                  child: Text(l10n.newSessionModelDefault),
                ),
                for (final option in modelOptions)
                  DropdownMenuItem(
                    value: _modelKey(_selectionOf(option)),
                    child: Tooltip(
                      message: _modelTooltip(option),
                      child: Text(
                        option.label,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                if (_selectedModel != null && !selectedIsInCatalog)
                  DropdownMenuItem(
                    value: selectedModelKey,
                    enabled: false,
                    child: Text(
                      _selectedModelLabel ?? _selectedModel!.modelID,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: busy
                  ? null
                  : (value) {
                      if (value == null) return;
                      final tool = effectiveTool;
                      if (tool == null) return;
                      // Provenance BEFORE any state mutation. The menu
                      // outlives the build that rendered it: its result can
                      // be delivered after a broker/incarnation switch
                      // replaced the catalog. A callback whose rendered
                      // catalog is no longer the active broker's current
                      // catalog is a stale echo — a COMPLETE no-op for both
                      // branches: no selection, no declined default, no save.
                      final renderedSource = state.modelCatalogSource;
                      final source = RosterSource.of(
                        ref.read(activeBrokerProfileProvider),
                      );
                      final catalog = ref.read(newSessionControllerProvider);
                      if (source == null ||
                          renderedSource != source ||
                          catalog.modelTool != tool ||
                          catalog.modelCatalogSource != source) {
                        return;
                      }
                      if (value.isEmpty) {
                        setState(() {
                          _selectedModel = null;
                          _selectedModelLabel = null;
                          _declinedDefaultTools.add(tool);
                          _localIssue = null;
                        });
                        return;
                      }
                      // Resolve against the CURRENT catalog, not the menu's
                      // captured options: a value it no longer advertises
                      // (retired between render and pick, or stale cross-broker
                      // residue) is a no-op, never an exception. Submission
                      // freshness stays _submit's job; this gate is provenance.
                      ModelOption? option;
                      for (final candidate in catalog.models) {
                        if (_modelKey(_selectionOf(candidate)) == value) {
                          option = candidate;
                          break;
                        }
                      }
                      if (option == null) return;
                      // A promoted local: closure capture blocks promotion.
                      final picked = option;
                      final selection = _selectionOf(picked);
                      setState(() {
                        _selectedModel = selection;
                        _selectedModelLabel = picked.label;
                        _declinedDefaultTools.remove(tool);
                        _localIssue = null;
                      });
                      // An explicit pick here is also the "last picked model"
                      // for this tool, even if the session is never opened or
                      // the model is never re-picked inside it.
                      unawaited(
                        ref
                            .read(sessionModelPreferenceStoreProvider)
                            .saveToolDefault(
                              brokerProfileId: source.storageKey,
                              tool: tool,
                              model: selection,
                            )
                            .catchError((Object _, StackTrace _) {}),
                      );
                    },
            ),
            if (selectedModelOption != null && reasoningEfforts.isNotEmpty) ...[
              const SizedBox(height: 12),
              KeyedSubtree(
                key: const Key('new-session-reasoning-effort'),
                child: DropdownButtonFormField<String>(
                  key: ValueKey(
                    'new-session-reasoning-effort-$selectedModelKey-'
                    '${selectedReasoningEffort ?? 'none'}',
                  ),
                  initialValue: selectedReasoningEffort,
                  decoration: InputDecoration(labelText: l10n.reasoningEffort),
                  items: [
                    for (final effort in reasoningEfforts)
                      DropdownMenuItem(
                        value: effort.effort,
                        child: effort.description == null
                            ? Text(effort.label)
                            : Tooltip(
                                message: effort.description,
                                child: Text(effort.label),
                              ),
                      ),
                  ],
                  onChanged: busy
                      ? null
                      : (value) {
                          final tool = effectiveTool;
                          if (tool == null || value == null) return;
                          _selectReasoningEffort(
                            tool: tool,
                            renderedSource: state.modelCatalogSource,
                            effort: value,
                          );
                        },
                ),
              ),
            ],
            if (state.modelCatalogPhase ==
                    NewSessionModelCatalogPhase.unavailable &&
                effectiveTool != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: SelectableText(l10n.newSessionModelUnavailable),
              )
            else if (state.modelCatalogPhase ==
                NewSessionModelCatalogPhase.loading)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: SelectableText(l10n.newSessionModelLoading),
              )
            else if (state.modelCatalogPhase ==
                    NewSessionModelCatalogPhase.ready &&
                modelOptions.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: SelectableText(l10n.newSessionModelEmpty),
              )
            else if (state.modelCatalogPhase ==
                NewSessionModelCatalogPhase.failed)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Row(
                  children: [
                    Expanded(
                      child: SelectableText(
                        _modelFailureText(
                          l10n,
                          state.modelError,
                          retainedOptions: modelOptions.isNotEmpty,
                        ),
                      ),
                    ),
                    TextButton(
                      key: const Key('new-session-model-refresh'),
                      onPressed: effectiveTool == null || busy
                          ? null
                          : () => unawaited(
                              ref
                                  .read(
                                    newSessionControllerProvider.notifier,
                                  )
                                  .loadModels(effectiveTool)
                                  .then(
                                    (_) => _applyToolModelDefault(
                                      effectiveTool,
                                    ),
                                  ),
                            ),
                      child: Text(l10n.newSessionModelRefresh),
                    ),
                  ],
                ),
              ),
            if (_selectedModel != null &&
                state.modelCatalogPhase == NewSessionModelCatalogPhase.ready &&
                !selectedIsInCatalog)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: SelectableText(l10n.newSessionModelRetired),
              ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('new-session-directory'),
              controller: _directoryController,
              enabled: !busy,
              decoration: InputDecoration(
                labelText: l10n.newSessionDirectoryLabel,
                hintText: l10n.newSessionDirectoryHint,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('new-session-title'),
              controller: _titleController,
              enabled: !busy,
              decoration: InputDecoration(
                labelText: l10n.newSessionSessionTitleLabel,
                hintText: l10n.optional,
              ),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<NewSessionStart>(
              key: const Key('new-session-start'),
              initialValue: _start,
              decoration: InputDecoration(labelText: l10n.newSessionStartLabel),
              items: [
                DropdownMenuItem(
                  value: NewSessionStart.now,
                  child: Text(l10n.newSessionStartNow),
                ),
                DropdownMenuItem(
                  value: NewSessionStart.once,
                  child: Text(l10n.newSessionStartOnce),
                ),
                DropdownMenuItem(
                  value: NewSessionStart.daily,
                  child: Text(l10n.newSessionStartDaily),
                ),
                DropdownMenuItem(
                  value: NewSessionStart.weekdays,
                  child: Text(l10n.newSessionStartWeekdays),
                ),
                DropdownMenuItem(
                  value: NewSessionStart.cron,
                  child: Text(l10n.newSessionStartCron),
                ),
              ],
              onChanged: busy
                  ? null
                  : (value) {
                      if (value != null) setState(() => _start = value);
                    },
            ),
            if (_start.isScheduled) ...[
              const SizedBox(height: 12),
              if (_start == NewSessionStart.cron) ...[
                TextField(
                  key: const Key('new-session-cron'),
                  controller: _cronController,
                  enabled: !busy,
                  decoration: InputDecoration(
                    labelText: l10n.scheduleCronExpressionLabel,
                    hintText: l10n.scheduleCronExpressionHint,
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('new-session-time-zone'),
                  controller: _timeZoneController,
                  enabled: !busy,
                  decoration: InputDecoration(
                    labelText: l10n.scheduleTimeZoneLabel,
                    hintText: l10n.newSessionTimeZoneHint,
                  ),
                ),
              ] else
                ScheduleDateTimeField(
                  value: _at,
                  onChanged: (value) => setState(() => _at = value),
                  label: l10n.newSessionFirstRunLabel,
                  keyPrefix: 'new-session-at',
                ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('new-session-first-message'),
                controller: _promptController,
                enabled: !busy,
                minLines: 2,
                maxLines: 5,
                decoration: InputDecoration(
                  labelText: l10n.newSessionFirstMessageLabel,
                  hintText: l10n.newSessionFirstMessageHint,
                ),
              ),
            ],
            if (displayError case final error?) ...[
              const SizedBox(height: 12),
              SelectableText(
                error,
                key: const Key('new-session-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: busy ? null : () => Navigator.of(context).pop(),
                  child: Text(l10n.cancel),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const Key('new-session-submit'),
                  onPressed: busy || agents.isEmpty
                      ? null
                      : () => unawaited(_submit(agents)),
                  child: submitting
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(
                                key: Key('new-session-submit-progress'),
                                strokeWidth: 2,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Text(l10n.newSessionSchedulingLabel),
                          ],
                        )
                      : Text(
                          _start.isScheduled
                              ? l10n.scheduleAction
                              : l10n.create,
                        ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

// A failed catalog refresh carries a typed reason. Render it, and keep the
// stale-choice warning when retained options stay selectable.
String _modelFailureText(
  AppLocalizations l10n,
  LocalizedFailure? failure, {
  required bool retainedOptions,
}) {
  if (failure == null) {
    return retainedOptions
        ? l10n.newSessionModelStale
        : l10n.newSessionModelFailed;
  }
  final text = localizedFailureText(l10n, failure);
  return retainedOptions ? '$text ${l10n.newSessionModelStaleNote}' : text;
}

String _newSessionIssueMessage(
  AppLocalizations l10n,
  _NewSessionIssue issue,
) => switch (issue) {
  _NewSessionIssue.noAgents => l10n.newSessionNoAgents,
  _NewSessionIssue.modelRetired => l10n.newSessionModelRetired,
  _NewSessionIssue.firstMessageRequired => l10n.newSessionFirstMessageRequired,
  _NewSessionIssue.firstMessageTooLong => l10n.newSessionFirstMessageTooLong(
    schedulePromptMaxCharacters,
  ),
  _NewSessionIssue.timeInPast => l10n.scheduleValidationFuture,
  _NewSessionIssue.timeZoneRequired => l10n.scheduleValidationTimeZone,
  _NewSessionIssue.cronRequired => l10n.scheduleValidationCron,
};
