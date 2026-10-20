import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_source_catalog.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_detail_dialog.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';

/// Complete eight-column report. Narrow panes scroll rather than losing data.
class UsageAgentTable extends StatefulWidget {
  /// Creates the per-source usage table.
  const UsageAgentTable({
    required this.tools,
    required this.locale,
    super.key,
  });

  /// Served per-source rows.
  final List<UsageReportTool> tools;

  /// Formatting locale.
  final String locale;

  @override
  State<UsageAgentTable> createState() => _UsageAgentTableState();
}

class _UsageAgentTableState extends State<UsageAgentTable> {
  int _sortColumn = 1;
  bool _ascending = false;

  String _count(num? value) =>
      value == null ? '—' : formatCompactCount(value, locale: widget.locale);

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final ranked = [...widget.tools]
      ..sort((a, b) {
        int order;
        if (_sortColumn == 0) {
          order = usageSourceDisplayName(
            a.tool,
            a.label,
          ).compareTo(usageSourceDisplayName(b.tool, b.label));
        } else {
          final av = _value(a, _sortColumn);
          final bv = _value(b, _sortColumn);
          // Unknown remains last in both directions.
          if (av == null) return bv == null ? 0 : 1;
          if (bv == null) return -1;
          order = av.compareTo(bv);
        }
        return _ascending ? order : -order;
      });
    final columns = [
      l10n.usageColAgent,
      l10n.usageTokensLabel,
      l10n.usageColSessions,
      l10n.usageColIn,
      l10n.usageColOut,
      l10n.usageColCache,
      l10n.usageColCost,
      l10n.usageColActive,
    ];
    return Column(
      key: const Key('usage-report-agents'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(title: l10n.usageByAgent),
        SingleChildScrollView(
          key: const Key('usage-agent-table-scroll'),
          scrollDirection: Axis.horizontal,
          child: DataTable(
            sortColumnIndex: _sortColumn,
            sortAscending: _ascending,
            headingRowHeight: 40,
            dataRowMinHeight: 44,
            dataRowMaxHeight: 44,
            horizontalMargin: 0,
            columnSpacing: 24,
            dividerThickness: 0,
            showCheckboxColumn: false,
            headingTextStyle: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textSecondary,
            ),
            dataTextStyle: theme.textTheme.bodySmall,
            columns: [
              for (var index = 0; index < columns.length; index++)
                DataColumn(
                  label: Text(columns[index]),
                  numeric: index > 0,
                  onSort: (column, ascending) => setState(() {
                    _sortColumn = column;
                    _ascending = ascending;
                  }),
                ),
            ],
            rows: [
              for (final tool in ranked)
                DataRow(
                  key: ValueKey(tool.tool),
                  onSelectChanged: (_) => showUsageDetailDialog(
                    context,
                    title: usageSourceDisplayName(tool.tool, tool.label),
                    locale: widget.locale,
                    tokens: tool.tokens,
                    cost: tool.cost,
                    input: tool.tokensIn,
                    output: tool.tokensOut,
                    cache: tool.tokensCache,
                    messages: tool.requests,
                    sessions: tool.sessions,
                    activeMs: tool.activeMs,
                  ),
                  cells: [
                    DataCell(
                      Row(
                        children: [
                          UsageAgentNameMark(
                            tool: tool.tool,
                            style: theme.textTheme.bodySmall!,
                          ),
                          const SizedBox(
                            width:
                                usageAgentNameMarkOffset -
                                usageAgentNameMarkSize,
                          ),
                          Text(
                            usageSourceDisplayName(tool.tool, tool.label),
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    DataCell(Text(_count(tool.tokens))),
                    DataCell(Text(_count(tool.sessions))),
                    DataCell(Text(_count(tool.tokensIn))),
                    DataCell(Text(_count(tool.tokensOut))),
                    DataCell(Text(_count(tool.tokensCache))),
                    DataCell(
                      Text(
                        formatUsageCost(
                          tool.cost,
                          locale: widget.locale,
                          compact: true,
                        ),
                      ),
                    ),
                    DataCell(
                      Text(
                        tool.activeMs == null
                            ? '—'
                            : formatUsageAgentTime(
                                tool.activeMs!,
                                locale: widget.locale,
                              ),
                      ),
                    ),
                  ],
                ),
            ],
          ),
        ),
      ],
    );
  }

  num? _value(UsageReportTool tool, int column) => switch (column) {
    1 => tool.tokens,
    2 => tool.sessions,
    3 => tool.tokensIn,
    4 => tool.tokensOut,
    5 => tool.tokensCache,
    6 => tool.cost,
    7 => tool.activeMs,
    _ => null,
  };
}
