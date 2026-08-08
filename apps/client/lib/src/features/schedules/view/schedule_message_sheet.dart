import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/schedules/controller/schedule_controller.dart';
import 'package:cosyncing_client/src/features/schedules/model/schedule_timing.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_date_time_field.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Opens one-shot scheduling for the current session's composer text.
Future<ScheduleRecord?> showScheduleMessageSheet(
  BuildContext context, {
  required String tool,
  required String sessionId,
  required String sessionTitle,
  required String text,
}) {
  return showModalBottomSheet<ScheduleRecord>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _ScheduleMessageSheet(
      tool: tool,
      sessionId: sessionId,
      sessionTitle: sessionTitle,
      text: text,
    ),
  );
}

/// Opens the same populated message sheet for a live schedule edit.
Future<ScheduleUpdate?> showScheduleMessageEditSheet(
  BuildContext context, {
  required ScheduleRecord schedule,
}) {
  return showModalBottomSheet<ScheduleUpdate>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _ScheduleMessageSheet(
      tool: schedule.tool,
      sessionId: schedule.sessionId ?? '',
      sessionTitle: schedule.sessionTitle ?? schedule.sessionId ?? '',
      text: schedule.text,
      schedule: schedule,
    ),
  );
}

class _ScheduleMessageSheet extends ConsumerStatefulWidget {
  const _ScheduleMessageSheet({
    required this.tool,
    required this.sessionId,
    required this.sessionTitle,
    required this.text,
    this.schedule,
  });

  final String tool;
  final String sessionId;
  final String sessionTitle;
  final String text;
  final ScheduleRecord? schedule;

  @override
  ConsumerState<_ScheduleMessageSheet> createState() =>
      _ScheduleMessageSheetState();
}

class _ScheduleMessageSheetState extends ConsumerState<_ScheduleMessageSheet> {
  late final TextEditingController _textController;
  late DateTime _at;
  _ScheduleMessageError? _localError;
  bool _submitting = false;

  /// N3b: this editor's value lives only in widget state — there is nowhere to
  /// flush it to, and returning to the underlying route after a web-update
  /// handoff would discard it silently. Holding defers the handoff for as long
  /// as the editor is open; closing it signals readiness immediately.
  VoidCallback? _releaseHandoffHold;

  @override
  void initState() {
    super.initState();
    _textController = TextEditingController(text: widget.text);
    _at = widget.schedule == null
        ? defaultScheduleDateTime(DateTime.now())
        : DateTime.fromMillisecondsSinceEpoch(widget.schedule!.at);
    _releaseHandoffHold = WebHandoffParticipants.instance.hold();
  }

  @override
  void dispose() {
    _releaseHandoffHold?.call();
    _releaseHandoffHold = null;
    _textController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final text = _textController.text.trim();
    if (text.isEmpty) {
      setState(() => _localError = _ScheduleMessageError.required);
      return;
    }
    if (schedulePromptIsTooLong(text)) {
      setState(() => _localError = _ScheduleMessageError.tooLong);
      return;
    }
    if (scheduleDateTimeIsTooFarPast(_at, DateTime.now())) {
      setState(() => _localError = _ScheduleMessageError.past);
      return;
    }
    setState(() {
      _submitting = true;
      _localError = null;
    });
    final existing = widget.schedule;
    final schedule = existing == null
        ? await ref
              .read(scheduleControllerProvider.notifier)
              .create(
                MessageScheduleCreate(
                  tool: widget.tool,
                  sessionId: widget.sessionId,
                  sessionTitle: widget.sessionTitle,
                  text: text,
                  at: _at.millisecondsSinceEpoch,
                ),
              )
        : null;
    if (!mounted) return;
    setState(() => _submitting = false);
    if (existing != null) {
      Navigator.of(context).pop(
        ScheduleUpdate(
          expectedRevision: existing.revision,
          text: text,
          at: _at.millisecondsSinceEpoch,
        ),
      );
    } else if (schedule != null) {
      Navigator.of(context).pop(schedule);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final createError = widget.schedule == null
        ? ref.watch(scheduleControllerProvider).error
        : null;
    final error = _localError == null
        ? createError == null
              ? null
              : l10n.scheduleCreateFailed
        : _scheduleMessageErrorCopy(l10n, _localError!);
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + bottomInset),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.schedule == null
                  ? l10n.scheduleMessageCreateTitle
                  : l10n.scheduleMessageEditTitle,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 6),
            SelectableText(
              l10n.scheduleMessageTarget(widget.sessionTitle, widget.tool),
            ),
            const SizedBox(height: 16),
            TextField(
              key: const Key('schedule-message-text'),
              controller: _textController,
              enabled: !_submitting,
              minLines: 2,
              maxLines: 6,
              decoration: InputDecoration(labelText: l10n.scheduleMessageLabel),
            ),
            const SizedBox(height: 12),
            ScheduleDateTimeField(
              value: _at,
              onChanged: (value) => setState(() => _at = value),
              label: l10n.scheduleSendAtLabel,
              keyPrefix: 'schedule-message-at',
            ),
            const SizedBox(height: 12),
            SelectableText(l10n.scheduleMessagePolicy),
            if (error != null) ...[
              const SizedBox(height: 12),
              SelectableText(
                error,
                key: const Key('schedule-message-error'),
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
                  key: Key(
                    widget.schedule == null
                        ? 'schedule-message-submit'
                        : 'schedule-message-edit-submit',
                  ),
                  onPressed: _submitting ? null : () => unawaited(_submit()),
                  child: Text(
                    widget.schedule == null ? l10n.scheduleAction : l10n.save,
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

enum _ScheduleMessageError { required, tooLong, past }

String _scheduleMessageErrorCopy(
  AppLocalizations l10n,
  _ScheduleMessageError error,
) {
  return switch (error) {
    _ScheduleMessageError.required => l10n.scheduleMessageRequired,
    _ScheduleMessageError.tooLong => l10n.scheduleMessageTooLong(
      schedulePromptMaxCharacters,
    ),
    _ScheduleMessageError.past => l10n.scheduleValidationFuture,
  };
}
