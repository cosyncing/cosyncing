/// The provider-independent semantic tool-presentation registry.
///
/// Every transcript tool row resolves its family here and nowhere else. The
/// resolver reads exactly two canonical inputs — the normalized broker tool
/// semantic envelope and the adapter-owned tool display class — and never a
/// Codex, Claude, OpenCode, Pi, MCP, or provider-native tool name. A broker
/// that predates the semantic envelope (contract revision 8) still resolves to
/// a truthful family through the display class alone, at reduced fidelity.
///
/// Everything in this file is pure and synchronous so it can be unit-tested
/// without a widget tree, and so a renderer can build a collapsed card without
/// touching any expanded body.
///
/// Governing doc: `docs/architecture/client-ui.md`.
library;

import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';

/// Which dedicated presentation renders a tool row.
enum ToolPresentationFamily {
  /// A command execution: command line, exit state, separated streams.
  command,

  /// A file read: path plus a bounded line-numbered preview.
  fileRead,

  /// A workspace search: query, scope, grouped matches.
  search,

  /// A web search or fetch: query/URL plus human-readable results.
  web,

  /// A file edit — routed to the existing diff renderer, never re-implemented.
  edit,

  /// Anything else, including MCP and unknown dynamic tools.
  generic,
}

/// Resource bounds for every derived tool presentation.
///
/// Wire payloads are already bounded by the adapters; these are the *render*
/// bounds, applied independently so a rev-8 broker (or a future looser adapter)
/// can never make the client render an unbounded surface.
abstract final class ToolPresentationBounds {
  /// Characters of the collapsed one-line title.
  static const int collapsedTitleChars = 160;

  /// Lines rendered in a collapsed output preview.
  static const int collapsedOutputLines = 12;

  /// Characters rendered in a collapsed output preview.
  static const int collapsedOutputChars = 2048;

  /// Lines rendered in an expanded command output stream.
  static const int expandedOutputLines = 400;

  /// Characters rendered in an expanded command output stream.
  static const int expandedOutputChars = 64 * 1024;

  /// Lines rendered in a file preview.
  static const int filePreviewLines = 200;

  /// Characters rendered in a file preview.
  static const int filePreviewChars = 16 * 1024;

  /// Search groups rendered.
  static const int searchGroups = 20;

  /// Matches rendered inside one group.
  static const int searchMatchesPerGroup = 10;

  /// Characters rendered in one match snippet.
  static const int searchSnippetChars = 300;

  /// Web results rendered.
  static const int webResults = 10;

  /// Nesting depth walked in the structured fallback.
  static const int fallbackDepth = 4;

  /// Entries rendered per map/list level in the structured fallback.
  static const int fallbackEntriesPerLevel = 32;

  /// Characters rendered per scalar in the structured fallback.
  static const int fallbackStringChars = 200;

  /// Total characters the whole structured fallback may render.
  static const int fallbackTotalChars = 8192;

  /// Total rows the whole structured fallback may render.
  ///
  /// The per-level entry cap alone is not a bound: 32 entries at each of 4
  /// levels is ~1M rows. This is the cap that actually holds, and it is checked
  /// before every emit rather than after a level completes.
  static const int fallbackTotalRows = 200;

  // Deliberately NO derived-presentation cache, and therefore no cache bound.
  //
  // Every builder here is bounded and pure, so re-deriving on rebuild costs at
  // most one bounded slice — cheaper than the bookkeeping a cache would need.
  // The stronger reason is lifetime: a keyed cache would hold bounded copies of
  // transcript bodies past the point where paging evicted the message, which is
  // exactly the retention leak the resource contract forbids. Collapsed rows
  // read their lifecycle through [resolveToolCommandState], which touches no
  // body at all.
}

/// A bounded body plus an explicit statement of what was left out.
///
/// [truncated] is never inferred from the text: a body that fits exactly at the
/// bound is not truncated, and a body clipped by one character is. That keeps
/// truncated output from ever reading as complete.
final class BoundedToolText {
  /// Creates a bounded body.
  const BoundedToolText({
    required this.text,
    required this.truncated,
    this.hiddenLines = 0,
  });

  /// An empty, untruncated body.
  static const BoundedToolText empty = BoundedToolText(
    text: '',
    truncated: false,
  );

  /// Bounded, sanitized body.
  final String text;

  /// Whether any part of the source was withheld.
  final bool truncated;

  /// Lines withheld, when countable. Zero means "unknown or none".
  final int hiddenLines;

  /// Whether there is nothing at all to render.
  bool get isEmpty => text.isEmpty && !truncated;
}

