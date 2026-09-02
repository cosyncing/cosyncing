import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_diff_renderer.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_renderer.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_source_body.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:flutter/material.dart';

/// Syntax-highlighted source.
const String codeFileRendererId = 'code';

/// Plain monospace text. Always registered, always last, never fails.
const String plainFileRendererId = 'plain';

/// Markdown, source or rendered.
const String markdownFileRendererId = 'markdown';

/// The renderers that ship with the app.
///
/// Order is significant: [resolveFileRenderer] breaks a tie between two
/// built-ins by registry order, so the more specific renderer comes first.
/// `.html` is claimed by both the markup-aware renderers and the code
/// renderer, and the specific one has to win.
List<FileRendererDescriptor> builtInFileRenderers() => [
  diffFileRenderer(),
  htmlFileRenderer(),
  const FileRendererDescriptor(
    id: markdownFileRendererId,
    source: BuiltInRendererSource(),
    extensions: {'md', 'markdown', 'mdx'},
    mimeTypes: {'text/markdown'},
    modes: {FileViewMode.source, FileViewMode.rendered},
    build: _buildMarkdown,
  ),
  FileRendererDescriptor(
    id: codeFileRendererId,
    source: const BuiltInRendererSource(),
    extensions: highlightableFileExtensions,
    basenames: const {'dockerfile', 'makefile'},
    prepare: _prepareCode,
    build: _buildCode,
  ),
  const FileRendererDescriptor(
    id: plainFileRendererId,
    source: BuiltInRendererSource(),
    extensions: {'txt', 'text', 'log'},
    mimeTypes: {'text/plain'},
    build: _buildPlain,
  ),
];

FileRenderPreparation _prepareCode(FileRenderRequest request) {
  final highlighter = TranscriptCodeLineHighlighter(
    request.lines,
    language: request.languageId ?? '',
  );
  return FileRenderPreparation(
    state: highlighter,
    // An unknown language was never offered highlighting, so there is nothing
    // to explain; a declined one renders grey and must say why.
    notice:
        highlighter.declined == null ||
            highlighter.declined == TranscriptCodeDecline.noProfile
        ? null
        : FileRenderNotice.highlightingOff,
  );
}

Widget _buildCode(BuildContext context, FileRenderRequest request) {
  final highlighter = request.prepared as TranscriptCodeLineHighlighter?;
  final styled =
      highlighter != null &&
      highlighter.hasProfile &&
      highlighter.declined == null;
  return FileSourceBody(
    lines: request.lines,
    surface: request.surface,
    tokens: request.tokens,
    anchorLine: request.anchorLine,
    spanBuilder: !styled
        ? null
        : (index, base) => [
            for (final token in highlighter.tokensFor(index))
              TextSpan(
                text: token.text,
                style: _syntaxStyle(base, token.kind, request.tokens),
              ),
          ],
  );
}

Widget _buildPlain(BuildContext context, FileRenderRequest request) {
  return FileSourceBody(
    lines: request.lines,
    surface: request.surface,
    tokens: request.tokens,
    anchorLine: request.anchorLine,
  );
}

Widget _buildMarkdown(BuildContext context, FileRenderRequest request) {
  if (request.mode == FileViewMode.source) {
    // Raw markdown is honest as-is and the highlighter has no markdown
    // profile, so source mode is plain mono rather than a half-styled guess.
    return _buildPlain(context, request);
  }
  final text = switch (request.content) {
    TextFileContent(:final text) => text,
    BinaryFileContent() => '',
  };
  return SelectionArea(
    child: ListView(
      key: const Key('file-viewer-rendered'),
      controller: request.surface.vertical,
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
      children: [
        // 72ch measure: the transcript's blocks at file scale, not a new set.
        // A second markdown implementation would drift from the transcript's
        // within a release.
        Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: buildTranscriptMarkdownBody(text),
          ),
        ),
      ],
    ),
  );
}

TextStyle _syntaxStyle(
  TextStyle base,
  TranscriptCodeTokenKind kind,
  AppTokens tokens,
) {
  return base.copyWith(
    color: switch (kind) {
      TranscriptCodeTokenKind.plain => tokens.textPrimary,
      TranscriptCodeTokenKind.keyword => tokens.syntaxKeyword,
      TranscriptCodeTokenKind.string => tokens.syntaxString,
      TranscriptCodeTokenKind.number => tokens.syntaxNumber,
      TranscriptCodeTokenKind.comment => tokens.syntaxComment,
      TranscriptCodeTokenKind.literal => tokens.syntaxLiteral,
      TranscriptCodeTokenKind.operator => tokens.textSecondary,
    },
    fontStyle: kind == TranscriptCodeTokenKind.comment
        ? FontStyle.italic
        : FontStyle.normal,
    fontWeight: kind == TranscriptCodeTokenKind.keyword
        ? FontWeight.w600
        : FontWeight.normal,
  );
}
