import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/theme_spec.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
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
    required this.period,
    required this.report,
    required this.locale,
    super.key,
  });

  /// Period being reported; the cards title and lay out by it.
  final UsagePeriod period;

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
  // The palette the previews render in, resolved once per build from the
  // ambient tokens and reused by the export path, so the file name always
  // names the theme the captured card is actually wearing.
  late ThemeSpec _spec;
  bool _includeCost = false;
  bool _busy = false;
  String? _status;

  Future<void> _write(Set<UsageExportCardKind> kinds) async {
    final l10n = AppLocalizations.of(context);
    setState(() {
      _busy = true;
      _status = null;
    });
    final capture = ref.read(usageExportCaptureProvider);
    try {
      final files = <UsageExportFile>[];
      for (final kind in kinds) {
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
                spec: _spec,
              ),
              bytes: bytes,
            ),
          );
        }
      }
      if (files.length < kinds.length * usageExportBrightnesses.length) {
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
    // A card whose whole purpose is project names has nothing to carry when the
    // broker withheld them, and offering it would promise a tier this caller
    // cannot export.
    final offered = [
      for (final kind in UsageExportCardKind.values)
        if (!(kind.carriesProjectNames && widget.report.projectsWithheld)) kind,
    ];
    // Both previews build their own theme, but they stay in the palette the
    // app is actually wearing, so an export looks like the product it came
    // from rather than like a stock template. Read off the ambient tokens
    // rather than the theme controller: the controller reaches the on-disk
    // preferences store, and a report page should not open a database to
    // decide what colour to draw a preview.
    final spec = usageThemeSpecFor(context.tokens);
    _spec = spec;

    // The section still explains the two tiers where it cannot produce them:
    // the reader learns the export exists and where to run it, rather than
    // finding a button that fails.
    if (!ref.watch(usageExportSupportedProvider)) {
      return Column(
        key: const Key('usage-report-share'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          UsageSectionTitle(title: l10n.usageShareTitle),
          const SizedBox(height: 4),
          InlineNotice(
            key: const Key('usage-export-unsupported'),
            icon: Icons.desktop_windows_outlined,
            text: l10n.usageExportDesktopOnly,
          ),
        ],
      );
    }

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
        for (var index = 0; index < offered.length; index++) ...[
          if (index > 0) const SizedBox(height: 18),
          _TierGroup(
            kind: offered[index],
            boundaries: _boundaries,
            spec: spec,
            period: widget.period,
            report: widget.report,
            locale: widget.locale,
            includeCost: _includeCost,
            busy: _busy,
            onExport: () => _write({offered[index]}),
            // "All four" only exists while both tiers do, and it lives on the
            // higher tier's row: pressing it crosses every boundary the page
            // offers, so it sits where the most content is at stake.
            onExportAll:
                offered.length == UsageExportCardKind.values.length &&
                    offered[index].carriesProjectNames
                ? () => _write(offered.toSet())
                : null,
          ),
        ],
        const SizedBox(height: 8),
        UsageFootnote(text: l10n.usageExportBothThemes),
        // Two downloads from one press is exactly what a browser asks about,
        // and this sink cannot tell whether the second one landed.
        if (ref.watch(usageExportIsBrowserProvider))
          UsageFootnote(text: l10n.usageExportBrowserPrompt),
        if (_status != null) ...[
          const SizedBox(height: 8),
          InlineNotice(icon: Icons.check_circle_outline, text: _status!),
        ],
      ],
    );
  }
}

