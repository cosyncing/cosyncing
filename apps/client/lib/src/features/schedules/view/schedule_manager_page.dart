import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/schedule_controller.dart';
import 'package:cosyncing_client/src/features/schedules/platform/device_time_zone.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_date_time_field.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

/// Unified list for live and terminal scheduled sends.
class ScheduleManagerPage extends ConsumerStatefulWidget {
  /// Creates the schedule manager.
  const ScheduleManagerPage({super.key});

  @override
  ConsumerState<ScheduleManagerPage> createState() =>
      _ScheduleManagerPageState();
}

class _ScheduleManagerPageState extends ConsumerState<ScheduleManagerPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        unawaited(ref.read(scheduleControllerProvider.notifier).load());
      }
    });
  }

  Future<void> _edit(ScheduleRecord schedule) async {
    final update = await showModalBottomSheet<ScheduleUpdate>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _ScheduleEditor(schedule: schedule),
    );
    if (update == null || !mounted) return;
    await ref
        .read(scheduleControllerProvider.notifier)
        .update(schedule.id, update);
  }

  Future<void> _action(ScheduleRecord schedule, ScheduleAction action) {
    return ref
        .read(scheduleControllerProvider.notifier)
        .action(schedule.id, action);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    ref.listen(activeBrokerProfileProvider.select((profile) => profile?.id), (
      previous,
      next,
    ) {
      if (previous != next && mounted) {
        unawaited(ref.read(scheduleControllerProvider.notifier).load());
      }
    });
    final state = ref.watch(scheduleControllerProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.schedulesTitle),
        actions: [
          IconButton(
            tooltip: l10n.refresh,
            onPressed: state.loading
                ? null
                : () => unawaited(
                    ref.read(scheduleControllerProvider.notifier).load(),
                  ),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: ref.read(scheduleControllerProvider.notifier).load,
        child: ListView(
          key: const Key('schedule-manager-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: [
            if (state.loading && state.schedules.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (state.schedules.isEmpty)
              // This screen has no compose control of its own, so the body
              // has to name where schedules actually come from.
              Padding(
                padding: const EdgeInsets.all(32),
                child: SelectionArea(
                  child: Column(
                    children: [
                      Text(
                        l10n.schedulesEmptyTitle,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        l10n.schedulesEmptyBody,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              )
            else
              for (final schedule in state.schedules)
                _ScheduleCard(
                  schedule: schedule,
                  busy: state.mutatingIds.contains(schedule.id),
                  onEdit: () => unawaited(_edit(schedule)),
                  onAction: (action) => unawaited(_action(schedule, action)),
                  onDelete: () => unawaited(
                    ref
                        .read(scheduleControllerProvider.notifier)
                        .delete(schedule.id),
                  ),
                ),
            if (state.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: SelectableText(
                  l10n.schedulesLoadFailed,
                  key: const Key('schedule-manager-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ScheduleCard extends StatelessWidget {
  const _ScheduleCard({
    required this.schedule,
    required this.busy,
    required this.onEdit,
    required this.onAction,
    required this.onDelete,
  });

  final ScheduleRecord schedule;
  final bool busy;
  final VoidCallback onEdit;
  final ValueChanged<ScheduleAction> onAction;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final scheduledAt = DateFormat.yMMMd().add_jm().format(
      DateTime.fromMillisecondsSinceEpoch(schedule.at),
    );
    final repeat = switch (schedule.repeat) {
      ScheduleRepeat.daily => ' · ${l10n.scheduleRepeatDaily}',
      ScheduleRepeat.weekdays => ' · ${l10n.scheduleRepeatWeekdays}',
      null => '',
    };
    final timing = schedule.cron == null
        ? '$scheduledAt$repeat'
        : '${schedule.cron!.expression} · ${schedule.cron!.timeZone}';
    final target = schedule.kind == ScheduleKind.newSession
        ? schedule.title ?? l10n.scheduleNewSessionTarget(schedule.tool)
        : schedule.sessionTitle ?? '${schedule.tool}/${schedule.sessionId}';
    return Card(
      key: ValueKey('schedule-row-${schedule.id}'),
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SelectionArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          target,
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                      ),
                      _ScheduleStateChip(state: schedule.state),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(timing),
                  if (schedule.directory != null) Text(schedule.directory!),
                  if (schedule.retryPolicy case final retry?)
                    Text(
                      l10n.scheduleRetrySummary(
                        retry.maxRetries,
                        Duration(milliseconds: retry.delayMs).inMinutes,
                        _retryBackoffLabel(l10n, retry.backoff),
                      ),
                    ),
                  if (schedule.nextRetryAt case final retryAt?)
                    Text(
                      l10n.scheduleNextRetry(
                        DateFormat.yMMMd().add_jm().format(
                          DateTime.fromMillisecondsSinceEpoch(retryAt),
                        ),
                      ),
                    ),
                  const SizedBox(height: 8),
                  Text(
                    schedule.text,
                    key: ValueKey('schedule-prompt-${schedule.id}'),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (schedule.lastError != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      _scheduleLastFailureCopy(l10n, schedule.lastFailureKind),
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 10),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: 4,
              children: [
                if (schedule.state.isLive)
                  TextButton(
                    key: ValueKey('schedule-edit-${schedule.id}'),
                    onPressed: busy ? null : onEdit,
                    child: Text(l10n.edit),
                  ),
                if (schedule.state == ScheduleState.scheduled)
                  TextButton(
                    key: ValueKey('schedule-pause-${schedule.id}'),
                    onPressed: busy
                        ? null
                        : () => onAction(ScheduleAction.pause),
                    child: Text(l10n.pause),
                  ),
                if (schedule.state == ScheduleState.paused)
                  TextButton(
                    key: ValueKey('schedule-resume-${schedule.id}'),
                    onPressed: busy
                        ? null
                        : () => onAction(ScheduleAction.resume),
                    child: Text(l10n.resume),
                  ),
                if (_canRunNow(schedule))
                  TextButton(
                    key: ValueKey('schedule-run-now-${schedule.id}'),
                    onPressed: busy
                        ? null
                        : () => onAction(ScheduleAction.runNow),
                    child: Text(l10n.runNow),
                  ),
                if (_canRecoverQuota(schedule))
                  TextButton(
                    key: ValueKey('schedule-recover-quota-${schedule.id}'),
                    onPressed: busy
                        ? null
                        : () => onAction(ScheduleAction.recoverQuota),
                    child: Text(l10n.quotaRestored),
                  ),
                TextButton(
                  key: ValueKey('schedule-delete-${schedule.id}'),
                  onPressed: busy ? null : onDelete,
                  child: Text(
                    schedule.state.isLive ? l10n.cancel : l10n.remove,
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

class _ScheduleStateChip extends StatelessWidget {
  const _ScheduleStateChip({required this.state});

  final ScheduleState state;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final (label, color) = switch (state) {
      ScheduleState.scheduled => (l10n.scheduleStateScheduled, tokens.accent),
      ScheduleState.paused => (l10n.scheduleStatePaused, tokens.statusIdle),
      ScheduleState.delivered => (
        l10n.scheduleStateDelivered,
        tokens.statusWorking,
      ),
      ScheduleState.failed => (l10n.scheduleStateFailed, tokens.statusError),
      ScheduleState.missed => (l10n.scheduleStateMissed, tokens.statusError),
      ScheduleState.canceled => (l10n.scheduleStateCanceled, tokens.statusIdle),
      ScheduleState.unknown => (l10n.scheduleStateUnknown, tokens.statusIdle),
    };
    return StatusPill(label: label, color: color);
  }
}

bool _canRunNow(ScheduleRecord schedule) => switch (schedule.state) {
  ScheduleState.scheduled ||
  ScheduleState.failed ||
  ScheduleState.missed => true,
  ScheduleState.paused ||
  ScheduleState.delivered ||
  ScheduleState.canceled ||
  ScheduleState.unknown => false,
};

bool _canRecoverQuota(ScheduleRecord schedule) =>
    schedule.lastOutcome == ScheduleOutcome.failed &&
    schedule.lastFailureKind == ScheduleFailureKind.quota &&
    schedule.nextRetryAt == null &&
    _canRunNow(schedule);

String _retryBackoffLabel(AppLocalizations l10n, ScheduleRetryBackoff backoff) {
  return switch (backoff) {
    ScheduleRetryBackoff.fixed => l10n.scheduleRetryFixed,
    ScheduleRetryBackoff.exponential => l10n.scheduleRetryExponential,
  };
}

String _scheduleLastFailureCopy(
  AppLocalizations l10n,
  ScheduleFailureKind? kind,
) {
  return switch (kind) {
    ScheduleFailureKind.delivery => l10n.scheduleLastFailureDelivery,
    ScheduleFailureKind.quota => l10n.scheduleLastFailureQuota,
    ScheduleFailureKind.unknown || null => l10n.scheduleLastFailureUnknown,
  };
}

enum _ScheduleTiming { once, daily, weekdays, cron }

enum _ScheduleEditorError { message, past, timeZone, retry, cron }

class _ScheduleEditor extends ConsumerStatefulWidget {
  const _ScheduleEditor({required this.schedule});

  final ScheduleRecord schedule;

  @override
  ConsumerState<_ScheduleEditor> createState() => _ScheduleEditorState();
}

class _ScheduleEditorState extends ConsumerState<_ScheduleEditor> {
  late final TextEditingController _promptController;
  late final TextEditingController _titleController;
  late final TextEditingController _directoryController;
  late final TextEditingController _sessionTitleController;
  late final TextEditingController _cronController;
  late final TextEditingController _timeZoneController;
  late final TextEditingController _maxRetriesController;
  late final TextEditingController _delayMinutesController;
  late DateTime _at;
  late _ScheduleTiming _timing;
  late bool _retryEnabled;
  late ScheduleRetryBackoff _backoff;
  late bool _retryDelivery;
  late bool _retryQuota;
  _ScheduleEditorError? _error;
  bool _submitting = false;

  /// N3b: this editor's value lives only in widget state — there is nowhere to
  /// flush it to, and returning to the underlying route after a web-update
  /// handoff would discard it silently. Holding defers the handoff for as long
  /// as the editor is open; closing it signals readiness immediately.
  VoidCallback? _releaseHandoffHold;

  @override
  void initState() {
    super.initState();
    _releaseHandoffHold = WebHandoffParticipants.instance.hold();
    final schedule = widget.schedule;
    final retry = schedule.retryPolicy;
    _promptController = TextEditingController(text: schedule.text);
    _titleController = TextEditingController(text: schedule.title ?? '');
    _directoryController = TextEditingController(
      text: schedule.directory ?? '',
    );
    _sessionTitleController = TextEditingController(
      text: schedule.sessionTitle ?? '',
    );
    _cronController = TextEditingController(
      text: schedule.cron?.expression ?? '0 9 * * 1-5',
    );
    _timeZoneController = TextEditingController(
      text: schedule.cron?.timeZone ?? schedule.timeZone ?? '',
    );
    _maxRetriesController = TextEditingController(
      text: '${retry?.maxRetries ?? 2}',
    );
    final retryMinutes = retry == null
        ? 5
        : Duration(milliseconds: retry.delayMs).inMinutes.clamp(1, 1440);
    _delayMinutesController = TextEditingController(text: '$retryMinutes');
    _at = DateTime.fromMillisecondsSinceEpoch(schedule.at);
    _timing = schedule.cron != null
        ? _ScheduleTiming.cron
        : switch (schedule.repeat) {
            ScheduleRepeat.daily => _ScheduleTiming.daily,
            ScheduleRepeat.weekdays => _ScheduleTiming.weekdays,
            null => _ScheduleTiming.once,
          };
    _retryEnabled = retry != null;
    _backoff = retry?.backoff ?? ScheduleRetryBackoff.fixed;
    _retryDelivery =
        retry?.retryOn.contains(ScheduleFailureKind.delivery) ?? true;
    _retryQuota = retry?.retryOn.contains(ScheduleFailureKind.quota) ?? false;
  }

  @override
  void dispose() {
    _releaseHandoffHold?.call();
    _releaseHandoffHold = null;
    _promptController.dispose();
    _titleController.dispose();
    _directoryController.dispose();
    _sessionTitleController.dispose();
    _cronController.dispose();
    _timeZoneController.dispose();
    _maxRetriesController.dispose();
    _delayMinutesController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final text = _promptController.text.trim();
    if (text.isEmpty || text.length > 32000) {
      setState(() {
        _error = _ScheduleEditorError.message;
      });
      return;
    }
    if (_timing != _ScheduleTiming.cron &&
        _at.isBefore(DateTime.now().subtract(const Duration(minutes: 1)))) {
      setState(() => _error = _ScheduleEditorError.past);
      return;
    }

    setState(() {
      _submitting = true;
      _error = null;
    });
    var timeZone = _timeZoneController.text.trim();
    if (_timing != _ScheduleTiming.once && timeZone.isEmpty) {
      timeZone = await ref.read(deviceTimeZoneResolverProvider)() ?? '';
      if (timeZone.isNotEmpty) _timeZoneController.text = timeZone;
    }
    if (!mounted) return;
    if (_timing != _ScheduleTiming.once && timeZone.isEmpty) {
      setState(() {
        _submitting = false;
        _error = _ScheduleEditorError.timeZone;
      });
      return;
    }

    ScheduleRetryPolicy? retryPolicy;
    if (_retryEnabled) {
      final maxRetries = int.tryParse(_maxRetriesController.text.trim());
      final delayMinutes = int.tryParse(_delayMinutesController.text.trim());
      final retryOn = <ScheduleFailureKind>[
        if (_retryDelivery) ScheduleFailureKind.delivery,
        if (_retryQuota) ScheduleFailureKind.quota,
      ];
      if (maxRetries == null ||
          maxRetries < 0 ||
          maxRetries > 10 ||
          delayMinutes == null ||
          delayMinutes < 1 ||
          delayMinutes > 1440 ||
          retryOn.isEmpty) {
        setState(() {
          _submitting = false;
          _error = _ScheduleEditorError.retry;
        });
        return;
      }
      retryPolicy = ScheduleRetryPolicy(
        maxRetries: maxRetries,
        delayMs: Duration(minutes: delayMinutes).inMilliseconds,
        backoff: _backoff,
        retryOn: retryOn,
      );
    }

    final title = _titleController.text.trim();
    final directory = _directoryController.text.trim();
    final sessionTitle = _sessionTitleController.text.trim();
    final repeat = switch (_timing) {
      _ScheduleTiming.daily => ScheduleRepeat.daily,
      _ScheduleTiming.weekdays => ScheduleRepeat.weekdays,
      _ScheduleTiming.once || _ScheduleTiming.cron => null,
    };
    final cronExpression = _cronController.text.trim();
    if (_timing == _ScheduleTiming.cron && cronExpression.isEmpty) {
      setState(() {
        _submitting = false;
        _error = _ScheduleEditorError.cron;
      });
      return;
    }
    final update = ScheduleUpdate(
      expectedRevision: widget.schedule.revision,
      text: text,
      at: _timing == _ScheduleTiming.cron ? null : _at.millisecondsSinceEpoch,
      repeat: repeat,
      clearRepeat: repeat == null,
      cron: _timing == _ScheduleTiming.cron
          ? ScheduleCron(expression: cronExpression, timeZone: timeZone)
          : null,
      clearCron: _timing != _ScheduleTiming.cron,
      timeZone: repeat == null ? null : timeZone,
      clearTimeZone: repeat == null,
      retryPolicy: retryPolicy,
      clearRetryPolicy: !_retryEnabled,
      sessionTitle:
          widget.schedule.kind == ScheduleKind.message &&
              sessionTitle.isNotEmpty
          ? sessionTitle
          : null,
      clearSessionTitle:
          widget.schedule.kind == ScheduleKind.message && sessionTitle.isEmpty,
      directory:
          widget.schedule.kind == ScheduleKind.newSession &&
              directory.isNotEmpty
          ? directory
          : null,
      clearDirectory:
          widget.schedule.kind == ScheduleKind.newSession && directory.isEmpty,
      title: widget.schedule.kind == ScheduleKind.newSession && title.isNotEmpty
          ? title
          : null,
      clearTitle:
          widget.schedule.kind == ScheduleKind.newSession && title.isEmpty,
    );
    Navigator.of(context).pop(update);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final isNewSession = widget.schedule.kind == ScheduleKind.newSession;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + bottomInset),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l10n.scheduleEditorTitle,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 16),
            TextField(
              key: const Key('schedule-editor-message'),
              controller: _promptController,
              enabled: !_submitting,
              minLines: 2,
              maxLines: 6,
              decoration: InputDecoration(labelText: l10n.scheduleMessageLabel),
            ),
            const SizedBox(height: 12),
            if (isNewSession) ...[
              TextField(
                key: const Key('schedule-editor-title'),
                controller: _titleController,
                enabled: !_submitting,
                decoration: InputDecoration(
                  labelText: l10n.scheduleSessionTitleLabel,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('schedule-editor-directory'),
                controller: _directoryController,
                enabled: !_submitting,
                decoration: InputDecoration(
                  labelText: l10n.scheduleDirectoryLabel,
                ),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<_ScheduleTiming>(
                key: const Key('schedule-editor-timing'),
                initialValue: _timing,
                decoration: InputDecoration(
                  labelText: l10n.scheduleTimingLabel,
                ),
                items: [
                  DropdownMenuItem(
                    value: _ScheduleTiming.once,
                    child: Text(l10n.scheduleRepeatOnce),
                  ),
                  DropdownMenuItem(
                    value: _ScheduleTiming.daily,
                    child: Text(l10n.scheduleRepeatDaily),
                  ),
                  DropdownMenuItem(
                    value: _ScheduleTiming.weekdays,
                    child: Text(l10n.scheduleRepeatWeekdays),
                  ),
                  DropdownMenuItem(
                    value: _ScheduleTiming.cron,
                    child: Text(l10n.scheduleRepeatCron),
                  ),
                ],
                onChanged: _submitting
                    ? null
                    : (value) {
                        if (value != null) setState(() => _timing = value);
                      },
              ),
              const SizedBox(height: 12),
            ] else ...[
              TextField(
                key: const Key('schedule-editor-session-title'),
                controller: _sessionTitleController,
                enabled: !_submitting,
                decoration: InputDecoration(
                  labelText: l10n.scheduleSessionDisplayTitleLabel,
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (_timing == _ScheduleTiming.cron) ...[
              TextField(
                key: const Key('schedule-editor-cron'),
                controller: _cronController,
                enabled: !_submitting,
                decoration: InputDecoration(
                  labelText: l10n.scheduleCronExpressionLabel,
                  hintText: l10n.scheduleCronExpressionHint,
                ),
              ),
              const SizedBox(height: 12),
            ] else
              ScheduleDateTimeField(
                value: _at,
                onChanged: (value) => setState(() => _at = value),
                label: _timing == _ScheduleTiming.once
                    ? l10n.scheduleRunAtLabel
                    : l10n.scheduleNextRunLabel,
                keyPrefix: 'schedule-editor-at',
              ),
            if (_timing != _ScheduleTiming.once) ...[
              const SizedBox(height: 12),
              TextField(
                key: const Key('schedule-editor-time-zone'),
                controller: _timeZoneController,
                enabled: !_submitting,
                decoration: InputDecoration(
                  labelText: l10n.scheduleTimeZoneLabel,
                  hintText: 'Europe/London',
                ),
              ),
            ],
            const SizedBox(height: 12),
            SwitchListTile.adaptive(
              key: const Key('schedule-editor-retry-enabled'),
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.scheduleRetryFailedDelivery),
              value: _retryEnabled,
              onChanged: _submitting
                  ? null
                  : (value) => setState(() => _retryEnabled = value),
            ),
            if (_retryEnabled) ...[
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('schedule-editor-max-retries'),
                      controller: _maxRetriesController,
                      enabled: !_submitting,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: l10n.scheduleRetryCountLabel,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextField(
                      key: const Key('schedule-editor-retry-delay'),
                      controller: _delayMinutesController,
                      enabled: !_submitting,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        labelText: l10n.scheduleRetryDelayLabel,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<ScheduleRetryBackoff>(
                key: const Key('schedule-editor-retry-backoff'),
                initialValue: _backoff,
                decoration: InputDecoration(
                  labelText: l10n.scheduleRetryBackoffLabel,
                ),
                items: [
                  DropdownMenuItem(
                    value: ScheduleRetryBackoff.fixed,
                    child: Text(l10n.scheduleRetryFixed),
                  ),
                  DropdownMenuItem(
                    value: ScheduleRetryBackoff.exponential,
                    child: Text(l10n.scheduleRetryExponential),
                  ),
                ],
                onChanged: _submitting
                    ? null
                    : (value) {
                        if (value != null) setState(() => _backoff = value);
                      },
              ),
              CheckboxListTile(
                key: const Key('schedule-editor-retry-delivery'),
                contentPadding: EdgeInsets.zero,
                title: Text(l10n.scheduleRetryDeliveryFailures),
                value: _retryDelivery,
                onChanged: _submitting
                    ? null
                    : (value) =>
                          setState(() => _retryDelivery = value ?? false),
              ),
              CheckboxListTile(
                key: const Key('schedule-editor-retry-quota'),
                contentPadding: EdgeInsets.zero,
                title: Text(l10n.scheduleRetryQuotaFailures),
                value: _retryQuota,
                onChanged: _submitting
                    ? null
                    : (value) => setState(() => _retryQuota = value ?? false),
              ),
            ],
            if (_error case final error?) ...[
              const SizedBox(height: 8),
              SelectableText(
                _scheduleEditorErrorCopy(l10n, error),
                key: const Key('schedule-editor-error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _submitting
                      ? null
                      : () => Navigator.of(context).pop(),
                  child: Text(l10n.cancel),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const Key('schedule-editor-save'),
                  onPressed: _submitting ? null : () => unawaited(_submit()),
                  child: Text(l10n.save),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

String _scheduleEditorErrorCopy(
  AppLocalizations l10n,
  _ScheduleEditorError error,
) {
  return switch (error) {
    _ScheduleEditorError.message => l10n.scheduleValidationMessage,
    _ScheduleEditorError.past => l10n.scheduleValidationFuture,
    _ScheduleEditorError.timeZone => l10n.scheduleValidationTimeZone,
    _ScheduleEditorError.retry => l10n.scheduleValidationRetry,
    _ScheduleEditorError.cron => l10n.scheduleValidationCron,
  };
}
