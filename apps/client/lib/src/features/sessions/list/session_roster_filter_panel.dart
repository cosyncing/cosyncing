part of 'session_list_pane.dart';

/// Compact live filters shared by the anchored panel and the phone sheet.
class _RosterFilterPanel extends StatefulWidget {
  const _RosterFilterPanel({
    required this.filters,
    required this.tools,
    required this.onChanged,
    required this.onClose,
  });
  final SessionRosterFilters filters;
  final List<String> tools;
  final ValueChanged<SessionRosterFilters> onChanged;
  final VoidCallback onClose;
  @override
  State<_RosterFilterPanel> createState() => _RosterFilterPanelState();
}

class _RosterFilterPanelState extends State<_RosterFilterPanel> {
  late SessionRosterFilters _filters = widget.filters;
  late final _days = TextEditingController(text: '${_filters.customDays}');
  final _daysFocus = FocusNode();
  bool _invalid = false;

  @override
  void initState() {
    super.initState();
    _daysFocus.addListener(_commitOnBlur);
  }

  void _commitOnBlur() {
    if (!_daysFocus.hasFocus) _commitDays();
  }

  @override
  void dispose() {
    _daysFocus
      ..removeListener(_commitOnBlur)
      ..dispose();
    _days.dispose();
    super.dispose();
  }

  void _change(SessionRosterFilters filters) {
    setState(() => _filters = filters);
    widget.onChanged(filters);
  }

  void _commitDays() {
    if (_filters.activity != SessionActivityWindow.custom) return;
    final days = int.tryParse(_days.text.trim());
    if (days == null || days < 1 || days > 36500) {
      setState(() => _invalid = true);
      return;
    }
    setState(() => _invalid = false);
    if (days != _filters.customDays) {
      _change(_filters.copyWith(customDays: days));
    }
  }

  Widget _field(String label, Widget control) {
    final narrow =
        MediaQuery.sizeOf(context).width < 280 ||
        MediaQuery.textScalerOf(context).scale(14) > 20;
    final heading = Text(
      label,
      style: Theme.of(
        context,
      ).textTheme.bodySmall?.copyWith(color: context.tokens.textSecondary),
    );
    if (narrow) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [heading, const SizedBox(height: 4), control],
      );
    }
    return Row(
      children: [
        SizedBox(width: 80, child: heading),
        const SizedBox(width: 12),
        Expanded(child: control),
      ],
    );
  }

  void _stepDays(int amount) {
    final days = int.tryParse(_days.text.trim()) ?? _filters.customDays;
    _days.text = '${(days + amount).clamp(1, 36500)}';
    _commitDays();
  }

  Widget _select(
    String key,
    String value,
    List<(String, String)> choices,
    ValueChanged<String> change,
  ) => DropdownButtonHideUnderline(
    child: DropdownButton<String>(
      key: Key(key),
      value: choices.any((choice) => choice.$1 == value)
          ? value
          : choices.first.$1,
      isExpanded: true,
      itemHeight: null,
      style: Theme.of(context).textTheme.bodySmall,
      dropdownColor: context.tokens.surface,
      items: [
        for (final (id, label) in choices)
          DropdownMenuItem(
            value: id,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 40),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: Text(label, overflow: TextOverflow.ellipsis),
              ),
            ),
          ),
      ],
      onChanged: (value) {
        if (value != null) change(value);
      },
    ),
  );

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  l10n.sessionRosterFilters,
                  style: Theme.of(context).textTheme.labelLarge,
                ),
              ),
              IconButton(
                tooltip: l10n.close,
                onPressed: widget.onClose,
                icon: const StrokeIcon(StrokeGlyph.close),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _field(
            l10n.sessionRosterFilterStatus,
            _select(
              'session-roster-filter-status',
              _filters.status?.name ?? 'all',
              [
                ('all', l10n.sessionRosterAllStatuses),
                ('needsInput', l10n.sessionRosterStatusNeedsInput),
                ('working', l10n.sessionRosterStatusWorking),
                ('idle', l10n.sessionRosterStatusIdle),
              ],
              (value) => _change(
                _filters.copyWith(
                  status: value == 'all'
                      ? null
                      : SessionStatus.values.byName(value),
                  clearStatus: value == 'all',
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          _field(
            l10n.sessionRosterFilterAgent,
            _select(
              'session-roster-filter-agent',
              _filters.tool ?? 'all',
              [
                ('all', l10n.sessionRosterAllAgents),
                for (final tool in widget.tools)
                  (tool, sessionToolLabel(l10n, tool)),
              ],
              (value) => _change(
                _filters.copyWith(
                  tool: value == 'all' ? null : value,
                  clearTool: value == 'all',
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          _field(
            l10n.sessionRosterFilterActivity,
            _select(
              'session-roster-filter-activity',
              _filters.activity.name,
              [
                ('today', l10n.sessionRosterLast24Hours),
                ('last7Days', l10n.sessionRosterActivityLast7Days),
                ('last30Days', l10n.sessionRosterActivityLast30Days),
                ('any', l10n.sessionRosterActivityAny),
                ('custom', l10n.sessionRosterCustom),
              ],
              (value) {
                _invalid = false;
                _change(
                  _filters.copyWith(
                    activity: SessionActivityWindow.values.byName(value),
                  ),
                );
                if (value == 'custom') _daysFocus.requestFocus();
              },
            ),
          ),
          if (_filters.activity == SessionActivityWindow.custom) ...[
            const SizedBox(height: 8),
            _field(
              '',
              Row(
                children: [
                  Flexible(
                    child: Text(
                      l10n.sessionRosterLastPrefix,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 64,
                    child: CallbackShortcuts(
                      bindings: {
                        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                            _stepDays(1),
                        const SingleActivator(
                          LogicalKeyboardKey.arrowDown,
                        ): () =>
                            _stepDays(-1),
                      },
                      child: Semantics(
                        label: l10n.sessionRosterFilterActivity,
                        child: TextField(
                          key: const Key('session-roster-custom-days'),
                          controller: _days,
                          focusNode: _daysFocus,
                          textAlign: TextAlign.center,
                          keyboardType: TextInputType.number,
                          style: Theme.of(context).textTheme.bodySmall,
                          decoration: InputDecoration(
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            filled: true,
                            fillColor: context.tokens.surface2,
                            contentPadding: const EdgeInsets.all(8),
                            isDense: true,
                          ),
                          onSubmitted: (_) => _commitDays(),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      l10n.sessionRosterDaysSuffix,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
            if (_invalid)
              Text(
                l10n.sessionRosterInvalidDays,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: context.tokens.statusError,
                ),
              ),
          ],
          const SizedBox(height: 16),
          Row(
            key: const ValueKey('visibility-filter-row'),
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      l10n.sessionRosterShowHidden,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      l10n.sessionRosterShowHiddenHelp,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: context.tokens.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              Switch(
                key: const Key('session-roster-show-hidden'),
                value: _filters.showHidden,
                onChanged: (value) =>
                    _change(_filters.copyWith(showHidden: value)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            key: const ValueKey('filter-panel-actions'),
            children: [
              Expanded(
                child: Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton(
                    key: const Key('session-roster-clear-filters'),
                    onPressed: () {
                      _days.text = '3';
                      _invalid = false;
                      _change(
                        _kDefaultRosterFilters.copyWith(query: _filters.query),
                      );
                    },
                    child: Text(l10n.sessionRosterResetFilters),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: () {
                  _commitDays();
                  if (!_invalid) widget.onClose();
                },
                child: Text(l10n.done),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
