import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/settings/controller/theme_controller.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_export_card.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The two export cards, their live previews, and the one toggle.
///
/// Two images rather than one card with checkboxes. The privacy boundary is
/// which button the sender pressed, so nothing they set earlier can move
/// content across it — and each card prints its own manifest, so the recipient
/// can audit the image without trusting the sender's memory.
///
/// Both previews are rendered in both themes and both are what gets captured:
/// what is previewed is exactly what is exported.
class UsageShareSection extends ConsumerStatefulWidget {
  /// Creates the share section.
  const UsageShareSection({
    required this.report,
    required this.locale,
    super.key,
  });

  /// The served report the cards summarize.
  final UsageReport report;

  /// BCP-47 tag for figure formatting.
  final String locale;

  @override
  ConsumerState<UsageShareSection> createState() => _UsageShareSectionState();
}

class _UsageShareSectionState extends ConsumerState<UsageShareSection> {
  final Map<(UsageExportCardKind, Brightness), GlobalKey> _boundaries = {
    for (final kind in UsageExportCardKind.values)
      for (final brightness in usageExportBrightnesses)
        (kind, brightness): GlobalKey(),
  };
  late final TextEditingController _machine;
  bool _includeCost = false;
  bool _busy = false;
  String? _status;

  @override
  void initState() {
    super.initState();
    _machine = TextEditingController();
  }

  @override
  void dispose() {
    _machine.dispose();
    super.dispose();
  }

  Future<void> _export(UsageExportCardKind kind) async {
    final l10n = AppLocalizations.of(context);
    setState(() {
      _busy = true;
      _status = null;
    });
    final capture = ref.read(usageExportCaptureProvider);
    try {
      final files = <UsageExportFile>[];
      for (final brightness in usageExportBrightnesses) {
        final key = _boundaries[(kind, brightness)];
        if (key == null) continue;
        final bytes = await capture(key);
        if (bytes == null) continue;
        files.add(
          UsageExportFile(
            name: usageExportFileName(
              kind: kind,
              brightness: brightness,
              range: widget.report.range,
            ),
            bytes: bytes,
          ),
        );
      }
      if (files.length < usageExportBrightnesses.length) {
        setState(() => _status = l10n.usageExportFailed);
        return;
      }
      final written = await ref.read(usageExportSinkProvider).write(files);
      if (!mounted) return;
      setState(() {
        _status = written == null
            ? null
            : l10n.usageExportSaved(written.first, written.last);
      });
    } on Object {
      if (!mounted) return;
      setState(() => _status = l10n.usageExportFailed);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final machineLabel = _machine.text.trim().isEmpty
        ? l10n.usageTodayTitle
        : _machine.text.trim();
    // Both previews build their own theme, but they stay in the palette the
    // app is actually wearing, so an export looks like the product it came
    // from rather than like a stock template.
    final themeId =
        ref.watch(themeControllerProvider).valueOrNull?.themeId ??
        kDefaultThemeId;

    return Column(
      key: const Key('usage-report-share'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(title: l10n.usageShareTitle),
        Text(
          l10n.usageSharePreamble,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('usage-export-machine'),
          controller: _machine,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: l10n.usageMachineLabelField,
            border: const OutlineInputBorder(),
            isDense: true,
          ),
        ),
        const SizedBox(height: 8),
        SwitchListTile(
          key: const Key('usage-export-cost'),
          contentPadding: EdgeInsets.zero,
          value: _includeCost,
          // Self-qualifying, so the switch itself says what turning it on
          // means rather than relying on the reader to remember.
          title: Text(l10n.usageCostToggle),
          onChanged: (value) => setState(() => _includeCost = value),
        ),
        const SizedBox(height: 8),
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = <Widget>[
              for (final kind in UsageExportCardKind.values)
                _CardColumn(
                  kind: kind,
                  boundaries: _boundaries,
                  themeId: themeId,
                  report: widget.report,
                  machineLabel: machineLabel,
                  locale: widget.locale,
                  includeCost: _includeCost,
                  busy: _busy,
                  onExport: () => _export(kind),
                ),
            ];
            if (constraints.maxWidth < 780) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final column in columns)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: column,
                    ),
                ],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var index = 0; index < columns.length; index++) ...[
                  if (index > 0) const SizedBox(width: 16),
                  Expanded(child: columns[index]),
                ],
              ],
            );
          },
        ),
        const SizedBox(height: 8),
        UsageFootnote(text: l10n.usageExportBothThemes),
        if (_status != null) ...[
          const SizedBox(height: 8),
          InlineNotice(icon: Icons.check_circle_outline, text: _status!),
        ],
      ],
    );
  }
}

