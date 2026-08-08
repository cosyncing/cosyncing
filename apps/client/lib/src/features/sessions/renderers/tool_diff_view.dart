part of 'message_renderer_registry.dart';

/// Semantic kind of one parsed unified-diff line.
enum DiffLineKind {
  /// Unchanged context line.
  context,

  /// Added line.
  addition,

  /// Removed line.
  deletion,

  /// A `@@ … @@` hunk header.
  hunkHeader,

  /// File header / index / no-newline markers.
  meta,
}

/// One parsed unified-diff line with resolved old/new line numbers.
@immutable
class DiffLine {
  /// Creates a parsed diff line.
  const DiffLine({
    required this.kind,
    required this.text,
    this.oldLine,
    this.newLine,
  });

  /// Line semantics.
  final DiffLineKind kind;

  /// Displayed line content (without the leading +/-/space marker).
  final String text;

  /// 1-based old-file line number, when applicable.
  final int? oldLine;

  /// 1-based new-file line number, when applicable.
  final int? newLine;
}

/// A parsed unified diff, capped for bounded rendering.
@immutable
class ParsedDiff {
  /// Creates a parsed diff.
  const ParsedDiff({required this.lines, required this.truncated});

  /// Parsed lines, in order.
  final List<DiffLine> lines;

  /// Whether [lines] omits later content because the diff exceeded the cap.
  final bool truncated;
}

/// A credible file-header path: git-prefixed `a/…`/`b/…` or `/dev/null`. Body
/// content like `--- old value` (a removed `-- old value`) has neither.
bool _credibleHeaderPath(String afterMarker, String prefix) {
  final p = afterMarker.trim();
  return p == '/dev/null' || p.startsWith(prefix);
}

/// Lazily yields each line of [patch] with a header-boundary flag, without
/// allocating the whole line array up front (a fetched oversized body can be
/// ~1 MiB; callers `break` early). `headerPair` is true only for the full file-
/// header triple `--- <a/…|/dev/null>` / `+++ <b/…|/dev/null>` / `@@` — credible
/// paths + a trailing hunk header. A range-less BODY pair (removed `-- old` /
/// added `++ new`, even one followed by a second hunk) never matches (R4 #3).
Iterable<({String text, bool headerPair})> _diffLines(String patch) sync* {
  final length = patch.length;
  var start = 0;
  while (start <= length) {
    var end = patch.indexOf('\n', start);
    final lastLine = end < 0;
    if (lastLine) end = length;
    final text = patch.substring(start, end);
    final nextStart = end + 1;
    var headerPair = false;
    if (text.startsWith('--- ') &&
        _credibleHeaderPath(text.substring(4), 'a/') &&
        !lastLine &&
        patch.startsWith('+++ ', nextStart)) {
      final nextEnd = patch.indexOf('\n', nextStart);
      if (nextEnd >= 0) {
        final newPath = patch.substring(nextStart + 4, nextEnd);
        headerPair =
            _credibleHeaderPath(newPath, 'b/') &&
            patch.startsWith('@@', nextEnd + 1);
      }
    }
    yield (text: text, headerPair: headerPair);
    if (lastLine) break;
    start = nextStart;
  }
}

