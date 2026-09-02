import 'dart:typed_data';

import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/widgets.dart';

/// Bytes handed to a renderer.
///
/// Sealed from the start even though only [TextFileContent] is ever produced
/// today: `decodeSessionFileReadText` UTF-8-decodes with `allowMalformed`, so a
/// binary file currently arrives as mojibake. The first binary renderer needs
/// [BinaryFileContent] to exist, and retrofitting a sealed type through every
/// renderer later is the expensive version of this.
sealed class FileContent {
  const FileContent();
}

/// Decoded text.
final class TextFileContent extends FileContent {
  /// Wraps decoded [text].
  const TextFileContent(this.text);

  /// The file's decoded contents, possibly a bounded prefix.
  final String text;
}

/// Undecoded bytes. No built-in renderer produces this yet.
final class BinaryFileContent extends FileContent {
  /// Wraps raw [bytes].
  const BinaryFileContent(this.bytes);

  /// The file's raw contents, possibly a bounded prefix.
  final Uint8List bytes;
}

/// Which face of a file is showing.
enum FileViewMode {
  /// The bytes as they are, monospace.
  source,

  /// The renderer's presentation of them.
  rendered,
}

/// What a reader had done to one file pane: which face, and how far down.
///
/// Lives beside [FileViewMode] rather than beside the memory that holds it,
/// so the viewer never has to depend on the workspace that hosts it.
typedef FilePaneView = ({FileViewMode mode, double offset});

/// What the host is willing to let a renderer ask for.
///
/// A renderer never acts: it asks, through the callbacks on
/// [FileRenderRequest], and the host executes under the host's own policy. The
/// grant is what makes that reviewable for a built-in and enforceable for a
/// plugin later.
enum FileRenderCapability {
  /// May ask the host to open another workspace path.
  openPath,

  /// May ask the host to put text on the clipboard.
  copy,

  /// May ask the host to hand a URL to the platform browser.
  externalLink,

  /// May render an embedded frame that runs no scripts.
  passiveFrame,
}

/// Where a renderer came from.
sealed class RendererSource {
  const RendererSource();
}

/// Shipped with the app.
final class BuiltInRendererSource extends RendererSource {
  /// The only instance needed.
  const BuiltInRendererSource();
}

/// Installed by the user.
final class PluginRendererSource extends RendererSource {
  /// Names the plugin that supplied the renderer.
  const PluginRendererSource({required this.id, required this.version});

  /// Plugin identifier.
  final String id;

  /// Plugin version.
  final String version;
}

/// Everything a renderer is given.
///
/// Deliberately closed over values rather than context: a renderer may not read
/// providers, hold a `BrokerClient`, touch the network or reach `Navigator`.
/// Theme arrives as resolved tokens for the same reason — an out-of-process
/// renderer cannot read an `InheritedWidget`.
final class FileRenderRequest {
  /// Builds one request.
  const FileRenderRequest({
    required this.path,
    required this.displayName,
    required this.mimeType,
    required this.languageId,
    required this.size,
    required this.limit,
    required this.truncated,
    required this.content,
    required this.lines,
    required this.mode,
    required this.tokens,
    required this.locale,
    required this.granted,
    required this.surface,
    this.prepared,
    this.anchorLine,
    this.anchorColumn,
    this.onOpenPath,
    this.onCopy,
    this.onExternalLink,
  });

  /// Workspace-relative path.
  final String path;

  /// Basename for labels.
  final String displayName;

  /// Broker-sniffed MIME. A hint, never an authority — the broker guesses from
  /// the extension and guesses `application/octet-stream` for most source.
  final String? mimeType;

  /// Host-resolved highlighter language id, when the extension maps to one.
  final String? languageId;

  /// Full file size in bytes.
  final int size;

  /// The broker's read cap in bytes.
  final int limit;

  /// Whether [content] is a prefix rather than the whole file.
  final bool truncated;

  /// The bytes.
  final FileContent content;

  /// [content]'s lines, split once by the host.
  ///
  /// Split here rather than in each renderer because a 1 MB file would
  /// otherwise be re-split on every rebuild that flips the wrap toggle. Empty
  /// for binary content.
  final List<String> lines;

  /// Which face to render.
  final FileViewMode mode;

  /// Resolved design tokens.
  final AppTokens tokens;