/// ANSI/OSC and unsafe control-sequence stripping for terminal-shaped output.
///
/// Cost is linear in the *input handed to it*, which callers always bound
/// first — sanitizing a 12-line collapsed preview never touches the megabyte
/// behind it. Removed: CSI/OSC/DCS escape sequences, C0 controls other than
/// tab/newline, C1 controls, the DEL character, and bidirectional-override
/// codepoints (which can visually reorder a command line into something the
/// user did not run).
String sanitizeControlSequences(String value) {
  if (value.isEmpty) return value;
  final out = StringBuffer();
  var index = 0;
  while (index < value.length) {
    final unit = value.codeUnitAt(index);
    if (unit == 0x1b) {
      index = _skipEscape(value, index);
      continue;
    }
    // C0 controls except tab (0x09) and newline (0x0a); carriage return is
    // dropped so a `\r`-overwriting progress bar cannot hide earlier output.
    if (unit < 0x20 && unit != 0x09 && unit != 0x0a) {
      index += 1;
      continue;
    }
    // DEL and the C1 control block.
    if (unit == 0x7f || (unit >= 0x80 && unit <= 0x9f)) {
      index += 1;
      continue;
    }
    // Bidi overrides/isolates and the zero-width joiner family.
    if ((unit >= 0x202a && unit <= 0x202e) ||
        (unit >= 0x2066 && unit <= 0x2069) ||
        unit == 0x200f ||
        unit == 0x200e) {
      index += 1;
      continue;
    }
    out.writeCharCode(unit);
    index += 1;
  }
  return out.toString();
}

/// Advances past one escape sequence starting at [start] (`ESC`).
int _skipEscape(String value, int start) {
  var index = start + 1;
  if (index >= value.length) return index;
  final kind = value.codeUnitAt(index);
  // CSI: ESC [ params… final-byte in 0x40..0x7e.
  if (kind == 0x5b) {
    index += 1;
    while (index < value.length) {
      final unit = value.codeUnitAt(index);
      index += 1;
      if (unit >= 0x40 && unit <= 0x7e) break;
    }
    return index;
  }
  // OSC / DCS / APC / PM: terminated by BEL or ESC \.
  if (kind == 0x5d || kind == 0x50 || kind == 0x5f || kind == 0x5e) {
    index += 1;
    while (index < value.length) {
      final unit = value.codeUnitAt(index);
      if (unit == 0x07) return index + 1;
      if (unit == 0x1b &&
          index + 1 < value.length &&
          value.codeUnitAt(index + 1) == 0x5c) {
        return index + 2;
      }
      index += 1;
    }
    return index;
  }
  // Any other two-character escape.
  return index + 1;
}

/// Sanitizes and clips [value] to [maxLines]/[maxChars], keeping the tail when
/// [keepTail] (the newest command output) and the head otherwise.
///
/// The clip happens BEFORE sanitization, so the work is proportional to the
/// bound rather than to the accumulated output — this is what keeps a live
/// command that has produced megabytes from costing more per frame than one
/// that has produced a kilobyte.
BoundedToolText boundToolBody(
  String? value, {
  required bool keepTail,
  required int maxLines,
  required int maxChars,
}) {
  if (value == null || value.isEmpty) return BoundedToolText.empty;
  // Character clip first: bounds the line split itself.
  var slice = value;
  var truncated = false;
  if (slice.length > maxChars) {
    slice = keepTail
        ? slice.substring(slice.length - maxChars)
        : slice.substring(0, maxChars);
    truncated = true;
  }
  var hiddenLines = 0;
  final lines = slice.split('\n');
  if (lines.length > maxLines) {
    hiddenLines = lines.length - maxLines;
    slice = keepTail
        ? lines.sublist(lines.length - maxLines).join('\n')
        : lines.take(maxLines).join('\n');
    truncated = true;
  }
  return BoundedToolText(
    text: sanitizeControlSequences(slice),
    truncated: truncated,
    hiddenLines: hiddenLines,
  );
}

/// One rendered file-preview line with its resolved source line number.
final class ToolPreviewLine {
  /// Creates a preview line.
  const ToolPreviewLine({
    required this.text,
    this.number,
    this.truncated = false,
  });

  /// Sanitized line body.
  final String text;

  /// 1-based source line number, or null when the source published no origin.
  final int? number;

  /// Whether this single line's text is shorter than what the source held —
  /// either the sender clipped it, or the render bound above did.
  final bool truncated;
}

/// The command family's derived, bounded presentation.
final class ToolCommandPresentation {
  /// Creates a command presentation.
  const ToolCommandPresentation({
    required this.command,
    required this.state,
    required this.hasSeparateStreams,
    this.cwd,
    this.exitCode,
    this.stdout = BoundedToolText.empty,
    this.stderr = BoundedToolText.empty,
    this.combined = BoundedToolText.empty,
    this.stdoutTruncatedBySource = false,
    this.stderrTruncatedBySource = false,
  });