/// Parses a unified-diff [patch] into typed lines with resolved line numbers.
///
/// Tolerant by design: an unrecognized line becomes context so a malformed or
/// truncated patch still renders instead of throwing. Rendering is bounded to
/// [maxLines]; the caller shows a truncation note when [ParsedDiff.truncated].
ParsedDiff parseUnifiedDiff(String patch, {int maxLines = 400}) {
  final lines = <DiffLine>[];
  // 1-based line numbers; a `@@` header with ranges resets them to the reported
  // start. A range-less `@@ <context>` (Codex) carries no numbers, so its body
  // lines get NO gutter number rather than a fabricated one counted from 1.
  var oldLine = 1;
  var newLine = 1;
  var truncated = false;
  // Hunk state. `insideHunk` gates whether a leading `-`/`+` is body content or a
  // between-files header, so real content like `--flag`/`++x` inside a hunk is
  // not misread as a header. `rangeless` marks a hunk with no line ranges: stay
  // inside until the next `@@`/`diff `, emitting no gutter numbers.
  var insideHunk = false;
  var rangeless = false;
  var oldRemaining = 0;
  var newRemaining = 0;
  final hunkHeader = RegExp(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@');

  // Bounded scan: never materialize the whole line array. A fetched oversized
  // body can be ~1 MiB, but only `maxLines` lines are ever rendered — so
  // `_diffLines` yields lazily and this loop `break`s at the cap, so the tail
  // is never split.
  for (final line in _diffLines(patch)) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    final raw = line.text;
    // A credible file-header triple (see `_diffLines.headerPair`: `--- a/…`/
    // `+++ b/…`/`@@`) is a file boundary even mid range-less hunk, so file 2's
    // header is meta. The credible-path + trailing-`@@` requirements keep a
    // range-less BODY pair (`--- old value`/`+++ new value`) as red/green
    // content. NOT inside a ranged hunk, where the counters bound `--- x`.
    final pairBoundary =
        raw.startsWith('--- ') && line.headerPair && (!insideHunk || rangeless);
    if (pairBoundary) {
      insideHunk = false;
      rangeless = false;
      oldRemaining = 0;
      newRemaining = 0;
      lines.add(DiffLine(kind: DiffLineKind.meta, text: raw));
      continue;
    }
    // A `diff --git`/`diff ` line always starts a new file, even mid range-less hunk.
    if (raw.startsWith('diff ')) {
      insideHunk = false;
      rangeless = false;
      oldRemaining = 0;
      newRemaining = 0;
      lines.add(DiffLine(kind: DiffLineKind.meta, text: raw));
      continue;
    }
    if (raw.startsWith('@@')) {
      final match = hunkHeader.firstMatch(raw);
      if (match != null) {
        oldLine = int.parse(match.group(1)!);
        newLine = int.parse(match.group(3)!);
        oldRemaining = int.parse(match.group(2) ?? '1');
        newRemaining = int.parse(match.group(4) ?? '1');
        rangeless = false;
      } else {
        rangeless = true;
      }
      insideHunk = true;
      lines.add(DiffLine(kind: DiffLineKind.hunkHeader, text: raw));
      continue;
    }
    if (raw.startsWith(r'\ No newline')) {
      lines.add(const DiffLine(kind: DiffLineKind.meta, text: r'\ No newline'));
      continue;
    }
    if (!insideHunk &&
        (raw.startsWith('+++') ||
            raw.startsWith('---') ||
            raw.startsWith('index ') ||
            raw.startsWith('new file') ||
            raw.startsWith('deleted file') ||
            raw.startsWith('rename ') ||
            (raw.startsWith('Binary files ') && raw.endsWith(' differ')))) {
      lines.add(DiffLine(kind: DiffLineKind.meta, text: raw));
      continue;
    }
    if (raw.startsWith('+')) {
      if (!rangeless && newRemaining > 0) newRemaining -= 1;
      lines.add(
        DiffLine(
          kind: DiffLineKind.addition,
          text: raw.substring(1),
          newLine: rangeless ? null : newLine,
        ),
      );
      if (!rangeless) newLine += 1;
      if (!rangeless && insideHunk && oldRemaining <= 0 && newRemaining <= 0) {
        insideHunk = false;
      }
      continue;
    }
    if (raw.startsWith('-')) {
      if (!rangeless && oldRemaining > 0) oldRemaining -= 1;
      lines.add(
        DiffLine(
          kind: DiffLineKind.deletion,
          text: raw.substring(1),
          oldLine: rangeless ? null : oldLine,
        ),
      );
      if (!rangeless) oldLine += 1;
      if (!rangeless && insideHunk && oldRemaining <= 0 && newRemaining <= 0) {
        insideHunk = false;
      }
      continue;
    }
    // Context (a leading space, or a bare line inside a truncated/headerless hunk).
    if (!rangeless && oldRemaining > 0) oldRemaining -= 1;
    if (!rangeless && newRemaining > 0) newRemaining -= 1;
    final text = raw.startsWith(' ') ? raw.substring(1) : raw;
    lines.add(
      DiffLine(
        kind: DiffLineKind.context,
        text: text,
        oldLine: rangeless ? null : oldLine,
        newLine: rangeless ? null : newLine,
      ),
    );
    if (!rangeless) {
      oldLine += 1;
      newLine += 1;
      if (insideHunk && oldRemaining <= 0 && newRemaining <= 0) {
        insideHunk = false;
      }
    }
  }

  return ParsedDiff(
    lines: List<DiffLine>.unmodifiable(lines),
    truncated: truncated,
  );
}

