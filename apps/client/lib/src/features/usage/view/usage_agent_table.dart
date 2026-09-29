import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_source_catalog.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_detail_dialog.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Complete eight-column report. Narrow panes scroll rather than losing data.
class UsageAgentTable extends ConsumerStatefulWidget {
  /// Creates the table and source catalog.
  const UsageAgentTable({
    required this.tools,
    required this.locale,
    this.range,
    super.key,
  });

  /// Served per-source rows.
  final List<UsageReportTool> tools;

  /// Formatting locale.
  final String locale;

  /// Scope recorded in exported CSV, when this is a full report.
  final UsageReportRange? range;

  @override
  ConsumerState<UsageAgentTable> createState() => _UsageAgentTableState();
}

class _UsageAgentTableState extends ConsumerState<UsageAgentTable> {
  int _sortColumn = 1;
  bool _ascending = false;
  bool _exporting = false;

  String _count(num? value) =>
      value == null ? '—' : formatCompactCount(value, locale: widget.locale);

  Future<void> _export() async {
    if (_exporting) return;
    setState(() => _exporting = true);
    final l10n = AppLocalizations.of(context);
    try {
      final range = widget.range!;
      final file = UsageExportFile(
        name: 'cosyncing-usage-${range.from}-${range.to}.csv',
        bytes: utf8.encode(usageReportCsv(widget.tools, range)),
        mimeType: 'text/csv',
      );
      await ref.read(usageExportSinkProvider).write([file]);
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l10n.usageExportFailed)));
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

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
    final served = {for (final tool in widget.tools) tool.tool: tool};
    final catalog = <String, String>{
      ...usageSourceNames,
      for (final tool in widget.tools)
        tool.tool: usageSourceDisplayName(tool.tool, tool.label),
    };
    return Column(
      key: const Key('usage-report-agents'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            UsageSectionTitle(title: l10n.usageByAgent),
            if (widget.range != null && ref.watch(usageExportSupportedProvider))
              TextButton.icon(
                key: const Key('usage-export-csv'),
                onPressed: _exporting ? null : _export,
                icon: const Icon(Icons.download_outlined, size: 16),
                label: Text(l10n.usageEnhancementExportCsv),
              ),
          ],
        ),
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
        const SizedBox(height: 16),
        ExpansionTile(
          key: const Key('usage-source-catalog'),
          tilePadding: EdgeInsets.zero,
          childrenPadding: EdgeInsets.zero,
          title: Text(
            l10n.usageEnhancementIntegrations,
            style: theme.textTheme.bodyMedium,
          ),
          subtitle: Text(
            l10n.usageEnhancementIntegrationsHint,
            style: theme.textTheme.bodySmall,
          ),
          children: [
            for (final source in catalog.entries)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: UsageAgentLogo(tool: source.key),
                title: Text(source.value),
                trailing: Text(
                  served[source.key] == null
                      ? l10n.usageEnhancementNoReading
                      : _count(served[source.key]!.tokens),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: tokens.textTertiary,
                  ),
                ),
              ),
          ],
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

/// Period-scoped CSV with raw numbers and blank unknown measurements.
/// Text cells are escaped and spreadsheet formula prefixes are neutralized.
String usageReportCsv(List<UsageReportTool> tools, UsageReportRange range) {
  String cell(Object? value) {
    if (value == null) return '';
    var text = value.toString();
    if (value is String && RegExp(r'^\s*[=+@\-]').hasMatch(text)) {
      text = "'$text";
    }
    return '"${text.replaceAll('"', '""')}"';
  }

  final rows = <List<Object?>>[
    [
      'From',
      'To',
      'Agent',
      'Tokens',
      'Sessions',
      'Input',
      'Output',
      'Cache',
      'Estimated cost (USD)',
      'Active time (ms)',
    ],
    for (final tool in tools)
      [
        range.from,
        range.to,
        usageSourceDisplayName(tool.tool, tool.label),
        tool.tokens,
        tool.sessions,
        tool.tokensIn,
        tool.tokensOut,
        tool.tokensCache,
        tool.cost,
        tool.activeMs,
      ],
  ];
  return '${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n';
}