  /// Exact command line.
  final String command;

  /// Working directory, when known.
  final String? cwd;

  /// Authoritative lifecycle.
  final ToolCommandState state;

  /// Authoritative exit code, when the native source published one.
  final int? exitCode;

  /// Whether the source distinguished stdout from stderr. When false the UI
  /// labels [combined] as combined output rather than claiming a stream.
  final bool hasSeparateStreams;

  /// Bounded stdout.
  final BoundedToolText stdout;

  /// Bounded stderr.
  final BoundedToolText stderr;

  /// Bounded merged output, used when the source did not separate the streams.
  final BoundedToolText combined;

  /// The adapter dropped leading stdout bytes before this client saw them.
  final bool stdoutTruncatedBySource;

  /// The adapter dropped leading stderr bytes before this client saw them.
  final bool stderrTruncatedBySource;

  /// Whether any output at all is renderable.
  bool get hasOutput => !stdout.isEmpty || !stderr.isEmpty || !combined.isEmpty;
}

/// The file-read family's derived, bounded presentation.
final class ToolFileReadPresentation {
  /// Creates a file-read presentation.
  const ToolFileReadPresentation({
    required this.path,
    required this.lines,
    required this.truncated,
    this.totalLines,
    this.unavailable,
    this.reference,
  });

  /// Read path.
  final String path;

  /// The unclipped, resolvable reference behind [path], when one was derivable.
  ///
  /// Carried as data beside the display string so a link never re-parses what
  /// is on screen — the collapsed summary clips paths, and a link built from a
  /// clipped string would open the wrong file.
  final SessionFileReference? reference;

  /// Bounded, sanitized, line-numbered preview rows.
  final List<ToolPreviewLine> lines;

  /// Whether the preview omits part of the file or the read range.
  final bool truncated;

  /// Total lines in the source file, when reported.
  final int? totalLines;

  /// Honest unavailability; [lines] is then empty.
  final ToolReadUnavailableReason? unavailable;
}

/// One rendered search group.
final class ToolSearchGroupPresentation {
  /// Creates a rendered group.
  const ToolSearchGroupPresentation({
    required this.path,
    required this.matches,
    required this.truncated,
    this.matchCount,
    this.reference,
  });

  /// File the matches belong to.
  final String path;

  /// The unclipped, resolvable reference behind [path], anchored at the first
  /// published match so a tap lands on evidence rather than on line 1.
  final SessionFileReference? reference;

  /// Authoritative match count, which may exceed [matches].length.
  final int? matchCount;

  /// Bounded, sanitized match rows.
  final List<ToolPreviewLine> matches;

  /// Whether matches were withheld from this group.
  final bool truncated;
}

/// The search family's derived, bounded presentation.
final class ToolSearchPresentation {
  /// Creates a search presentation.
  const ToolSearchPresentation({
    required this.groups,
    required this.truncated,
    this.query,
    this.scope,
    this.matchCount,
    this.fileCount,
  });

  /// Literal pattern searched for.
  final String? query;

  /// Directory, glob, or other scope.
  final String? scope;

  /// Authoritative total match count.
  final int? matchCount;

  /// Authoritative count of files with matches.
  final int? fileCount;

  /// Bounded rendered groups.
  final List<ToolSearchGroupPresentation> groups;

  /// Whether groups were withheld.
  final bool truncated;

  /// Whether the search authoritatively found nothing.
  bool get isEmptyResult =>
      groups.isEmpty && !truncated && (matchCount == null || matchCount == 0);
}

/// One rendered web result.
final class ToolWebResultPresentation {
  /// Creates a rendered result.
  const ToolWebResultPresentation({
    required this.url,
    required this.domain,
    this.title,
    this.snippet,
    this.truncated = false,
  });

  /// Full URL, presented as selectable text only.
  final String url;

  /// Host extracted from [url], or the raw URL when it does not parse.
  final String domain;

  /// Human-readable title, when published.
  final String? title;

  /// Bounded snippet.
  final String? snippet;

  /// Whether the sender clipped this result's title, URL, or snippet.
  final bool truncated;
}

/// The web family's derived, bounded presentation.
final class ToolWebPresentation {
  /// Creates a web presentation.
  const ToolWebPresentation({
    required this.results,
    required this.truncated,
    this.query,
    this.url,
  });

  /// Search query, when this was a search.
  final String? query;

  /// Fetched page, when this was a single-URL lookup.
  final String? url;

  /// Bounded rendered results.
  final List<ToolWebResultPresentation> results;

  /// Whether results were withheld.
  final bool truncated;
}

