import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// Local date/time picker shared by message and new-session schedules.
class ScheduleDateTimeField extends StatelessWidget {
  /// Creates the picker.
  const ScheduleDateTimeField({
    required this.value,
    required this.onChanged,
    required this.label,
    this.keyPrefix = 'schedule-at',
    super.key,
  });

  /// Current local date/time.
  final DateTime value;

  /// Reports a new local date/time.
  final ValueChanged<DateTime> onChanged;

  /// Field label.
  final String label;

  /// Stable test/accessibility key prefix.
  final String keyPrefix;

  Future<void> _pick(BuildContext context) async {
    final now = DateTime.now();
    final l10n = AppLocalizations.of(context);
    final date = await showDatePicker(
      context: context,
      initialDate: value,
      firstDate: now.subtract(const Duration(days: 1)),
      lastDate: DateTime(now.year + 5, 12, 31),
      confirmText: l10n.scheduleDateNext,
    );
    if (date == null || !context.mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(value),
      confirmText: MaterialLocalizations.of(context).okButtonLabel,
    );
    if (time == null) return;
    onChanged(
      DateTime(date.year, date.month, date.day, time.hour, time.minute),
    );
  }

  @override
  Widget build(BuildContext context) {
    return InputDecorator(
      decoration: InputDecoration(labelText: label),
      child: Row(
        children: [
          Expanded(
            child: Text(
              DateFormat.yMMMd().add_jm().format(value),
              key: ValueKey('$keyPrefix-value'),
            ),
          ),
          TextButton.icon(
            key: ValueKey('$keyPrefix-pick'),
            onPressed: () => _pick(context),
            icon: const Icon(Icons.event_outlined),
            label: Text(AppLocalizations.of(context).scheduleChange),
          ),
        ],
      ),
    );
  }
}
