import 'dart:async';
import 'dart:math' as math;

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// What the pane is showing.
///
/// A sealed union rather than a bag of nullable fields: every state below is a
/// different *panel*, and the compiler should refuse a pane that is somehow
/// loading and gone at once.
sealed class FileViewerContent {
  const FileViewerContent({required this.path, required this.displayName});

  /// Workspace-relative path, known before the read resolves.
  final String path;

  /// Basename used in the header.
  final String displayName;
}

/// The bounded read is in flight.
final class FileViewerReading extends FileViewerContent {
  /// Creates the reading state.
  const FileViewerReading({required super.path, required super.displayName});
}

/// Decoded text, ready to render.
final class FileViewerSource extends FileViewerContent {
  /// Creates the source state from a resolved [preview].
  FileViewerSource({required this.preview})
    : super(path: preview.path, displayName: preview.displayName);

  /// The broker's bounded read.
  final SessionFilePreview preview;
}

/// The path stopped resolving after the file was opened.
final class FileViewerGone extends FileViewerContent {
  /// Creates the gone state.
  const FileViewerGone({required super.path, required super.displayName});
}

/// Bytes the viewer will not guess at.
///
/// Named rather than rendered: `decodeSessionFileReadText` would hand back
/// mojibake for these, and a wall of replacement characters is a worse answer
/// than saying what the bytes are.
final class FileViewerUnsupported extends FileViewerContent {
  /// Creates the unsupported state.
  const FileViewerUnsupported({
    required super.path,
    required super.displayName,
    required this.typeLabel,
    required this.size,
  });

  /// MIME or human type name, e.g. `image/png`.
  final String typeLabel;

  /// Full file size in bytes.
  final int size;
}

/// The host does not serve workspace files.
///
/// `httpWorkspaceBrowsing` defaults off, so this is the state most installs
/// land in. It is a first-class panel, never a toast: the reader has to be
/// told what the gate is and what turning it on costs.
final class FileViewerGateClosed extends FileViewerContent {
  /// Creates the closed-gate state carrying the host's own [explanation].
  const FileViewerGateClosed({
    required super.path,
    required super.displayName,
    required this.explanation,
  });

  /// The broker's own wording for why the gate is shut.
  final String explanation;
}

/// Read-only file surface: sticky header, host notices, and a lazy body.
///
/// Replaces the `AlertDialog` preview. A widget rather than a route or a
/// dialog, so the same code serves the Files slot, the second split pane and
/// the compact drill-in route with no behavioural difference.
///
/// Two rules shape the whole build and are worth stating before the code:
///
/// * **Nothing here animates.** No `AnimationController`, no spinner, no
///   pulse. A file is not an activity, and a widget test asserts this pane
///   registers zero tickers. Loading is a gutter skeleton under a header that
///   has already painted.
/// * **Selection covers the body and nothing else.** Chrome sits in
///   `SelectionContainer.disabled` so a drag copies source, not headers —
///   the `_MonospaceDetailSection` pattern.
class FileViewerPane extends StatefulWidget {
  /// Creates a file viewer.
  const FileViewerPane({
    required this.content,
    required this.sessionLabel,
    required this.toolColor,
    this.onClose,
    this.onBrowseFiles,
    this.onRetry,
    super.key,
  });

  /// What to show.
  final FileViewerContent content;

  /// Owning session, already formatted as `tool · title`.
  ///
  /// Formatted by the caller because the pane holds no session types; the
  /// `·` separator is a literal, not a translatable string.
  final String sessionLabel;

  /// Identity color of the owning session's tool.
  ///
  /// The only tool hue in the file surface — everything else is neutral ink,
  /// so a file pane never reads as a second session.
  final Color toolColor;

  /// Closes this file.
  final VoidCallback? onClose;

  /// Re-browses the workspace from a state panel.
  final VoidCallback? onBrowseFiles;

  /// Re-issues the read from a state panel.
  final VoidCallback? onRetry;

  @override
  State<FileViewerPane> createState() => _FileViewerPaneState();
}

class _FileViewerPaneState extends State<FileViewerPane> {
  /// The one vertical controller. Anchor reveal, restore-on-reopen and any
  /// scroll-to-line all drive this object, which is what the dialog's
  /// constructed-but-unattached controller never did.
  final ScrollController _vertical = ScrollController();

  /// Follows [_vertical] so the pinned gutter tracks the body.
  final ScrollController _gutter = ScrollController();