/// True when [patch] is a binary-file change with no textual diff to render.
///
/// Git emits `Binary files a/x and b/x differ` (or a `GIT binary patch` block)
/// rather than `+`/`-` lines; treating those as context would show noise, so the
/// caller renders an honest binary-file note instead of an empty diff.
bool looksLikeBinaryDiff(String patch) {
  for (final entry in _diffLines(patch)) {
    final line = entry.text.trimLeft();
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      return true;
    }
    if (line.startsWith('GIT binary patch')) return true;
  }
  return false;
}

/// Splits a (possibly multi-file) unified [patch] into one raw diff segment per
/// file, in order — the client mirror of the broker's `splitUnifiedDiffFiles`,
/// used to restore per-file rendering after fetching a referenced oversized
/// diff (the aggregate arrives as one body, but a multi-file result must still
/// show one bordered box per file). Boundaries: a `diff `/`diff --git` line, or
/// a `--- `/`+++ ` header pair once the current file has body content already —
/// the same range-safe rule as [parseUnifiedDiff]. Returns `[patch]` unchanged
/// when it holds a single file (or no detectable boundary).
List<String> splitDiffByFile(String patch) {
  final hunkHeader = RegExp(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@');
  final segments = <List<String>>[];
  List<String>? current;
  var hasBody = false;
  var insideHunk = false;
  var rangeless = false;
  var oldRemaining = 0;
  var newRemaining = 0;

  void startFile() {
    final next = <String>[];
    segments.add(next);
    current = next;
    hasBody = false;
    insideHunk = false;
    rangeless = false;
    oldRemaining = 0;
    newRemaining = 0;
  }

  for (final line in _diffLines(patch)) {
    final raw = line.text;
    if (raw.startsWith('diff ')) {
      startFile();
      current!.add(raw);
      continue;
    }
    final pairBoundary =
        raw.startsWith('--- ') && line.headerPair && (!insideHunk || rangeless);
    if (pairBoundary) {
      if (current == null || hasBody) startFile();
      current!.add(raw);
      insideHunk = false;
      rangeless = false;
      continue;
    }
    if (current == null) startFile();
    if (raw.startsWith('@@')) {
      final match = hunkHeader.firstMatch(raw);
      if (match != null) {
        oldRemaining = int.parse(match.group(2) ?? '1');
        newRemaining = int.parse(match.group(4) ?? '1');
        rangeless = false;
      } else {
        rangeless = true;
      }
      insideHunk = true;
      hasBody = true;
    } else if (raw.startsWith('+')) {
      hasBody = true;
      if (!rangeless && newRemaining > 0) newRemaining -= 1;
    } else if (raw.startsWith('-')) {
      hasBody = true;
      if (!rangeless && oldRemaining > 0) oldRemaining -= 1;
    } else if (insideHunk) {
      if (!rangeless && oldRemaining > 0) oldRemaining -= 1;
      if (!rangeless && newRemaining > 0) newRemaining -= 1;
    }
    if (!rangeless && insideHunk && oldRemaining <= 0 && newRemaining <= 0) {
      insideHunk = false;
    }
    current!.add(raw);
  }

  if (segments.isEmpty) return [patch];
  return segments.map((s) => s.join('\n')).toList(growable: false);
}

/// One file changed by an edit tool result — the client view of the canonical
/// `fileChanges[]` entry. Falls back to nothing when a map is malformed.
@immutable
class _FileChangeView {
  const _FileChangeView({
    required this.path,
    required this.operation,
    this.previousPath,
    this.diff,
    this.additions,
    this.deletions,
    this.binary = false,
    this.truncated = false,
  });

  final String path;
  final String? previousPath;

  /// `create` | `edit` | `delete` | `rename` (unknown → rendered as an edit).
  final String operation;
  final String? diff;
  final int? additions;
  final int? deletions;
  final bool binary;
  final bool truncated;

  /// Header label: `old → new` for a rename, else the path.
  String get label => previousPath != null && previousPath != path
      ? '$previousPath → $path'
      : path;

  /// Parse the canonical `fileChanges` list off a raw tool-result map.
  static List<_FileChangeView>? fromRaw(Object? raw) {
    if (raw is! List) return null;
    final out = <_FileChangeView>[];
    for (final entry in raw) {
      if (entry is! Map) continue;
      final path = entry['path'];
      if (path is! String || path.isEmpty) continue;
      final op = entry['operation'];
      final prev = entry['previousPath'];
      final diff = entry['diff'];
      out.add(
        _FileChangeView(
          path: path,
          operation: op is String ? op : 'edit',
          previousPath: prev is String && prev.isNotEmpty ? prev : null,
          diff: diff is String && diff.isNotEmpty ? diff : null,
          additions: entry['additions'] is num
              ? (entry['additions'] as num).toInt()
              : null,
          deletions: entry['deletions'] is num
              ? (entry['deletions'] as num).toInt()
              : null,
          binary: entry['binary'] == true,
          truncated: entry['truncated'] == true,
        ),
      );
    }
    return out.isEmpty ? null : out;
  }
}

/// Reference to an oversized diff body the broker moved behind an authenticated
/// content-hashed fetch. Present instead of an inline `diff`/`fileChanges[].diff`.
@immutable
class _DiffBodyRefView {
  const _DiffBodyRefView({
    required this.fetchUrl,
    required this.contentHash,
    required this.byteSize,
    this.lineCount,
    this.truncated = false,
  });

  final String fetchUrl;
  final String contentHash;
  final int byteSize;
  final int? lineCount;

  /// The broker clipped the stashed body at its fetch-size ceiling; the fetched
  /// aggregate is a prefix of the real diff.
  final bool truncated;

  static _DiffBodyRefView? fromRaw(Object? raw) {
    if (raw is! Map) return null;
    final url = raw['fetchUrl'];
    final hash = raw['contentHash'];
    if (url is! String || url.isEmpty || hash is! String || hash.isEmpty) {
      return null;
    }
    return _DiffBodyRefView(
      fetchUrl: url,
      contentHash: hash,
      byteSize: raw['byteSize'] is num ? (raw['byteSize'] as num).toInt() : 0,
      lineCount: raw['lineCount'] is num
          ? (raw['lineCount'] as num).toInt()
          : null,
      truncated: raw['truncated'] == true,
    );
  }
}

/// Renders the expanded diff area of an edit tool-result. Chooses between an
/// oversized-diff fetch reference, a multi-file `fileChanges` set (one bordered
/// diff per file), or a single inline unified diff — in that order.
class _ToolDiffSection extends StatelessWidget {
  const _ToolDiffSection({
    this.diff,
    this.path,
    this.fileChanges,
    this.diffRef,
  });

  final String? diff;
  final String? path;
  final List<_FileChangeView>? fileChanges;
  final _DiffBodyRefView? diffRef;

  @override
  Widget build(BuildContext context) {
    if (diffRef != null) {
      return _DiffRefView(reference: diffRef!, fileChanges: fileChanges);
    }
    final changes = fileChanges;
    if (changes != null && changes.isNotEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < changes.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            _DiffView(
              key: Key('tool-diff-file-$i'),
              diff: changes[i].binary && changes[i].diff == null
                  ? 'Binary files a/${changes[i].path} and b/${changes[i].path} differ'
                  : (changes[i].diff ?? ''),
              path: changes[i].label,
            ),
          ],
        ],
      );
    }
    if (diff != null) return _DiffView(diff: diff!, path: path);
    return const SizedBox.shrink();
  }
}