/// Resolves the presentation family for one tool row.
///
/// Order matters and is deliberate:
/// 1. an explicit normalized semantic always wins;
/// 2. diff evidence keeps the row on the existing T1 edit renderer;
/// 3. the adapter-owned display class gives a rev-8 broker a truthful family;
/// 4. everything else is generic.
ToolPresentationFamily resolveToolPresentationFamily({
  AgentMessage? call,
  AgentMessage? result,
}) {
  final semantic = result?.toolSemantic ?? call?.toolSemantic;
  if (semantic != null) {
    switch (semantic.kind) {
      case ToolSemanticKind.command:
        return ToolPresentationFamily.command;
      case ToolSemanticKind.fileRead:
        return ToolPresentationFamily.fileRead;
      case ToolSemanticKind.search:
        return ToolPresentationFamily.search;
      case ToolSemanticKind.web:
        return ToolPresentationFamily.web;
      case ToolSemanticKind.unknown:
        break;
    }
  }
  // An edit is proven by its canonical diff payload, not by a tool name. This
  // check stays ahead of the display class so a mislabeled edit still reaches
  // the diff renderer instead of the generic fallback.
  if (_hasDiffPayload(result)) return ToolPresentationFamily.edit;
  final displayClass = result?.toolDisplayClass ?? call?.toolDisplayClass;
  return switch (displayClass) {
    ToolDisplayClass.execute => ToolPresentationFamily.command,
    ToolDisplayClass.edit => ToolPresentationFamily.edit,
    _ => ToolPresentationFamily.generic,
  };
}

bool _hasDiffPayload(AgentMessage? result) {
  if (result == null) return false;
  final diff = result.raw['diff'];
  if (diff is String && diff.trim().isNotEmpty) return true;
  return result.raw['fileChanges'] is Iterable || result.raw['diffRef'] is Map;
}

/// The command lifecycle for one tool row, without deriving any body.
///
/// This is what a COLLAPSED row calls. It reads a decoded envelope field (or,
/// for a revision-8 broker, the canonical exit code and error flag) and touches
/// no stdout, stderr, or result text — which is what keeps a collapsed card's
/// cost constant no matter how much output the command produced.
///
/// Returns null when the row is not a command at all.
ToolCommandState? resolveToolCommandState({
  AgentMessage? call,
  AgentMessage? result,
}) {
  final semantic = (result?.toolSemantic ?? call?.toolSemantic)?.command;
  if (semantic != null) return semantic.state;
  final displayClass = result?.toolDisplayClass ?? call?.toolDisplayClass;
  if (displayClass != ToolDisplayClass.execute) return null;
  // Revision-8 rows only reach the command family through a canonical title.
  if (_stringOrNull(result?.raw['title']) == null &&
      _stringOrNull(call?.raw['title']) == null) {
    return null;
  }
  if (result == null) return ToolCommandState.running;
  final exitCode = _intOrNull(result.raw['exitCode']);
  if (exitCode == null) {
    return result.raw['isError'] == true
        ? ToolCommandState.failed
        : ToolCommandState.unknown;
  }
  return exitCode == 0 ? ToolCommandState.completed : ToolCommandState.failed;
}

/// A collapsed row's semantic identity: what the tool acted *on*.
///
/// Every field is a scalar read straight off the decoded envelope, plus at most
/// the length of a list the decoder already bounded. Nothing here touches
/// stdout, stderr, a preview, a snippet, or a result body, so a collapsed row
/// costs the same whether the command printed one line or a gigabyte.
final class ToolSummaryPresentation {
  /// Creates a collapsed-row summary.
  const ToolSummaryPresentation({
    required this.family,
    this.primary,
    this.secondary,
    this.matchCount,
    this.fileCount,
    this.resultCount,
  });

  /// Family this summary was resolved from.
  final ToolPresentationFamily family;

  /// The identifying string: command line, file path, search query, or web
  /// query/domain. Null when the source published none.
  final String? primary;

  /// Supporting context: working directory, search scope, or fetched domain.
  final String? secondary;

  /// Authoritative match count, when the source reported one.
  final int? matchCount;

  /// Count of files carrying a match, authoritative or observed.
  final int? fileCount;

  /// Count of web results carried by this row.
  final int? resultCount;

  /// Whether anything at all was resolved.
  bool get isEmpty =>
      primary == null &&
      secondary == null &&
      matchCount == null &&
      fileCount == null &&
      resultCount == null;
}