  /// The viewer's locale.
  final Locale locale;

  /// What this renderer may ask the host to do.
  final Set<FileRenderCapability> granted;

  /// The host's line-body machinery, for renderers that show lines.
  final FileSourceSurface surface;

  /// Whatever this renderer's preparer returned for this file.
  final Object? prepared;

  /// 1-based line the mention carried, when it carried one.
  final int? anchorLine;

  /// 1-based column inside [anchorLine], when one was carried.
  final int? anchorColumn;

  /// Asks the host to open another workspace path.
  final void Function(String path, {int? line})? onOpenPath;

  /// Asks the host to put text on the clipboard.
  final void Function(String text)? onCopy;

  /// Asks the host to hand a URL to the platform browser.
  final void Function(Uri url)? onExternalLink;
}

/// The host's line-body machinery.
///
/// The pinned gutter, the single horizontal axis, the wrap toggle, the anchor
/// reveal and scroll restore are host guarantees, not per-renderer choices —
/// five behaviours that must not differ between renderers, and that a renderer
/// laying out its own lines would have to reimplement correctly five times. So
/// a renderer that shows lines composes `FileSourceBody` with this handle
/// instead, and supplies only how one line is styled.
final class FileSourceSurface {
  /// Captures the host's controllers and per-view state.
  const FileSourceSurface({
    required this.vertical,
    required this.gutter,
    required this.horizontal,
    required this.wrap,
  });

  /// Drives the code body, the anchor reveal and scroll restore.
  final ScrollController vertical;

  /// Follows [vertical]; never scrolls horizontally.
  final ScrollController gutter;

  /// One axis for the whole body, so columns stay aligned.
  final ScrollController horizontal;

  /// Whether the source view is wrapping.
  final bool wrap;
}

/// A host notice a renderer's preparation established.
///
/// The renderer reports the condition; the host owns the copy, the l10n and
/// the placement. Notices sit above the renderer and are never renderer-drawn,
/// which is what keeps them trustworthy — the same discipline the transcript's
/// anti-phishing strip keeps.
enum FileRenderNotice {
  /// Highlighting was declined, and the text is nonetheless complete.
  highlightingOff,
}

/// Per-file work a renderer wants done once rather than on every rebuild.
final class FileRenderPreparation {
  /// Reports [state] to hand back on each build, and any [notice] it found.
  const FileRenderPreparation({this.state, this.notice});

  /// Opaque to the host; handed back on [FileRenderRequest.prepared].
  final Object? state;

  /// A condition the host should announce above the body.
  final FileRenderNotice? notice;
}

/// Prepares per-file state, once, when the file or the mode changes.
typedef FileRendererPreparer =
    FileRenderPreparation Function(FileRenderRequest request);

/// Builds the body for one file.
typedef FileRendererBuilder =
    Widget Function(BuildContext context, FileRenderRequest request);

/// One entry in the renderer registry.
final class FileRendererDescriptor {
  /// Declares a renderer.
  const FileRendererDescriptor({
    required this.id,
    required this.source,
    required this.build,
    this.extensions = const {},
    this.mimeTypes = const {},
    this.basenames = const {},
    this.modes = const {FileViewMode.source},
    this.defaultMode = FileViewMode.source,
    this.granted = const {},
    this.prepare,
  });

  /// Stable identifier, shown in the header as the renderer name.
  final String id;

  /// Built-in or plugin — the tiebreak, and what the host is willing to grant.
  final RendererSource source;

  /// Builds the body.
  final FileRendererBuilder build;

  /// Lowercase extensions without the dot, longest match wins.
  final Set<String> extensions;

  /// Exact MIME types, consulted only when the broker did not guess
  /// `application/octet-stream`.
  final Set<String> mimeTypes;

  /// Exact lowercase basenames, for extensionless files.
  final Set<String> basenames;

  /// The faces this renderer offers. One entry means no toggle is shown.
  final Set<FileViewMode> modes;

  /// The face shown first.
  final FileViewMode defaultMode;

  /// Capabilities this renderer is granted.
  final Set<FileRenderCapability> granted;

  /// Per-file work done once, when the file or the mode changes.
  final FileRendererPreparer? prepare;
}