/// Fetches an oversized diff body on expansion (this widget mounts only when
/// the row is expanded), showing honest loading / unavailable / error states,
/// then renders the fetched aggregate. The loader caches by content hash, so
/// collapsing and re-expanding does not refetch.
class _DiffRefView extends ConsumerStatefulWidget {
  const _DiffRefView({required this.reference, this.fileChanges});

  final _DiffBodyRefView reference;
  final List<_FileChangeView>? fileChanges;

  @override
  ConsumerState<_DiffRefView> createState() => _DiffRefViewState();
}

class _DiffRefViewState extends ConsumerState<_DiffRefView> {
  late Future<String> _future = _load();

  /// Whether the last completed load ended terminally unavailable — the only
  /// case in which a re-signed URL for the SAME body is worth refetching.
  bool _lastUnavailable = false;

  Future<String> _load() async {
    // Capture the URL this request uses: a fresher signed URL may replace the
    // reference while we await, and its arrival must not be lost (R4 #4).
    final url = widget.reference.fetchUrl;
    try {
      final body = await ref
          .read(diffBodyLoaderProvider)
          .load(
            url: url,
            contentHash: widget.reference.contentHash,
            expectedBytes: widget.reference.byteSize,
          );
      _lastUnavailable = false;
      return body;
    } on DiffBodyUnavailableException {
      _lastUnavailable = true;
      // A stale URL's expiry (403/gone) is NOT terminal if a newer signed URL
      // for the same body arrived while this request was pending — reload with
      // the current URL instead of surfacing "unavailable".
      if (mounted && widget.reference.fetchUrl != url) {
        final fresh = _load();
        if (mounted) setState(() => _future = fresh);
        return fresh;
      }
      rethrow;
    } on Object {
      _lastUnavailable = false;
      rethrow;
    }
  }