/// Resolves the collapsed row's summary from the canonical semantic.
///
/// Returns null when there is no semantic, or when the semantic carried nothing
/// worth summarizing — the caller then falls back to the generic canonical
/// fields, which is what a revision-8 broker's rows use.
ToolSummaryPresentation? resolveToolSummary({
  AgentMessage? call,
  AgentMessage? result,
}) {
  final semantic = result?.toolSemantic ?? call?.toolSemantic;
  if (semantic == null) return null;
  final summary = switch (semantic.kind) {
    ToolSemanticKind.command => _commandSummary(semantic.command),
    ToolSemanticKind.fileRead => _fileReadSummary(semantic.fileRead),
    ToolSemanticKind.search => _searchSummary(semantic.search),
    ToolSemanticKind.web => _webSummary(semantic.web),
    ToolSemanticKind.unknown => null,
  };
  if (summary == null || summary.isEmpty) return null;
  return summary;
}

ToolSummaryPresentation? _commandSummary(ToolCommandSemantic? semantic) {
  if (semantic == null) return null;
  return ToolSummaryPresentation(
    family: ToolPresentationFamily.command,
    primary: _clipTitle(semantic.command),
    secondary: semantic.cwd == null ? null : _clipTitle(semantic.cwd!),
  );
}

ToolSummaryPresentation? _fileReadSummary(ToolFileReadSemantic? semantic) {
  if (semantic == null) return null;
  return ToolSummaryPresentation(
    family: ToolPresentationFamily.fileRead,
    primary: _clipTitle(semantic.path),
  );
}

ToolSummaryPresentation? _searchSummary(ToolSearchSemantic? semantic) {
  if (semantic == null) return null;
  // `groups.length` is bounded by the decoder, so this stays constant work.
  final observedFiles = semantic.groups.isEmpty ? null : semantic.groups.length;
  return ToolSummaryPresentation(
    family: ToolPresentationFamily.search,
    primary: semantic.query == null ? null : _clipTitle(semantic.query!),
    secondary: semantic.scope == null ? null : _clipTitle(semantic.scope!),
    matchCount: semantic.matchCount,
    fileCount: semantic.fileCount ?? observedFiles,
  );
}

ToolSummaryPresentation? _webSummary(ToolWebSemantic? semantic) {
  if (semantic == null) return null;
  final url = semantic.url;
  final firstResult = semantic.results.isEmpty ? null : semantic.results.first;
  final domain = url != null
      ? toolWebDomain(url)
      : firstResult == null
      ? null
      : toolWebDomain(firstResult.url);
  return ToolSummaryPresentation(
    family: ToolPresentationFamily.web,
    primary: semantic.query == null ? domain : _clipTitle(semantic.query!),
    secondary: semantic.query == null ? null : domain,
    resultCount: semantic.results.isEmpty ? null : semantic.results.length,
  );
}

/// Builds the bounded command presentation for one tool row.
///
/// When the broker published no semantic (revision 8), the command line falls
/// back to the canonical `title` and the output is presented as *combined*,
/// because claiming a stream the source never separated would be a lie.
ToolCommandPresentation? buildToolCommandPresentation({
  required bool expanded,
  AgentMessage? call,
  AgentMessage? result,
}) {
  final semantic = (result?.toolSemantic ?? call?.toolSemantic)?.command;
  final maxLines = expanded
      ? ToolPresentationBounds.expandedOutputLines
      : ToolPresentationBounds.collapsedOutputLines;
  final maxChars = expanded
      ? ToolPresentationBounds.expandedOutputChars
      : ToolPresentationBounds.collapsedOutputChars;
  final exitCode = _intOrNull(result?.raw['exitCode']);

  if (semantic != null) {
    final stdout = semantic.stdout;
    final stderr = semantic.stderr;
    final separated = stdout != null || stderr != null;
    return ToolCommandPresentation(
      command: _clipTitle(semantic.command),
      cwd: semantic.cwd,
      state: semantic.state,
      exitCode: exitCode,
      hasSeparateStreams: separated,
      stdout: boundToolBody(
        stdout?.text,
        keepTail: true,
        maxLines: maxLines,
        maxChars: maxChars,
      ),
      stderr: boundToolBody(
        stderr?.text,
        keepTail: true,
        maxLines: maxLines,
        maxChars: maxChars,
      ),
      combined: separated
          ? BoundedToolText.empty
          : boundToolBody(
              _resultText(result),
              keepTail: true,
              maxLines: maxLines,
              maxChars: maxChars,
            ),
      stdoutTruncatedBySource: stdout?.truncated ?? false,
      stderrTruncatedBySource: stderr?.truncated ?? false,
    );
  }

  // Revision-8 fallback: the display class proved this is an execution, so the
  // canonical title is the closest honest command label available.
  final command =
      _stringOrNull(result?.raw['title']) ?? _stringOrNull(call?.raw['title']);
  if (command == null) return null;
  return ToolCommandPresentation(
    command: _clipTitle(command),
    state: result == null
        ? ToolCommandState.running
        : exitCode == null
        ? (result.raw['isError'] == true
              ? ToolCommandState.failed
              : ToolCommandState.unknown)
        : (exitCode == 0
              ? ToolCommandState.completed
              : ToolCommandState.failed),
    exitCode: exitCode,
    hasSeparateStreams: false,
    combined: boundToolBody(
      _resultText(result),
      keepTail: true,
      maxLines: maxLines,
      maxChars: maxChars,
    ),
  );
}

