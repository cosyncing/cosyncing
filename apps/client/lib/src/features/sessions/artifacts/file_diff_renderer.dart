import 'dart:math' as math;

import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_source_body.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:flutter/material.dart';

/// Unified diff, rendered by default.
const String diffFileRendererId = 'diff';

/// The `.diff`/`.patch` renderer.
///
/// The one renderer that defaults to Rendered rather than Source: for every
/// other file type the bytes are the point, and for a patch the presentation
/// is. Source is one tap away.
FileRendererDescriptor diffFileRenderer() => const FileRendererDescriptor(
  id: diffFileRendererId,
  source: BuiltInRendererSource(),
  extensions: {'diff', 'patch'},
  mimeTypes: {'text/x-diff', 'text/x-patch'},
  modes: {FileViewMode.source, FileViewMode.rendered},
  defaultMode: FileViewMode.rendered,
  prepare: _prepareDiff,
  build: _buildDiff,
);

FileRenderPreparation _prepareDiff(FileRenderRequest request) {
  final text = switch (request.content) {
    TextFileContent(:final text) => text,
    BinaryFileContent() => '',
  };
  // The broker already caps the read at 1 MiB, so the parser's own display cap
  // would be a second, silent truncation on top of one the header already
  // explains. Lifted past anything a capped read can contain.
  final parsed = parseUnifiedDiff(text, maxLines: 1 << 22);
  return FileRenderPreparation(state: _DiffDocument.from(parsed));
}

Widget _buildDiff(BuildContext context, FileRenderRequest request) {
  if (request.mode == FileViewMode.source) {
    return FileSourceBody(
      lines: request.lines,
      surface: request.surface,
      tokens: request.tokens,
      anchorLine: request.anchorLine,
    );
  }
  final document = request.prepared as _DiffDocument?;
  if (document == null || document.rows.isEmpty) {
    return FileSourceBody(
      lines: request.lines,
      surface: request.surface,
      tokens: request.tokens,
    );
  }
  return _RenderedDiff(document: document, surface: request.surface);
}

/// A parsed patch flattened into uniform rows.
///
/// Every row is one line tall, headers included, so the dual gutter can be a
/// second list pinned beside the body and driven off the same offset — the
/// same arrangement the source body uses, for the same reason: a per-row
/// horizontal scroll would destroy the column alignment.
class _DiffDocument {
  const _DiffDocument(this.rows, this.longest);

  factory _DiffDocument.from(ParsedDiff parsed) {
    final rows = <_DiffRow>[];
    var longest = 0;
    var pendingFile = <DiffLine>[];
    String? pendingPath;
    var fileAt = -1;
    var additions = 0;
    var deletions = 0;

    void closeFile() {
      if (fileAt < 0) return;
      rows[fileAt] = _DiffFileRow(
        path: pendingPath ?? '',
        additions: additions,
        deletions: deletions,
      );
      fileAt = -1;
      additions = 0;
      deletions = 0;
      pendingPath = null;
      pendingFile = <DiffLine>[];
    }

    for (final line in parsed.lines) {
      final text = line.text;
      if (text.length > longest) longest = text.length;
      if (line.kind == DiffLineKind.meta) {
        final path = _pathFromMeta(text);
        if (path != null) {
          if (path != pendingPath) {
            closeFile();
            // Placeholder: the counts are only known once the file's hunks
            // have been walked, so the row is patched in by closeFile.
            fileAt = rows.length;
            rows.add(const _DiffFileRow(path: '', additions: 0, deletions: 0));
          }
          pendingPath = path;
        }
        continue;
      }
      if (line.kind == DiffLineKind.hunkHeader) {
        rows.add(_DiffHunkRow(text));
        continue;
      }
      if (line.kind == DiffLineKind.addition) additions++;
      if (line.kind == DiffLineKind.deletion) deletions++;
      pendingFile.add(line);
      rows.add(_DiffTextRow(line));
    }
    closeFile();
    return _DiffDocument(List.unmodifiable(rows), longest);
  }

  final List<_DiffRow> rows;
  final int longest;
}

/// `+++ b/path`, or `--- a/path` when the new side is /dev/null (a deletion).
String? _pathFromMeta(String text) {
  for (final prefix in const ['+++ b/', '+++ ', '--- a/', '--- ']) {
    if (!text.startsWith(prefix)) continue;
    final rest = text.substring(prefix.length).trim();
    if (rest.isEmpty || rest == '/dev/null') return null;
    return rest.split('\t').first;
  }
  return null;
}

sealed class _DiffRow {
  const _DiffRow();
}

final class _DiffFileRow extends _DiffRow {
  const _DiffFileRow({
    required this.path,
    required this.additions,
    required this.deletions,
  });