  @override
  void didUpdateWidget(_DiffRefView oldWidget) {
    super.didUpdateWidget(oldWidget);
    final old = oldWidget.reference;
    final now = widget.reference;
    if (old.contentHash != now.contentHash) {
      // New body → always reload (the content changed).
      _future = _load();
    } else if (old.fetchUrl != now.fetchUrl && _lastUnavailable) {
      // Same body, re-signed URL: refetch ONLY if the previous URL had expired
      // (unavailable). Bodies over 128 KiB are uncached, so refetching on every
      // routine re-sign would needlessly re-download a large diff (R3 #4).
      _future = _load();
    }
  }

  void _retry() => setState(() {
    _future = _load();
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);

    Widget shell(Widget child, {Key? key}) => Container(
      key: key,
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(tokens.radiusMd),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: child,
    );

    return FutureBuilder<String>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return shell(
            key: const Key('tool-diff-ref-loading'),
            Row(
              children: [
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 12),
                Text(
                  l10n.sessionToolDiffLoading,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: tokens.textSecondary,
                  ),
                ),
              ],
            ),
          );
        }
        if (snap.hasError) {
          // Terminal states (unavailable / too-large) offer no retry — a stale
          // signed URL or an over-ceiling body will not recover on retry. Other
          // failures (integrity, transient network) do.
          final (
            String key,
            String message,
            bool terminal,
          ) = switch (snap.error) {
            DiffBodyUnavailableException() => (
              'tool-diff-ref-unavailable',
              l10n.sessionToolDiffUnavailable,
              true,
            ),
            DiffBodyTooLargeException() => (
              'tool-diff-ref-toolarge',
              l10n.sessionToolDiffTooLarge,
              true,
            ),
            _ => ('tool-diff-ref-error', l10n.sessionToolDiffError, false),
          };
          return shell(
            key: Key(key),
            Row(
              children: [
                Expanded(
                  child: Text(
                    message,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: tokens.textSecondary,
                    ),
                  ),
                ),
                if (!terminal)
                  TextButton(
                    key: const Key('tool-diff-ref-retry'),
                    onPressed: _retry,
                    child: Text(l10n.sessionToolDiffRetry),
                  ),
              ],
            ),
          );
        }
        return _body(snap.data ?? '', theme, tokens, l10n);
      },
    );
  }

  /// Renders the fetched aggregate. A multi-file result is re-split back into
  /// one bordered box per file (operation, rename source, and label come from
  /// the kept `fileChanges` metadata), so a referenced diff looks like an
  /// inline one (finding 3). If the broker clipped the aggregate mid-list, the
  /// dropped files still get an explicit "N files not shown" note rather than
  /// silently collapsing the survivors into one mislabeled box (R3 finding 3).
  Widget _body(
    String aggregate,
    ThemeData theme,
    AppTokens tokens,
    AppLocalizations l10n,
  ) {
    final changes = widget.fileChanges;
    Widget note(String text, String key) => Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(
        text,
        key: Key(key),
        style: theme.textTheme.labelSmall?.copyWith(color: tokens.textTertiary),
      ),
    );
    Widget wrap(List<Widget> children, {int omitted = 0}) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ...children,
        if (omitted > 0)
          note(
            l10n.sessionToolDiffFilesOmitted(omitted),
            'tool-diff-ref-omitted',
          ),
        if (widget.reference.truncated)
          note(l10n.sessionToolDiffClipped, 'tool-diff-ref-truncated'),
      ],
    );

    if (changes != null && changes.length > 1) {
      final segments = splitDiffByFile(aggregate);
      // Zip segments with metadata by order. A clip drops LATER files, so fewer
      // segments than changes → render the survivors under their own metadata
      // and count the rest as omitted. (segments/changes stay index-aligned:
      // both preserve the adapter's file order.)
      final shown = segments.length < changes.length
          ? segments.length
          : changes.length;
      if (shown >= 1) {
        return wrap(
          [
            for (var i = 0; i < shown; i++) ...[
              if (i > 0) const SizedBox(height: 8),
              _DiffView(
                key: Key('tool-diff-ref-file-$i'),
                diff: changes[i].binary
                    ? 'Binary files a/${changes[i].path} '
                          'and b/${changes[i].path} differ'
                    : segments[i],
                path: changes[i].label,
              ),
            ],
          ],
          omitted: changes.length - shown,
        );
      }
    }
    return wrap([
      _DiffView(
        key: const Key('tool-diff-ref-body'),
        diff: aggregate,
        path: changes != null && changes.isNotEmpty
            ? changes.first.label
            : null,
      ),
    ]);
  }
}