/// Builds the bounded file-read presentation, or null without a semantic.
ToolFileReadPresentation? buildToolFileReadPresentation({
  AgentMessage? call,
  AgentMessage? result,
}) {
  final semantic = (result?.toolSemantic ?? call?.toolSemantic)?.fileRead;
  if (semantic == null) return null;
  final reference = fileReadReference(semantic);
  if (semantic.unavailable != null) {
    return ToolFileReadPresentation(
      path: semantic.path,
      lines: const [],
      truncated: false,
      totalLines: semantic.totalLines,
      unavailable: semantic.unavailable,
      reference: reference,
    );
  }
  final bounded = boundToolBody(
    semantic.preview,
    keepTail: false,
    maxLines: ToolPresentationBounds.filePreviewLines,
    maxChars: ToolPresentationBounds.filePreviewChars,
  );
  if (bounded.isEmpty) {
    return ToolFileReadPresentation(
      path: semantic.path,
      lines: const [],
      truncated: semantic.previewTruncated,
      totalLines: semantic.totalLines,
      unavailable: semantic.preview == null
          ? null
          : ToolReadUnavailableReason.empty,
      reference: reference,
    );
  }
  // A source that published no start line gets NO gutter numbers — a number
  // counted from 1 would silently misreport an offset read.
  final start = semantic.startLine;
  final rows = <ToolPreviewLine>[];
  final split = bounded.text.split('\n');
  for (var index = 0; index < split.length; index++) {
    rows.add(
      ToolPreviewLine(
        text: split[index],
        number: start == null ? null : start + index,
      ),
    );
  }
  return ToolFileReadPresentation(
    path: semantic.path,
    lines: List.unmodifiable(rows),
    truncated: bounded.truncated || semantic.previewTruncated,
    totalLines: semantic.totalLines,
    reference: reference,
  );
}

/// Builds the bounded search presentation, or null without a semantic.
ToolSearchPresentation? buildToolSearchPresentation({
  AgentMessage? call,
  AgentMessage? result,
}) {
  final semantic = (result?.toolSemantic ?? call?.toolSemantic)?.search;
  if (semantic == null) return null;
  final groups = <ToolSearchGroupPresentation>[];
  for (final group in semantic.groups) {
    if (groups.length >= ToolPresentationBounds.searchGroups) break;
    final matches = <ToolPreviewLine>[];
    for (final match in group.matches) {
      if (matches.length >= ToolPresentationBounds.searchMatchesPerGroup) break;
      // Two independent clips can shorten one snippet: the sender's byte bound
      // (`match.truncated`) and this render bound. Either one makes the line
      // incomplete, so both must reach the reader.
      final clipped =
          match.text.length > ToolPresentationBounds.searchSnippetChars;
      final text = clipped
          ? match.text.substring(0, ToolPresentationBounds.searchSnippetChars)
          : match.text;
      matches.add(
        ToolPreviewLine(
          text: sanitizeControlSequences(text),
          number: match.line,
          truncated: clipped || match.truncated,
        ),
      );
    }
    groups.add(
      ToolSearchGroupPresentation(
        path: group.path,
        matchCount: group.matchCount,
        matches: List.unmodifiable(matches),
        truncated: group.truncated || matches.length < group.matches.length,
        reference: searchGroupReference(group),
      ),
    );
  }
  return ToolSearchPresentation(
    query: semantic.query,
    scope: semantic.scope,
    matchCount: semantic.matchCount,
    fileCount: semantic.fileCount,
    groups: List.unmodifiable(groups),
    truncated: semantic.truncated || groups.length < semantic.groups.length,
  );
}

/// Builds the bounded web presentation, or null without a semantic.
ToolWebPresentation? buildToolWebPresentation({
  AgentMessage? call,
  AgentMessage? result,
}) {
  final semantic = (result?.toolSemantic ?? call?.toolSemantic)?.web;
  if (semantic == null) return null;
  final results = <ToolWebResultPresentation>[];
  for (final item in semantic.results) {
    if (results.length >= ToolPresentationBounds.webResults) break;
    results.add(
      ToolWebResultPresentation(
        url: item.url,
        domain: toolWebDomain(item.url),
        title: item.title == null
            ? null
            : sanitizeControlSequences(item.title!),
        snippet: item.snippet == null
            ? null
            : sanitizeControlSequences(item.snippet!),
        truncated: item.truncated,
      ),
    );
  }
  return ToolWebPresentation(
    query: semantic.query,
    url: semantic.url,
    results: List.unmodifiable(results),
    truncated: semantic.truncated || results.length < semantic.results.length,
  );
}