  final String path;
  final int additions;
  final int deletions;
}

final class _DiffHunkRow extends _DiffRow {
  const _DiffHunkRow(this.text);

  final String text;
}

final class _DiffTextRow extends _DiffRow {
  const _DiffTextRow(this.line);

  final DiffLine line;
}

/// Dual gutter width: two 1-based line numbers side by side.
const double _diffGutterWidth = 88;

class _RenderedDiff extends StatelessWidget {
  const _RenderedDiff({required this.document, required this.surface});

  final _DiffDocument document;
  final FileSourceSurface surface;

  @override
  Widget build(BuildContext context) {
    final tokens = Theme.of(context).extension<AppTokens>()!;
    final style = fileSourceCodeStyle(context);
    final extent = fileSourceLineExtent(context);
    final advance = _advance(context, style);
    final contentWidth = document.longest * advance + 24;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: _diffGutterWidth,
          child: ListView.builder(
            key: const Key('file-viewer-diff-gutter'),
            controller: surface.gutter,
            physics: const NeverScrollableScrollPhysics(),
            itemExtent: extent,
            padding: const EdgeInsets.only(top: 8, bottom: 16),
            itemCount: document.rows.length,
            itemBuilder: (context, index) =>
                _gutterFor(document.rows[index], tokens, style, extent),
          ),
        ),
        Expanded(
          child: SelectionArea(
            child: Scrollbar(
              controller: surface.horizontal,
              // A rendered diff never wraps: a wrapped diff is a broken diff,
              // because a continuation line is indistinguishable from a
              // context line once the +/- column has moved.
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                controller: surface.horizontal,
                child: SizedBox(
                  width: math.max(contentWidth, 1),
                  child: ListView.builder(
                    key: const Key('file-viewer-diff'),
                    controller: surface.vertical,
                    itemExtent: extent,
                    padding: const EdgeInsets.only(top: 8, bottom: 16),
                    itemCount: document.rows.length,
                    itemBuilder: (context, index) =>
                        _bodyFor(document.rows[index], tokens, style, extent),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _gutterFor(
    _DiffRow row,
    AppTokens tokens,
    TextStyle style,
    double extent,
  ) {
    if (row is! _DiffTextRow) return SizedBox(height: extent);
    final numbers = style.copyWith(color: tokens.textTertiary);
    return SizedBox(
      height: extent,
      child: Row(
        children: [
          Expanded(
            child: Align(
              alignment: Alignment.centerRight,
              child: Text(
                row.line.oldLine?.toString() ?? '',
                maxLines: 1,
                style: numbers,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Align(
              alignment: Alignment.centerRight,
              child: Text(
                row.line.newLine?.toString() ?? '',
                maxLines: 1,
                style: numbers,
              ),
            ),
          ),
          const SizedBox(width: 8),
        ],
      ),
    );
  }

  Widget _bodyFor(
    _DiffRow row,
    AppTokens tokens,
    TextStyle style,
    double extent,
  ) {
    switch (row) {
      case _DiffFileRow(:final path, :final additions, :final deletions):
        return Container(
          key: const Key('file-viewer-diff-file'),
          height: extent,
          color: tokens.surface,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: path,
                  style: style.copyWith(
                    color: tokens.textPrimary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const TextSpan(text: '  '),
                TextSpan(
                  text: '+$additions',
                  style: style.copyWith(color: tokens.diffAddText),
                ),
                const TextSpan(text: ' '),
                TextSpan(
                  text: '−$deletions',
                  style: style.copyWith(color: tokens.diffRemoveText),
                ),
              ],
            ),
            maxLines: 1,
          ),
        );
      case _DiffHunkRow(:final text):
        return Container(
          key: const Key('file-viewer-diff-hunk'),
          height: extent,
          color: tokens.surface,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Text(
            text,
            maxLines: 1,
            softWrap: false,
            style: style.copyWith(color: tokens.textSecondary),
          ),
        );
      case _DiffTextRow(:final line):
        final (background, foreground) = switch (line.kind) {
          DiffLineKind.addition => (tokens.diffAddSurface, tokens.diffAddText),
          DiffLineKind.deletion => (
            tokens.diffRemoveSurface,
            tokens.diffRemoveText,
          ),
          _ => (null, tokens.textPrimary),
        };
        final marker = switch (line.kind) {
          DiffLineKind.addition => '+',
          DiffLineKind.deletion => '-',
          _ => ' ',
        };
        return Container(
          height: extent,
          color: background,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Text(
            '$marker${line.text}',
            maxLines: 1,
            softWrap: false,
            style: style.copyWith(color: foreground),
          ),
        );
    }
  }

  double _advance(BuildContext context, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: '0', style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }
}