/// Renders a unified-diff patch as a git-style, line-numbered coloured view.
///
/// The patch is parsed once on first build — only reached when the enclosing
/// tool row is expanded — and cached for this widget's lifetime. Colours come
/// from the dedicated diff tokens, never hard-coded hues.
class _DiffView extends StatefulWidget {
  const _DiffView({required this.diff, this.path, super.key});

  final String diff;
  final String? path;

  @override
  State<_DiffView> createState() => _DiffViewState();
}

class _DiffViewState extends State<_DiffView> {
  late ParsedDiff _parsed = parseUnifiedDiff(widget.diff);
  late bool _binary = looksLikeBinaryDiff(widget.diff);

  /// Rows built per reveal. The first build never materializes the whole cap —
  /// long diffs grow one bounded chunk at a time on explicit taps.
  static const int _chunkSize = 60;
  int _visibleLines = _chunkSize;

  final ScrollController _horizontal = ScrollController();

  @override
  void didUpdateWidget(_DiffView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Re-parse if a replayed/updated tool result changes the patch text.
    if (oldWidget.diff != widget.diff) {
      _parsed = parseUnifiedDiff(widget.diff);
      _binary = looksLikeBinaryDiff(widget.diff);
      _visibleLines = _chunkSize;
    }
  }

  @override
  void dispose() {
    _horizontal.dispose();
    super.dispose();
  }