  /// One horizontal offset for the whole code body.
  ///
  /// Per body, never per line: independently scrolling lines would destroy
  /// the column alignment that is the entire point of having a gutter.
  final ScrollController _horizontal = ScrollController();

  bool _wrap = false;
  bool _revealScheduled = false;

  @override
  void initState() {
    super.initState();
    _vertical.addListener(_syncGutter);
    _scheduleAnchorReveal();
  }

  @override
  void didUpdateWidget(covariant FileViewerPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.content.path != widget.content.path) {
      _wrap = false;
      _scheduleAnchorReveal();
    } else if (oldWidget.content is! FileViewerSource &&
        widget.content is FileViewerSource) {
      _scheduleAnchorReveal();
    }
  }

  @override
  void dispose() {
    _vertical
      ..removeListener(_syncGutter)
      ..dispose();
    _gutter.dispose();
    _horizontal.dispose();
    super.dispose();
  }

  void _syncGutter() {
    if (!_gutter.hasClients || !_vertical.hasClients) return;
    if (_gutter.offset == _vertical.offset) return;
    _gutter.jumpTo(
      _vertical.offset.clamp(
        _gutter.position.minScrollExtent,
        _gutter.position.maxScrollExtent,
      ),
    );
  }

  /// Centers the mention-carried line once the body has a viewport.
  ///
  /// A location move, not a selection, so it never fights a drag-copy.
  void _scheduleAnchorReveal() {
    if (_revealScheduled) return;
    _revealScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _revealScheduled = false;
      if (!mounted) return;
      final content = widget.content;
      if (content is! FileViewerSource) return;
      final anchor = content.preview.anchorLine;
      if (anchor == null || content.preview.anchorBeyondPreview) return;
      if (!_vertical.hasClients) return;
      final extent = _lineExtent(context);
      final viewport = _vertical.position.viewportDimension;
      final target = (anchor - 1) * extent - (viewport - extent) / 2;
      _vertical.jumpTo(
        target.clamp(
          _vertical.position.minScrollExtent,
          _vertical.position.maxScrollExtent,
        ),
      );
    });
  }

  /// Height of one code row, scaled with the ambient text scale.
  double _lineExtent(BuildContext context) {
    final style = _codeStyle(context);
    final scaled = MediaQuery.textScalerOf(context).scale(style.fontSize!);
    return (scaled * 1.5).ceilToDouble();
  }

  TextStyle _codeStyle(BuildContext context) {
    final theme = Theme.of(context);
    return (theme.textTheme.bodySmall ?? const TextStyle(fontSize: 12))
        .copyWith(fontFamily: 'monospace', height: 1.5, fontSize: 12);
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final content = widget.content;
    return Column(
      key: const Key('file-viewer-pane'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Chrome is outside the body's SelectionArea entirely, so a drag that
        // starts on source cannot pull a header row in with it.
        SelectionContainer.disabled(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _header(context, tokens, l10n, content),
              ..._notices(context, tokens, l10n, content),
            ],
          ),
        ),
        Expanded(child: _body(context, tokens, l10n, content)),
      ],
    );
  }

  Widget _header(
    BuildContext context,
    AppTokens tokens,
    AppLocalizations l10n,
    FileViewerContent content,
  ) {
    final theme = Theme.of(context);
    final preview = content is FileViewerSource ? content.preview : null;
    final wrappable = content is FileViewerSource;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: tokens.surface,
        border: Border(bottom: BorderSide(color: tokens.separator)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            height: 40,
            child: Row(
              children: [
                const SizedBox(width: 12),
                FileMarkGlyph(
                  color: tokens.textSecondary,
                  foldColor: tokens.surface,
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    content.displayName,
                    key: const Key('file-viewer-name'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: tokens.textPrimary,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                // The owning session is named once, here, rather than
                // colour-coded onto every tab.
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: widget.toolColor,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 4),
                Flexible(
                  child: Text(
                    l10n.fileViewerFromSession(widget.sessionLabel),
                    key: const Key('file-viewer-owner'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: tokens.textTertiary,
                    ),
                  ),
                ),
                const Spacer(),
                if (wrappable)
                  _HeaderButton(
                    iconKey: const Key('file-viewer-wrap'),
                    icon: Icons.wrap_text,
                    tooltip: l10n.fileViewerWrap,
                    selected: _wrap,
                    tokens: tokens,
                    onPressed: () => setState(() => _wrap = !_wrap),
                  ),
                if (preview != null)
                  _HeaderButton(
                    iconKey: const Key('file-viewer-copy'),
                    icon: Icons.content_copy,
                    tooltip: l10n.transcriptCodeCopy,
                    tokens: tokens,
                    onPressed: () => unawaited(_copy(context, preview.text)),
                  ),
                if (widget.onClose case final close?)
                  _HeaderButton(
                    iconKey: const Key('file-viewer-close'),
                    icon: Icons.close,
                    tooltip: l10n.close,
                    tokens: tokens,
                    onPressed: close,
                  ),
                const SizedBox(width: 8),
              ],
            ),
          ),
          SizedBox(
            height: 28,
            child: Row(
              children: [
                const SizedBox(width: 12),
                Expanded(
                  child: _MiddleElidedPath(
                    path: content.path,
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontFamily: 'monospace',
                      color: tokens.textSecondary,
                    ),
                  ),
                ),
                if (preview != null) ...[
                  const SizedBox(width: 8),
                  MetadataChip(label: l10n.bytesCount(preview.size)),
                ],
                const SizedBox(width: 8),
                Text(
                  l10n.fileViewerReadOnly,
                  key: const Key('file-viewer-read-only'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: tokens.textTertiary,
                  ),
                ),
                const SizedBox(width: 12),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Host notices, always above the renderer and never renderer-drawn.
  List<Widget> _notices(
    BuildContext context,
    AppTokens tokens,
    AppLocalizations l10n,
    FileViewerContent content,
  ) {
    if (content is! FileViewerSource) return const [];
    final preview = content.preview;
    return [
      if (preview.truncated)
        _Notice(
          noticeKey: const Key('file-viewer-truncated'),
          tokens: tokens,
          // Lines delivered, and nothing more. A byte-capped read carries the
          // file's size but not its line count, and counting would need the
          // bytes that were withheld — so there is no honest "of N" to state.
          message: l10n.fileViewerTruncated(preview.previewedLineCount),
        ),
      // The existing honest note, preserved: silently landing on line 1 would
      // read as "the mention was wrong" rather than "the read was bounded".
      if (preview.anchorBeyondPreview)
        _Notice(
          noticeKey: const Key('file-viewer-anchor-beyond'),
          tokens: tokens,
          message: l10n.sessionFilePreviewAnchorBeyond(
            preview.anchorLine!,
            preview.previewedLineCount,
          ),
        ),
    ];
  }

  Widget _body(
    BuildContext context,
    AppTokens tokens,
    AppLocalizations l10n,
    FileViewerContent content,
  ) {
    return ColoredBox(
      color: tokens.surface2,
      child: switch (content) {
        FileViewerReading() => _skeleton(context, tokens),
        FileViewerSource(:final preview) => _source(context, tokens, preview),
        FileViewerGone() => _StatePanel(
          panelKey: const Key('file-viewer-gone'),
          tokens: tokens,
          title: l10n.fileViewerGoneTitle,
          body: l10n.fileViewerGoneBody,
          path: content.path,
          actions: [
            if (widget.onRetry case final retry?)
              (label: l10n.fileViewerTryAgain, onPressed: retry, primary: true),
            if (widget.onBrowseFiles case final browse?)
              (
                label: l10n.fileViewerBrowseFiles,
                onPressed: browse,
                primary: false,
              ),
          ],
        ),
        FileViewerUnsupported(:final typeLabel, :final size) => _StatePanel(
          panelKey: const Key('file-viewer-unsupported'),
          tokens: tokens,
          title: l10n.fileViewerNoPreview,
          body: l10n.fileViewerBinaryBody(typeLabel, l10n.bytesCount(size)),
          path: content.path,
          actions: [
            if (widget.onBrowseFiles case final browse?)
              (
                label: l10n.fileViewerBrowseFiles,
                onPressed: browse,
                primary: false,
              ),
          ],
        ),
        FileViewerGateClosed(:final explanation) => _StatePanel(
          panelKey: const Key('file-viewer-gate-closed'),
          tokens: tokens,
          title: l10n.sessionFilesBrowse,
          body: explanation,
          path: content.path,
          actions: const [],
        ),
      },
    );
  }

  /// A gutter-and-line skeleton. Deliberately not a spinner.
  Widget _skeleton(BuildContext context, AppTokens tokens) {
    final extent = _lineExtent(context);
    return ListView.builder(
      key: const Key('file-viewer-skeleton'),
      physics: const NeverScrollableScrollPhysics(),
      itemExtent: extent,
      padding: const EdgeInsets.only(top: 8),
      itemCount: 24,
      itemBuilder: (context, index) => Row(
        children: [
          SizedBox(
            width: 48,
            child: Align(
              alignment: Alignment.centerRight,
              child: Padding(
                padding: const EdgeInsets.only(right: 12),
                child: Container(
                  width: 14,
                  height: 6,
                  color: tokens.separator,
                ),
              ),
            ),
          ),
          Expanded(
            child: Container(
              height: 6,
              margin: EdgeInsets.only(
                right: 16 + (index % 5) * 48.0,
              ),
              color: tokens.separator,
            ),
          ),
        ],
      ),
    );
  }

  Widget _source(
    BuildContext context,
    AppTokens tokens,
    SessionFilePreview preview,
  ) {
    final lines = preview.text.isEmpty
        ? const <String>[]
        : preview.text.split('\n');
    final style = _codeStyle(context);
    final extent = _lineExtent(context);
    final anchor = preview.anchorBeyondPreview ? null : preview.anchorLine;

    // Wrapped mode has no horizontal axis to pin a gutter against, and rows
    // stop being uniform, so it is a different layout rather than a flag on
    // this one: one list, gutter top-aligned beside its wrapped block.
    if (_wrap) {
      return SelectionArea(
        child: ListView.builder(
          key: const Key('file-viewer-lines'),
          controller: _vertical,
          padding: const EdgeInsets.only(top: 8, bottom: 16),
          itemCount: lines.length,
          itemBuilder: (context, index) => Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _GutterCell(
                number: index + 1,
                anchored: index + 1 == anchor,
                tokens: tokens,
                style: style,
                height: extent,
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 16),
                  child: Text(lines[index], style: style),
                ),
              ),
            ],
          ),
        ),
      );
    }

    // Monospace makes the content width exact rather than a guess: one glyph
    // advance times the longest line, with no need to measure 20k rows.
    final advance = _monospaceAdvance(context, style);
    var longest = 0;
    for (final line in lines) {
      if (line.length > longest) longest = line.length;
    }
    final contentWidth = longest * advance + 16;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Pinned: outside the horizontal viewport entirely, so it cannot
        // scroll sideways. It follows the body vertically through _syncGutter.
        SizedBox(
          width: 48,
          child: ListView.builder(
            key: const Key('file-viewer-gutter'),
            controller: _gutter,
            physics: const NeverScrollableScrollPhysics(),
            itemExtent: extent,
            padding: const EdgeInsets.only(top: 8, bottom: 16),
            itemCount: lines.length,
            itemBuilder: (context, index) => _GutterCell(
              number: index + 1,
              anchored: index + 1 == anchor,
              tokens: tokens,
              style: style,
              height: extent,
            ),
          ),
        ),
        Expanded(
          child: SelectionArea(
            child: Scrollbar(
              controller: _horizontal,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                controller: _horizontal,
                child: SizedBox(
                  width: math.max(contentWidth, 1),
                  child: ListView.builder(
                    key: const Key('file-viewer-lines'),
                    controller: _vertical,
                    itemExtent: extent,
                    padding: const EdgeInsets.only(top: 8, bottom: 16),
                    itemCount: lines.length,
                    itemBuilder: (context, index) => Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        lines[index],
                        style: style,
                        softWrap: false,
                        maxLines: 1,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  double _monospaceAdvance(BuildContext context, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: '0', style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }

  Future<void> _copy(BuildContext context, String text) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.maybeOf(context);
    await Clipboard.setData(ClipboardData(text: text));
    messenger?.showSnackBar(
      SnackBar(content: Text(l10n.transcriptCodeCopied)),
    );
  }
}

/// One absolute line number.
///
/// The anchor reveal lives entirely here: an `accent` number and a 2dp accent
/// edge. There is deliberately no row wash — `accentSurface` cannot sit behind
/// highlighted code without dropping syntax tokens under the 4.5:1 bar the
/// theme sweep enforces (`accent_surface_token_test.dart` carries the numbers).
class _GutterCell extends StatelessWidget {
  const _GutterCell({
    required this.number,
    required this.anchored,
    required this.tokens,
    required this.style,
    required this.height,
  });

  final int number;
  final bool anchored;
  final AppTokens tokens;
  final TextStyle style;
  final double height;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 48,
      height: height,
      child: Row(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Align(
                alignment: Alignment.centerRight,
                child: Text(
                  '$number',
                  key: anchored ? const Key('file-viewer-anchor-number') : null,
                  maxLines: 1,
                  style: style.copyWith(
                    color: anchored ? tokens.accent : tokens.textTertiary,
                    fontWeight: anchored ? FontWeight.w600 : FontWeight.normal,
                  ),
                ),
              ),
            ),
          ),
          Container(
            key: anchored ? const Key('file-viewer-anchor-edge') : null,
            width: 2,
            color: anchored ? tokens.accent : Colors.transparent,
          ),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    required this.noticeKey,
    required this.tokens,
    required this.message,
  });

  final Key noticeKey;
  final AppTokens tokens;
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      key: noticeKey,
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: tokens.surface2,
        border: Border(bottom: BorderSide(color: tokens.separator)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, size: 14, color: tokens.textTertiary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
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

class _HeaderButton extends StatelessWidget {
  const _HeaderButton({
    required this.iconKey,
    required this.icon,
    required this.tooltip,
    required this.tokens,
    required this.onPressed,
    this.selected = false,
  });

  final Key iconKey;
  final IconData icon;
  final String tooltip;
  final AppTokens tokens;
  final VoidCallback onPressed;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: IconButton(
        key: iconKey,
        tooltip: tooltip,
        onPressed: onPressed,
        icon: Icon(icon, size: 14),
        isSelected: selected,
        style: IconButton.styleFrom(
          foregroundColor: selected ? tokens.accent : tokens.textSecondary,
          backgroundColor: selected ? tokens.accentSurface : null,
          padding: EdgeInsets.zero,
          minimumSize: const Size.square(28),
          maximumSize: const Size.square(28),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
    );
  }
}

/// A path elided in the middle, so the basename never disappears.
///
/// `TextOverflow.ellipsis` clips the tail, which for a path throws away the
/// only part the reader is looking for.
class _MiddleElidedPath extends StatelessWidget {
  const _MiddleElidedPath({required this.path, required this.style});

  final String path;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final scaler = MediaQuery.textScalerOf(context);
        final direction = Directionality.of(context);
        double widthOf(String value) {
          final painter = TextPainter(
            text: TextSpan(text: value, style: style),
            textDirection: direction,
            textScaler: scaler,
            maxLines: 1,
          )..layout();
          final width = painter.width;
          painter.dispose();
          return width;
        }

        var text = path;
        if (widthOf(text) > constraints.maxWidth) {
          var head = path.length ~/ 2;
          var tail = path.length - head;
          while (head > 1 && tail > 1 && widthOf(text) > constraints.maxWidth) {
            if (head > tail) {
              head--;
            } else {
              tail--;
            }
            text =
                '${path.substring(0, head)}…'
                '${path.substring(path.length - tail)}';
          }
        }
        return Text(
          text,
          key: const Key('file-viewer-path'),
          maxLines: 1,
          style: style,
        );
      },
    );
  }
}