/// The registered theme whose palette the app is currently wearing.
///
/// Matched by palette rather than by a stored id, so the previews follow the
/// live theme without the share section depending on where that id is kept.
/// An unrecognized palette falls back to the default theme, which is the same
/// answer the id lookup gives for an unknown id.
ThemeSpec usageThemeSpecFor(AppTokens tokens) {
  for (final spec in kAppThemes) {
    for (final candidate in [spec.light, spec.dark]) {
      if (identical(candidate, tokens) ||
          (candidate.accent == tokens.accent &&
              candidate.canvas == tokens.canvas &&
              candidate.surface2 == tokens.surface2)) {
        return spec;
      }
    }
  }
  return themeSpecById(kDefaultThemeId);
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
///
/// The theme id rides in the name because the card wears the selected theme's
/// palette: two exports of the same window and tier under different themes are
/// different-looking images, and identical names would claim otherwise.
/// [ThemeSpec.id] is a lowercase slug (`teal-obsidian`), already filesystem
/// safe.
String usageExportFileName({
  required UsageExportCardKind kind,
  required Brightness brightness,
  required UsageReportRange range,
  required ThemeSpec spec,
}) {
  final tier = kind.carriesProjectNames ? 'projects' : 'overview';
  final theme = brightness == Brightness.dark ? 'dark' : 'light';
  return 'cosyncing-usage-${range.from}-${range.to}'
      '-$tier-${spec.id}-$theme.png';
}

/// One privacy tier: a colour-coded rail, a one-line brief, the two
/// thumbnails, and the buttons that write exactly this tier (plus "all four"
/// on the higher one).
///
/// The rail and chip wear the same colour the exported card prints its tier
/// label in, so the preview group reads as the card's provenance rather than
/// as decoration.
class _TierGroup extends StatelessWidget {
  const _TierGroup({
    required this.kind,
    required this.boundaries,
    required this.spec,
    required this.period,
    required this.report,
    required this.locale,
    required this.includeCost,
    required this.busy,
    required this.onExport,
    required this.onExportAll,
  });

  final UsageExportCardKind kind;
  final Map<(UsageExportCardKind, Brightness), GlobalKey> boundaries;
  final ThemeSpec spec;
  final UsagePeriod period;
  final UsageReport report;
  final String locale;
  final bool includeCost;
  final bool busy;
  final VoidCallback onExport;
  final VoidCallback? onExportAll;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final carriesNames = kind.carriesProjectNames;
    final tierColor = carriesNames ? tokens.statusNeedsInput : tokens.accent;
    return Container(
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: tierColor, width: 3)),
      ),
      padding: const EdgeInsets.only(left: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            carriesNames
                ? l10n.usageShareProjectsTitle
                : l10n.usageShareOverviewTitle,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 2),
          ConstrainedBox(
            // ~62 characters of the muted body copy, as on the source panel.
            constraints: const BoxConstraints(maxWidth: 460),
            child: Text(
              carriesNames
                  ? l10n.usageShareProjectsBody
                  : l10n.usageShareOverviewBody,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: tokens.textTertiary,
              ),
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 14,
            runSpacing: 14,
            children: [
              for (final brightness in usageExportBrightnesses)
                _Thumbnail(
                  boundaryKey: boundaries[(kind, brightness)]!,
                  brightness: brightness,
                  spec: spec,
                  kind: kind,
                  period: period,
                  report: report,
                  locale: locale,
                  includeCost: includeCost,
                  tierColor: tierColor,
                  chip: carriesNames
                      ? l10n.usageShareTierProjectsChip
                      : l10n.usageShareTierOverviewChip,
                ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              OutlinedButton(
                key: Key('usage-export-${kind.name}'),
                onPressed: busy ? null : onExport,
                style: OutlinedButton.styleFrom(
                  foregroundColor: context.tokens.accent,
                ),
                child: Text(
                  carriesNames
                      ? l10n.usageExportProject
                      : l10n.usageExportOverview,
                ),
              ),
              if (onExportAll case final onExportAll?)
                TextButton(
                  key: const Key('usage-export-all'),
                  onPressed: busy ? null : onExportAll,
                  child: Text(l10n.usageExportAll),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One thumbnail with its caption: the tier chip and the mode it renders in.
class _Thumbnail extends StatelessWidget {
  const _Thumbnail({
    required this.boundaryKey,
    required this.brightness,
    required this.spec,
    required this.kind,
    required this.period,
    required this.report,
    required this.locale,
    required this.includeCost,
    required this.tierColor,
    required this.chip,
  });

  final GlobalKey boundaryKey;
  final Brightness brightness;
  final ThemeSpec spec;
  final UsageExportCardKind kind;
  final UsagePeriod period;
  final UsageReport report;
  final String locale;
  final bool includeCost;
  final Color tierColor;
  final String chip;

  /// The edge a thumbnail is scaled to — small enough to read as a preview,
  /// large enough to audit the tier it belongs to.
  static const double width = 169;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: width,
          decoration: BoxDecoration(
            border: Border.all(color: tokens.separator),
            borderRadius: BorderRadius.circular(10),
          ),
          clipBehavior: Clip.antiAlias,
          child: _Preview(
            boundaryKey: boundaryKey,
            brightness: brightness,
            spec: spec,
            kind: kind,
            period: period,
            report: report,
            locale: locale,
            includeCost: includeCost,
          ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: tierColor.withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                chip.toUpperCase(),
                style: TextStyle(
                  color: tierColor,
                  fontSize: 10,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.6,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              brightness == Brightness.dark ? 'dark' : 'light',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: tokens.textTertiary,
                fontFamily: 'monospace',
                fontSize: 11,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// One preview, rendered in one theme.
///
/// The card is built at its true 360×640 inside the boundary and scaled for
/// display outside it, so the capture is full resolution while the preview
/// fits the thumbnail.
class _Preview extends StatelessWidget {
  const _Preview({
    required this.boundaryKey,
    required this.brightness,
    required this.spec,
    required this.kind,
    required this.period,
    required this.report,
    required this.locale,
    required this.includeCost,
  });

  final GlobalKey boundaryKey;
  final Brightness brightness;
  final ThemeSpec spec;
  final UsageExportCardKind kind;
  final UsagePeriod period;
  final UsageReport report;
  final String locale;
  final bool includeCost;

  @override
  Widget build(BuildContext context) {
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    // Every export writes both themes whatever the app is set to, so the
    // preview builds its own theme rather than inheriting the ambient one.
    final card = Theme(
      data: buildAppTheme(tokens, brightness),
      child: RepaintBoundary(
        key: boundaryKey,
        child: UsageExportCard(
          kind: kind,
          period: period,
          report: report,
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