  Future<void> _copyDiff() async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final copied = AppLocalizations.of(context).sessionToolDiffCopied;
    await Clipboard.setData(ClipboardData(text: widget.diff));
    messenger?.showSnackBar(SnackBar(content: Text(copied)));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final mono = theme.textTheme.bodySmall?.copyWith(
      fontFamily: 'monospace',
      height: 1.35,
    );

    if (!_binary && _parsed.lines.isEmpty) {
      return Text(
        l10n.sessionToolDiffEmpty,
        key: const Key('tool-diff-empty'),
        style: theme.textTheme.bodySmall,
      );
    }

    final total = _parsed.lines.length;
    final visible = _visibleLines.clamp(0, total);
    final remaining = total - visible;
    final gutter = _DiffGutterLayout.measure(
      _parsed.lines.take(visible),
      style: theme.textTheme.labelSmall?.copyWith(fontFamily: 'monospace'),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    );

    return Container(
      key: const Key('tool-diff-view'),
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(tokens.radiusMd),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(context, theme, tokens, mono, l10n),
          if (_binary)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              child: Text(
                l10n.sessionToolDiffBinary,
                key: const Key('tool-diff-binary'),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: tokens.textSecondary,
                ),
              ),
            )
          else ...[
            // A single horizontal scroll keeps long lines non-wrapping and does
            // not consume vertical drags, so the transcript still scrolls under
            // the diff. IntrinsicWidth spans row backgrounds to the widest row.
            Scrollbar(
              controller: _horizontal,
              child: SingleChildScrollView(
                controller: _horizontal,
                scrollDirection: Axis.horizontal,
                child: IntrinsicWidth(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (var i = 0; i < visible; i++)
                        _DiffLineRow(
                          line: _parsed.lines[i],
                          mono: mono,
                          gutter: gutter,
                        ),
                    ],
                  ),
                ),
              ),
            ),
            if (remaining > 0)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  key: const Key('tool-diff-show-more'),
                  onPressed: () => setState(() {
                    _visibleLines = (visible + _chunkSize).clamp(0, total);
                  }),
                  // Report the actual next reveal (one chunk, or the remainder
                  // if smaller), not every remaining line the tap never shows.
                  child: Text(
                    l10n.sessionToolDiffShowMore(
                      remaining < _chunkSize ? remaining : _chunkSize,
                    ),
                  ),
                ),
              ),
            if (_parsed.truncated && remaining == 0)
              Container(
                color: tokens.surface2,
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 4,
                ),
                child: Text(
                  l10n.sessionToolDiffTruncated,
                  key: const Key('tool-diff-truncated'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: tokens.textTertiary,
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget _header(
    BuildContext context,
    ThemeData theme,
    AppTokens tokens,
    TextStyle? mono,
    AppLocalizations l10n,
  ) {
    // 40dp tap target on touch platforms; a compact 28dp control on desktop.
    final touch = switch (theme.platform) {
      TargetPlatform.android ||
      TargetPlatform.iOS ||
      TargetPlatform.fuchsia => true,
      _ => false,
    };
    final side = touch ? 40.0 : 28.0;
    return Container(
      color: tokens.surface2,
      padding: const EdgeInsets.only(left: 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              widget.path ?? '',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: mono?.copyWith(color: tokens.textSecondary),
            ),
          ),
          Tooltip(
            message: l10n.sessionToolDiffCopy,
            child: InkWell(
              key: const Key('tool-diff-copy'),
              onTap: _copyDiff,
              customBorder: const CircleBorder(),
              child: SizedBox(
                width: side,
                height: side,
                child: Icon(
                  Icons.copy_outlined,
                  size: 16,
                  color: tokens.textSecondary,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DiffLineRow extends StatelessWidget {
  const _DiffLineRow({
    required this.line,
    required this.mono,
    required this.gutter,
  });

  final DiffLine line;
  final TextStyle? mono;
  final _DiffGutterLayout gutter;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    // Null background = transparent (context/meta lines); no hard-coded hue.
    final (
      Color? background,
      Color foreground,
      String marker,
    ) = switch (line.kind) {
      DiffLineKind.addition => (
        tokens.diffAddSurface,
        tokens.diffAddText,
        '+',
      ),
      DiffLineKind.deletion => (
        tokens.diffRemoveSurface,
        tokens.diffRemoveText,
        '-',
      ),
      DiffLineKind.hunkHeader => (
        tokens.surface2,
        tokens.textSecondary,
        '',
      ),
      DiffLineKind.meta => (null, tokens.textTertiary, ''),
      DiffLineKind.context => (null, tokens.textSecondary, ' '),
    };

    return Container(
      color: background,
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (gutter.oldWidth case final width?)
            _DiffGutter(
              key: const Key('tool-diff-old-gutter'),
              value: line.oldLine,
              width: width,
            ),
          if (gutter.newWidth case final width?)
            _DiffGutter(
              key: const Key('tool-diff-new-gutter'),
              value: line.newLine,
              width: width,
            ),
          SizedBox(
            key: const Key('tool-diff-marker'),
            width: 16,
            child: Text(
              marker,
              softWrap: false,
              textAlign: TextAlign.left,
              style: mono?.copyWith(color: foreground),
            ),
          ),
          // Non-wrapping: long lines extend into the horizontal scroll rather
          // than reflowing, matching a git-style diff.
          Text(
            line.text,
            softWrap: false,
            style: mono?.copyWith(color: foreground),
          ),
        ],
      ),
    );
  }
}

class _DiffGutter extends StatelessWidget {
  const _DiffGutter({
    required this.value,
    required this.width,
    super.key,
  });

  final int? value;
  final double width;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    return SizedBox(
      width: width,
      child: Text(
        value?.toString() ?? '',
        textAlign: TextAlign.right,
        style: theme.textTheme.labelSmall?.copyWith(
          fontFamily: 'monospace',
          color: tokens.textTertiary,
        ),
      ),
    );
  }
}

@immutable
final class _DiffGutterLayout {
  const _DiffGutterLayout({this.oldWidth, this.newWidth});

  factory _DiffGutterLayout.measure(
    Iterable<DiffLine> lines, {
    required TextStyle? style,
    required TextDirection textDirection,
    required TextScaler textScaler,
  }) {
    var largestOld = 0;
    var largestNew = 0;
    for (final line in lines) {
      largestOld = math.max(largestOld, line.oldLine ?? 0);
      largestNew = math.max(largestNew, line.newLine ?? 0);
    }
    double? width(int largest) {
      if (largest == 0) return null;
      final painter = TextPainter(
        text: TextSpan(text: '$largest', style: style),
        textDirection: textDirection,
        textScaler: textScaler,
        maxLines: 1,
      )..layout();
      return (painter.width + _inlineSpacing).clamp(
        _minimumWidth,
        _maximumWidth,
      );
    }

    return _DiffGutterLayout(
      oldWidth: width(largestOld),
      newWidth: width(largestNew),
    );
  }

  /// Bounded minimum keeps one-digit numbers readable without a wide blank
  /// column; the maximum prevents pathological line counts dominating a row.
  static const double _minimumWidth = 20;
  static const double _maximumWidth = 64;
  static const double _inlineSpacing = 8;

  final double? oldWidth;
  final double? newWidth;
}
