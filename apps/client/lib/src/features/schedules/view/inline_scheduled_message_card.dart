import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// A future user-turn-shaped card for one live existing-session schedule.
class InlineScheduledMessageCard extends StatelessWidget {
  /// Creates an inline scheduled-message card.
  const InlineScheduledMessageCard({
    required this.schedule,
    required this.busy,
    required this.onEdit,
    required this.onCancel,
    super.key,
  });

  /// Canonical live schedule row.
  final ScheduleRecord schedule;

  /// Whether edit or cancel is currently in flight.
  final bool busy;

  /// Opens the populated message editor.
  final VoidCallback onEdit;

  /// Cancels this exact schedule through the revision-free legacy route.
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final stateLabel = schedule.state == ScheduleState.paused
        ? l10n.scheduleStatePaused
        : l10n.scheduleStateScheduled;
    final stateColor = schedule.state == ScheduleState.paused
        ? tokens.statusIdle
        : tokens.accent;
    return Align(
      alignment: Alignment.centerRight,
      child: FractionallySizedBox(
        widthFactor: 0.93,
        child: Card(
          key: ValueKey('schedule-inline-card-${schedule.id}'),
          color: tokens.surface2,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SelectionArea(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(Icons.schedule_outlined, color: stateColor),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              l10n.scheduleInlineTitle,
                              style: theme.textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          StatusPill(
                            key: ValueKey(
                              'schedule-inline-state-${schedule.id}',
                            ),
                            label: stateLabel,
                            color: stateColor,
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        schedule.text,
                        key: ValueKey('schedule-inline-text-${schedule.id}'),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        DateFormat.yMMMd().add_jm().format(
                          DateTime.fromMillisecondsSinceEpoch(schedule.at),
                        ),
                        key: ValueKey('schedule-inline-at-${schedule.id}'),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: tokens.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      key: ValueKey('schedule-inline-edit-${schedule.id}'),
                      onPressed: busy ? null : onEdit,
                      child: Text(l10n.edit),
                    ),
                    TextButton(
                      key: ValueKey('schedule-inline-cancel-${schedule.id}'),
                      onPressed: busy ? null : onCancel,
                      child: Text(l10n.cancel),
                    ),
                    if (busy) ...[
                      const SizedBox(width: 8),
                      const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