/// The human-readable host for [url], or the trimmed URL when it cannot parse.
String toolWebDomain(String url) {
  final parsed = Uri.tryParse(url);
  final host = parsed?.host ?? '';
  if (host.isEmpty) {
    return url.length > 60 ? url.substring(0, 60) : url;
  }
  return host.startsWith('www.') ? host.substring(4) : host;
}

int? _intOrNull(Object? value) {
  if (value is int) return value;
  if (value is num && value.isFinite) return value.toInt();
  return null;
}

String? _stringOrNull(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

String _clipTitle(String value) {
  final sanitized = sanitizeControlSequences(value);
  const limit = ToolPresentationBounds.collapsedTitleChars;
  return sanitized.length <= limit
      ? sanitized
      : '${sanitized.substring(0, limit)}…';
}

/// The canonical result body as text, never stringifying a structured payload.
String? _resultText(AgentMessage? result) {
  final value = result?.raw['result'] ?? result?.raw['output'];
  if (value is String) return value;
  return null;
}

/// Field names whose VALUE is redacted wherever it appears in a payload.
///
/// Matching is on the normalized key, so `apiKey`, `api_key`, `API-KEY`, and
/// `x-api-key` all match one entry. This is a positive list of secret-bearing
/// names rather than a value heuristic: guessing "that looks like a token" both
/// misses real secrets and mangles ordinary content.
const Set<String> _redactedKeyParts = {
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'credential',
  'authorization',
  'auth',
  'session',
  'cookie',
  'bearer',
  'signature',
  'passphrase',
};

/// Whether [key] names a value that must never reach primary presentation.
bool isRedactedToolField(String key) {
  final normalized = key.toLowerCase().replaceAll(RegExp('[^a-z0-9]'), '');
  if (normalized.isEmpty) return false;
  for (final part in _redactedKeyParts) {
    if (normalized.contains(part)) return true;
  }
  return false;
}

/// One row of the bounded structured fallback.
final class ToolFallbackRow {
  /// Creates a fallback row.
  const ToolFallbackRow({
    required this.depth,
    required this.label,
    required this.value,
    this.redacted = false,
  });

  /// Nesting depth, for indentation only.
  final int depth;

  /// Field name or index label.
  final String label;

  /// Rendered scalar, or a structural placeholder for a nested container.
  final String value;

  /// Whether [value] replaced a secret-bearing field.
  final bool redacted;
}

/// The bounded, redacted structured fallback for a tool payload.
final class ToolFallbackPresentation {
  /// Creates a fallback presentation.
  const ToolFallbackPresentation({
    required this.rows,
    required this.truncated,
  });

  /// Deterministically ordered rows.
  final List<ToolFallbackRow> rows;

  /// Whether depth, entry, string, or total bounds withheld anything.
  final bool truncated;

  /// Whether there is nothing to show.
  bool get isEmpty => rows.isEmpty;
}

/// Renders an arbitrary provider payload as bounded, redacted, ordered rows.
///
/// Safe by construction against every hostile shape the requirement names:
/// depth is capped so deep nesting terminates; a visited-identity set makes a
/// cyclic-looking graph terminate at its first repeat; entry and total caps
/// bound breadth and volume; non-JSON scalars stringify through a bounded
/// clip; and secret-bearing field names are replaced before their value is ever
/// formatted. Map keys are sorted so the same payload always renders the same
/// way, which is what makes the output diffable and testable.
ToolFallbackPresentation buildToolFallbackPresentation(Object? payload) {
  final rows = <ToolFallbackRow>[];
  var totalChars = 0;
  var truncated = false;
  // Identity-based, not equality-based: two structurally equal siblings are
  // legitimately distinct, but a node reachable from itself is a cycle.
  final active = <Object>[];

  /// True once no further row may be emitted. Checked before every emit — the
  /// per-level entry cap bounds one level's breadth, but only this bounds the
  /// product of nested levels.
  bool exhausted() =>
      rows.length >= ToolPresentationBounds.fallbackTotalRows ||
      totalChars >= ToolPresentationBounds.fallbackTotalChars;

  /// Emits one row if budget remains; otherwise marks the walk truncated.
  bool emit(ToolFallbackRow row) {
    if (exhausted()) {
      truncated = true;
      return false;
    }
    rows.add(row);
    totalChars += row.label.length + row.value.length;
    return true;
  }

  void walk(String label, Object? value, int depth) {
    if (exhausted()) {
      truncated = true;
      return;
    }
    if (depth > ToolPresentationBounds.fallbackDepth) {
      emit(ToolFallbackRow(depth: depth, label: label, value: _elidedMarker));
      truncated = true;
      return;
    }
    if (isRedactedToolField(label)) {
      emit(
        ToolFallbackRow(
          depth: depth,
          label: label,
          value: _redactedMarker,
          redacted: true,
        ),
      );
      return;
    }
    if (value is Map || value is Iterable) {
      // Identity, not equality: two structurally equal siblings are
      // legitimately distinct, but a node reachable from itself is a cycle.
      if (active.any((entry) => identical(entry, value))) {
        emit(ToolFallbackRow(depth: depth, label: label, value: _cycleMarker));
        truncated = true;
        return;
      }
      active.add(value!);
      final entries = value is Map
          ? (value.keys.map((key) => key.toString()).toList()..sort())
                .map((key) => (key, value[_matchingKey(value, key)]))
                .toList()
          : [
              for (final (index, item) in (value as Iterable).indexed)
                ('[$index]', item),
            ];
      if (!emit(
        ToolFallbackRow(
          depth: depth,
          label: label,
          value: _containerMarker(entries.length),
        ),
      )) {
        active.removeLast();
        return;
      }
      for (var index = 0; index < entries.length; index++) {
        if (index >= ToolPresentationBounds.fallbackEntriesPerLevel) {
          truncated = true;
          break;
        }
        if (exhausted()) {
          truncated = true;
          break;
        }
        walk(entries[index].$1, entries[index].$2, depth + 1);
      }
      active.removeLast();
      return;
    }
    final scalar = _fallbackScalar(value);
    if (scalar.truncated) truncated = true;
    emit(ToolFallbackRow(depth: depth, label: label, value: scalar.text));
  }

  walk(_rootLabel, payload, 0);
  // The root container row carries no information the caller does not already
  // have from the card header; drop it so a one-field payload renders one row.
  if (rows.isNotEmpty && rows.first.label == _rootLabel && rows.length > 1) {
    rows.removeAt(0);
  }
  return ToolFallbackPresentation(
    rows: List.unmodifiable(rows),
    truncated: truncated,
  );
}

/// Recovers the original (possibly non-String) key equal to its string form.
Object? _matchingKey(Map<Object?, Object?> map, String key) {
  for (final candidate in map.keys) {
    if (candidate.toString() == key) return candidate;
  }
  return null;
}

const String _rootLabel = '';
const String _redactedMarker = '••••••';
const String _cycleMarker = '↻';
const String _elidedMarker = '…';

String _containerMarker(int count) => '($count)';

final class _FallbackScalar {
  const _FallbackScalar(this.text, {this.truncated = false});

  final String text;
  final bool truncated;
}

/// Formats one scalar for the fallback, bounded and control-safe.
///
/// Binary-like content (a byte list, or a string dense with control bytes) is
/// summarized instead of rendered, so a screen-reader never reads a megabyte of
/// mojibake and the layout never blows up on a single "line".
_FallbackScalar _fallbackScalar(Object? value) {
  if (value == null) return const _FallbackScalar('null');
  if (value is bool || value is num) {
    return _FallbackScalar(value.toString());
  }
  if (value is! String) {
    // A non-JSON object still has to render as something bounded.
    return _clipScalar(value.toString());
  }
  if (_looksBinary(value)) {
    return _FallbackScalar(
      _binaryMarker(utf8.encode(value).length),
      truncated: true,
    );
  }
  return _clipScalar(sanitizeControlSequences(value));
}

_FallbackScalar _clipScalar(String value) {
  if (value.length <= ToolPresentationBounds.fallbackStringChars) {
    return _FallbackScalar(value);
  }
  return _FallbackScalar(
    '${value.substring(0, ToolPresentationBounds.fallbackStringChars)}…',
    truncated: true,
  );
}

String _binaryMarker(int bytes) => '<binary $bytes B>';

/// Whether [value] reads as binary rather than text.
///
/// Sampling is bounded to the first 256 code units, so this costs the same for
/// a 1 KiB payload and a 10 MiB one.
bool _looksBinary(String value) {
  if (value.isEmpty) return false;
  final sample = value.length < 256 ? value.length : 256;
  var control = 0;
  for (var index = 0; index < sample; index++) {
    final unit = value.codeUnitAt(index);
    if (unit == 0) return true;
    if (unit < 0x09 || (unit > 0x0d && unit < 0x20) || unit == 0xfffd) {
      control++;
    }
  }
  return control * 8 > sample;
}