/// Resolves the highlighter language id for [path], or null when the extension
/// maps to no lexical profile.
///
/// Kept as an explicit table rather than passing the extension straight to the
/// highlighter: several of its aliases happen to look like extensions (`py`,
/// `rs`, `kt`), so identity would appear to work and then silently mis-lex
/// everything it does not cover.
String? fileLanguageIdFor(String path) {
  final name = path.split('/').last.toLowerCase();
  final dot = name.lastIndexOf('.');
  final extension = dot <= 0 ? '' : name.substring(dot + 1);
  return _languageIdByExtension[extension] ?? _languageIdByBasename[name];
}

const Map<String, String> _languageIdByExtension = {
  'c': 'c',
  'h': 'c',
  'cc': 'cpp',
  'cpp': 'cpp',
  'cxx': 'cpp',
  'hpp': 'cpp',
  'hh': 'cpp',
  'cs': 'csharp',
  'dart': 'dart',
  'go': 'go',
  'java': 'java',
  'js': 'js',
  'mjs': 'js',
  'cjs': 'js',
  'jsx': 'jsx',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'rs': 'rust',
  'swift': 'swift',
  'ts': 'ts',
  'mts': 'ts',
  'cts': 'ts',
  'tsx': 'tsx',
  'py': 'python',
  'pyi': 'python',
  'pyw': 'python',
  'rb': 'ruby',
  'sh': 'bash',
  'bash': 'bash',
  'zsh': 'zsh',
  'json': 'json',
  'jsonc': 'jsonc',
  'yaml': 'yaml',
  'yml': 'yml',
  'toml': 'toml',
  'sql': 'sql',
  'html': 'html',
  'htm': 'htm',
  'xml': 'xml',
  'svg': 'svg',
  'css': 'css',
};

/// Extensions the code renderer claims — exactly those with a lexical profile.
Set<String> get highlightableFileExtensions =>
    _languageIdByExtension.keys.toSet();

const Map<String, String> _languageIdByBasename = {
  'dockerfile': 'bash',
  'makefile': 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'zsh',
  '.gitignore': 'bash',
};

/// Picks the renderer for one file, in the order a user can predict.
///
/// 1. an explicit user pin, 2. the longest matching extension, 3. an exact MIME
/// match — but never off `application/octet-stream`, which the broker guesses
/// for most source, 4. an exact basename, for extensionless files,
/// 5. [fallbackId], which is always registered and never fails.
///
/// Ties break `plugin > built-in`: a plugin outranking a built-in is what
/// "tunable" means, and the header names the winner with a one-tap switch,
/// because a plugin winning silently is how a renderer becomes a phishing
/// surface.
FileRendererDescriptor resolveFileRenderer(
  List<FileRendererDescriptor> registry, {
  required String path,
  required String fallbackId,
  String? mimeType,
  String? pinnedRendererId,
}) {
  final fallback = registry.firstWhere((entry) => entry.id == fallbackId);
  if (pinnedRendererId != null) {
    for (final entry in registry) {
      if (entry.id == pinnedRendererId) return entry;
    }
  }

  final name = path.split('/').last.toLowerCase();
  final candidates = <FileRendererDescriptor>[];

  // Longest extension first, so `.tar.gz` outranks `.gz`.
  var best = 0;
  for (final entry in registry) {
    for (final extension in entry.extensions) {
      if (name.endsWith('.$extension') && extension.length >= best) {
        if (extension.length > best) {
          best = extension.length;
          candidates.clear();
        }
        candidates.add(entry);
      }
    }
  }
  if (candidates.isNotEmpty) return _preferred(candidates);

  final mime = mimeType?.split(';').first.trim().toLowerCase();
  if (mime != null && mime.isNotEmpty && mime != 'application/octet-stream') {
    for (final entry in registry) {
      if (entry.mimeTypes.contains(mime)) candidates.add(entry);
    }
    if (candidates.isNotEmpty) return _preferred(candidates);
  }

  for (final entry in registry) {
    if (entry.basenames.contains(name)) candidates.add(entry);
  }
  if (candidates.isNotEmpty) return _preferred(candidates);

  return fallback;
}

FileRendererDescriptor _preferred(List<FileRendererDescriptor> candidates) {
  for (final entry in candidates) {
    if (entry.source is PluginRendererSource) return entry;
  }
  return candidates.first;
}
