import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';

/// Every tool on the machine, ranked by tokens.
///
/// Split by tokdash's own coding-apps classification: the harnesses it counts
/// as coding apps are the primary rows, everything else folds into one
/// expandable row. That split is served rather than a cosyncing-side list of
/// "tools we adapt", which would go stale the moment an adapter lands.
///
/// A cell the active-time API has no value for is an em dash, never a zero: no
/// reading and a reading of nothing are different facts.
class UsageAgentTable extends StatefulWidget {
  /// Creates the table.
  const UsageAgentTable({
    required this.tools,
    required this.locale,
    super.key,
  });

  /// Served per-tool rows.
  final List<UsageReportTool> tools;

  /// BCP-47 tag for figure formatting.
  final String locale;

  @override
  State<UsageAgentTable> createState() => _UsageAgentTableState();
}

class _UsageAgentTableState extends State<UsageAgentTable> {
  bool _othersOpen = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    if (widget.tools.isEmpty) return const SizedBox.shrink();

    final ranked = [...widget.tools]
      ..sort((a, b) => b.tokens.compareTo(a.tokens));
    final primary = ranked.where((tool) => tool.coding).toList();
    final others = ranked.where((tool) => !tool.coding).toList();
    // If tokdash classified nothing, one undifferentiated table is more honest
    // than an expander that hides every row behind a label about "other" tools.
    final rows = primary.isEmpty ? ranked : primary;
    final hidden = primary.isEmpty ? const <UsageReportTool>[] : others;

    final size = WindowSizeClass.of(context);
    final columns = _columnsFor(size);

    return Column(
      key: const Key('usage-report-agents'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(title: l10n.usageByAgent),
        _HeaderRow(columns: columns),
        for (final tool in rows)
          _ToolRow(
            tool: tool,
            columns: columns,
            locale: widget.locale,
            indented: false,
          ),
        if (hidden.isNotEmpty) ...[
          _OthersToggle(
            open: _othersOpen,
            label: _othersLabel(l10n, hidden),
            onTap: () => setState(() => _othersOpen = !_othersOpen),
          ),
          if (_othersOpen)
            for (final tool in hidden)
              _ToolRow(
                tool: tool,
                columns: columns,
                locale: widget.locale,
                indented: true,
              ),
        ],
      ],
    );
  }

  static String _othersLabel(
    AppLocalizations l10n,
    List<UsageReportTool> others,
  ) {
    var sessions = 0;
    var known = false;
    for (final tool in others) {
      final count = tool.sessions;
      if (count != null) {
        sessions += count;
        known = true;
      }
    }
    // A session count nobody served is left out of the label rather than
    // printed as zero.
    return known
        ? l10n.usageOtherToolsCount(sessions.toString())
        : l10n.usageOtherTools;
  }
}

/// Which columns survive at a given width, in print order.
///
/// The reads drop before the identity and the totals do: a table that has lost
/// its cache column is still a table, one that has lost the tool name is not.
List<_Column> _columnsFor(WindowSizeClass size) {
  return switch (size) {
    WindowSizeClass.compact => const [
      _Column.agent,
      _Column.tokens,
      _Column.sessions,
      _Column.cost,
      _Column.active,
    ],
    WindowSizeClass.medium => const [
      _Column.agent,
      _Column.tokens,
      _Column.sessions,
      _Column.tokensIn,
      _Column.tokensOut,
      _Column.cost,
      _Column.active,
    ],
    WindowSizeClass.expanded => const [
      _Column.agent,
      _Column.tokens,
      _Column.sessions,
      _Column.tokensIn,
      _Column.tokensOut,
      _Column.cache,
      _Column.cost,
      _Column.active,
    ],
  };
}

enum _Column {
  agent(flex: 3),
  tokens(flex: 2),
  sessions(flex: 1),
  tokensIn(flex: 2),
  tokensOut(flex: 2),
  cache(flex: 2),
  cost(flex: 2),
  active(flex: 2);

  const _Column({required this.flex});

  final int flex;

  String label(AppLocalizations l10n) => switch (this) {
    _Column.agent => l10n.usageColAgent,
    _Column.tokens => l10n.usageTokensLabel,
    _Column.sessions => l10n.usageColSessions,
    _Column.tokensIn => l10n.usageColIn,
    _Column.tokensOut => l10n.usageColOut,
    _Column.cache => l10n.usageColCache,
    // The qualifier rides in the header so every cell below can stay a bare
    // figure without ever reading as billed spend.
    _Column.cost => l10n.usageColCost,
    _Column.active => l10n.usageColActive,
  };
}

const String _emDash = '—';

class _HeaderRow extends StatelessWidget {
  const _HeaderRow({required this.columns});

  final List<_Column> columns;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          for (final column in columns)
            Expanded(
              flex: column.flex,
              child: Text(
                column.label(l10n),
                textAlign: column == _Column.agent
                    ? TextAlign.start
                    : TextAlign.end,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: tokens.textSecondary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ToolRow extends StatelessWidget {
  const _ToolRow({
    required this.tool,
    required this.columns,
    required this.locale,
    required this.indented,
  });

  final UsageReportTool tool;
  final List<_Column> columns;
  final String locale;
  final bool indented;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final style = theme.textTheme.bodySmall?.copyWith(
      color: indented ? tokens.textTertiary : null,
      fontFeatures: const [FontFeature.tabularFigures()],
    );

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: tokens.separator.withValues(alpha: 0.5)),
        ),
      ),
      child: Row(
        children: [
          for (final column in columns)
            Expanded(
              flex: column.flex,
              child: Padding(
                padding: EdgeInsets.only(
                  left: column == _Column.agent && indented ? 14 : 0,
                ),
                child: Text(
                  _cell(column, l10n),
                  textAlign: column == _Column.agent
                      ? TextAlign.start
                      : TextAlign.end,
                  overflow: TextOverflow.ellipsis,
                  style: style,
                ),
              ),
            ),
        ],
      ),
    );
  }

  String _cell(_Column column, AppLocalizations l10n) {
    switch (column) {
      case _Column.agent:
        return tool.label ?? tool.tool;
      case _Column.tokens:
        return formatCompactCount(tool.tokens, locale: locale);
      case _Column.sessions:
        final sessions = tool.sessions;
        return sessions == null
            ? _emDash
            : formatCompactCount(sessions, locale: locale);
      case _Column.tokensIn:
        return _optionalCount(tool.tokensIn);
      case _Column.tokensOut:
        return _optionalCount(tool.tokensOut);
      case _Column.cache:
        return _optionalCount(tool.tokensCache);
      case _Column.cost:
        return formatUsageCost(tool.cost, locale: locale, compact: true);
      case _Column.active:
        final active = tool.activeMs;
        return active == null
            ? _emDash
            : l10n.usageHoursValue(formatUsageHours(active, locale: locale));
    }
  }

  String _optionalCount(double? value) =>
      value == null ? _emDash : formatCompactCount(value, locale: locale);
}

class _OthersToggle extends StatelessWidget {
  const _OthersToggle({
    required this.open,
    required this.label,
    required this.onTap,
  });

  final bool open;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return InkWell(
      key: const Key('usage-report-other-tools'),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(color: tokens.separator.withValues(alpha: 0.5)),
          ),
        ),
        child: Row(
          children: [
            Icon(
              open ? Icons.expand_more : Icons.chevron_right,
              size: 16,
              color: tokens.textTertiary,
            ),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: tokens.textTertiary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