/// Both themes, light first.
///
/// `Brightness.values` is dark-first, and the copy promises "light and dark" —
/// so the order is stated here rather than inherited from an enum whose order
/// means nothing.
const List<Brightness> usageExportBrightnesses = [
  Brightness.light,
  Brightness.dark,
];

/// A file name that says what the image is without opening it.
String usageExportFileName({
  required UsageExportCardKind kind,
  required Brightness brightness,
  required UsageReportRange range,
}) {
  final tier = kind.carriesProjectNames ? 'projects' : 'overview';
  final theme = brightness == Brightness.dark ? 'dark' : 'light';
  return 'cosyncing-usage-${range.from}-${range.to}-$tier-$theme.png';
}

class _CardColumn extends StatelessWidget {
  const _CardColumn({
    required this.kind,
    required this.boundaries,
    required this.themeId,
    required this.report,
    required this.machineLabel,
    required this.locale,
    required this.includeCost,
    required this.busy,
    required this.onExport,
  });

  final UsageExportCardKind kind;
  final Map<(UsageExportCardKind, Brightness), GlobalKey> boundaries;
  final String themeId;
  final UsageReport report;
  final String machineLabel;
  final String locale;
  final bool includeCost;
  final bool busy;
  final VoidCallback onExport;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final brightness in usageExportBrightnesses) ...[
              if (brightness != usageExportBrightnesses.first)
                const SizedBox(width: 8),
              Expanded(
                child: _Preview(
                  boundaryKey: boundaries[(kind, brightness)]!,
                  brightness: brightness,
                  themeId: themeId,
                  kind: kind,
                  report: report,
                  machineLabel: machineLabel,
                  locale: locale,
                  includeCost: includeCost,
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          key: Key('usage-export-${kind.name}'),
          onPressed: busy ? null : onExport,
          style: OutlinedButton.styleFrom(
            foregroundColor: context.tokens.accent,
          ),
          child: Text(
            kind.carriesProjectNames
                ? l10n.usageExportProject
                : l10n.usageExportOverview,
          ),
        ),
      ],
    );
  }
}

/// One preview, rendered in one theme.
///
/// The card is built at its true 360×640 inside the boundary and scaled for
/// display outside it, so the capture is full resolution while the preview
/// fits the column.
class _Preview extends StatelessWidget {
  const _Preview({
    required this.boundaryKey,
    required this.brightness,
    required this.themeId,
    required this.kind,
    required this.report,
    required this.machineLabel,
    required this.locale,
    required this.includeCost,
  });

  final GlobalKey boundaryKey;
  final Brightness brightness;
  final String themeId;
  final UsageExportCardKind kind;
  final UsageReport report;
  final String machineLabel;
  final String locale;
  final bool includeCost;

  @override
  Widget build(BuildContext context) {
    final spec = themeSpecById(themeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    // Every export writes both themes whatever the app is set to, so the
    // preview builds its own theme rather than inheriting the ambient one.
    final card = Theme(
      data: buildAppTheme(tokens, brightness),
      child: RepaintBoundary(
        key: boundaryKey,
        child: UsageExportCard(
          kind: kind,
          report: report,
          machineLabel: machineLabel,
          locale: locale,
          includeCost: includeCost,
        ),
      ),
    );
    return AspectRatio(
      aspectRatio: usageExportCardWidth / usageExportCardHeight,
      child: FittedBox(child: card),
    );
  }
}