typedef _PanelAction = ({String label, VoidCallback onPressed, bool primary});

class _StatePanel extends StatelessWidget {
  const _StatePanel({
    required this.panelKey,
    required this.tokens,
    required this.title,
    required this.body,
    required this.path,
    required this.actions,
  });

  final Key panelKey;
  final AppTokens tokens;
  final String title;
  final String body;
  final String path;
  final List<_PanelAction> actions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      key: panelKey,
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              FileMarkGlyph(
                color: tokens.textTertiary,
                foldColor: tokens.surface2,
                height: 31,
              ),
              const SizedBox(height: 16),
              Text(
                title,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: tokens.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                body,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: tokens.textSecondary,
                ),
              ),
              const SizedBox(height: 12),
              CopyableCodeLine(
                text: path,
                copyTooltip: AppLocalizations.of(context).transcriptCodeCopy,
                copiedMessage: AppLocalizations.of(
                  context,
                ).transcriptCodeCopied,
              ),
              if (actions.isNotEmpty) ...[
                const SizedBox(height: 16),
                Wrap(
                  spacing: 8,
                  alignment: WrapAlignment.center,
                  children: [
                    for (final action in actions)
                      action.primary
                          ? FilledButton(
                              onPressed: action.onPressed,
                              child: Text(action.label),
                            )
                          : OutlinedButton(
                              onPressed: action.onPressed,
                              child: Text(action.label),
                            ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
