/// Dependency-free parser for the markdown subset that agent transcripts emit.
///
/// Scope deliberately matches what the PoC surface renders (`apps/poc-ui`):
/// headings, bullet/ordered lists, fenced code, blockquotes, thematic breaks,
/// GitHub-style pipe tables, and the inline set (bold, italic, inline code,
/// strikethrough, links).
///
/// The parser never throws. Malformed input (unterminated fences, unbalanced
/// emphasis, stray brackets, a table header with no delimiter row) degrades to
/// literal text rather than failing, so a mid-stream agent chunk can always be
/// rendered.
library;

// Only for `@immutable`; the parser itself has no Flutter dependency and its
// tests run without a widget binding.
import 'package:flutter/foundation.dart';

/// One styled inline run of text.
///
/// Runs are flat: nested emphasis is resolved into a single run carrying every
/// applicable flag, so `**bold *and italic* **` yields a run with both set.
@immutable
class MarkdownInline {
  /// Creates an inline run.
  const MarkdownInline(
    this.text, {
    this.bold = false,
    this.italic = false,
    this.code = false,
    this.strikethrough = false,
    this.href,
  });

  /// Literal text with all markers removed.
  final String text;

  /// Whether the run renders bold.
  final bool bold;

  /// Whether the run renders italic.
  final bool italic;

  /// Whether the run renders as inline code.
  final bool code;

  /// Whether the run renders struck through.
  final bool strikethrough;

  /// Link target when the run sits inside a link, otherwise null.
  final String? href;

  @override
  bool operator ==(Object other) =>
      other is MarkdownInline &&
      other.text == text &&
      other.bold == bold &&
      other.italic == italic &&
      other.code == code &&
      other.strikethrough == strikethrough &&
      other.href == href;

  @override
  int get hashCode =>
      Object.hash(text, bold, italic, code, strikethrough, href);

  @override
  String toString() {
    final flags = <String>[
      if (bold) 'bold',
      if (italic) 'italic',
      if (code) 'code',
      if (strikethrough) 'strike',
      if (href != null) 'href=$href',
    ];
    final suffix = flags.isEmpty ? '' : ', ${flags.join(',')}';
    return 'MarkdownInline("$text"$suffix)';
  }
}

/// Base type for a block-level markdown node.
sealed class MarkdownBlock {
  const MarkdownBlock();
}

/// A run of body text.
class MarkdownParagraph extends MarkdownBlock {
  /// Creates a paragraph.
  const MarkdownParagraph(this.spans);

  /// Inline runs making up the paragraph.
  final List<MarkdownInline> spans;
}

/// An ATX heading (`#` through `######`).
class MarkdownHeading extends MarkdownBlock {
  /// Creates a heading of [level] 1-6.
  const MarkdownHeading(this.level, this.spans);

  /// Heading level as authored, clamped to 1-6.
  final int level;

  /// Inline runs making up the heading text.
  final List<MarkdownInline> spans;
}

/// An unordered list.
class MarkdownBulletList extends MarkdownBlock {
  /// Creates a bullet list.
  const MarkdownBulletList(this.items);

  /// One entry per list item.
  final List<List<MarkdownInline>> items;
}

/// An ordered list.
class MarkdownOrderedList extends MarkdownBlock {
  /// Creates an ordered list starting at [start].
  const MarkdownOrderedList(this.items, {this.start = 1});

  /// One entry per list item.
  final List<List<MarkdownInline>> items;

  /// First rendered ordinal, taken from the first marker.
  final int start;
}

/// A fenced code block rendered as a monospace box.
class MarkdownCodeBlock extends MarkdownBlock {
  /// Creates a code block.
  const MarkdownCodeBlock(this.code, {this.language = '', this.closed = true});

  /// Raw code text with the trailing newline trimmed.
  final String code;

  /// Info string after the opening fence, empty when absent.
  final String language;

  /// Whether a closing fence was found. False for mid-stream chunks.
  final bool closed;
}

/// Maximum fenced-code input that receives token styling: 128K UTF-16 code
/// units (Dart [String.length]), not a byte-size limit.
///
/// Larger blocks stay a single literal run. The transcript already bounds its
/// retained decoded window; this second bound prevents one legal message from
/// turning syntax highlighting into an unbounded allocation multiplier.
const int maxHighlightedTranscriptCodeUnits = 128 * 1024;

/// Maximum styled runs emitted for one lexed body.
///
/// Highly alternating input can otherwise create nearly one widget span per
/// character. Falling back to one literal run preserves both text and the
/// transcript's existing resource envelope.
///
/// Public because it is a bound hosts have to reason about, not just obey: it
/// is calibrated for a fenced snippet, and roughly 500 lines of ordinary source
/// reaches it. A host showing whole files decides what to do about that — see
/// [TranscriptCodeLineHighlighter].
const int maxHighlightedTranscriptCodeTokens = 4096;

/// Semantic class for one dependency-free fenced-code token.
enum TranscriptCodeTokenKind {
  /// Unstyled source text, including whitespace and identifiers.
  plain,

  /// Language keyword.
  keyword,

  /// Quoted string or character literal.
  string,

  /// Numeric literal.
  number,

  /// Line or block comment.
  comment,

  /// Built-in literal such as `true`, `false`, or `null`.
  literal,

  /// Punctuation/operator with syntactic meaning.
  operator,
}

/// One exact source slice and its semantic syntax class.
@immutable
class TranscriptCodeToken {
  /// Creates a token. [text] is never normalized or rewritten.
  const TranscriptCodeToken(
    this.text, {
    required this.kind,
  });

  /// Exact source characters represented by this token.
  final String text;

  /// Semantic syntax class used by the theme-aware renderer.
  final TranscriptCodeTokenKind kind;

  @override
  bool operator ==(Object other) =>
      other is TranscriptCodeToken && other.text == text && other.kind == kind;

  @override
  int get hashCode => Object.hash(text, kind);
}

final class _CodeLanguageProfile {
  const _CodeLanguageProfile({
    required this.keywords,
    this.hashComments = false,
    this.slashComments = false,
    this.dashComments = false,
    this.blockComments = false,
    this.htmlComments = false,
    this.backtickStrings = false,
  });

  final Set<String> keywords;
  final bool hashComments;
  final bool slashComments;
  final bool dashComments;
  final bool blockComments;
  final bool htmlComments;
  final bool backtickStrings;
}

const _cKeywords = <String>{
  'abstract',
  'as',
  'async',
  'await',
  'bool',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'export',
  'extends',
  'extension',
  'final',
  'finally',
  'float',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'int',
  'interface',
  'is',
  'let',
  'long',
  'new',
  'override',
  'private',
  'protected',
  'public',
  'record',
  'required',
  'return',
  'sealed',
  'short',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'throws',
  'try',
  'typedef',
  'typeof',
  'var',
  'void',
  'when',
  'while',
  'with',
  'yield',
};
const _pythonKeywords = <String>{
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'case',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'match',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
};
const _shellKeywords = <String>{
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'export',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
};
const _sqlKeywords = <String>{
  'alter',
  'and',
  'as',
  'asc',
  'begin',
  'between',
  'by',
  'case',
  'commit',
  'create',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'exists',
  'from',
  'group',
  'having',
  'in',
  'index',
  'inner',
  'insert',
  'into',
  'is',
  'join',
  'left',
  'limit',
  'not',
  'null',
  'on',
  'or',
  'order',
  'outer',
  'primary',
  'references',
  'right',
  'rollback',
  'select',
  'set',
  'table',
  'then',
  'union',
  'unique',
  'update',
  'values',
  'when',
  'where',
};
const _markupKeywords = <String>{
  'doctype',
  'html',
  'head',
  'body',
  'script',
  'style',
  'div',
  'span',
  'main',
  'section',
  'header',
  'footer',
  'button',
  'input',
  'meta',
  'link',
};

final Map<String, _CodeLanguageProfile> _codeLanguageProfiles = {
  for (final alias in [
    'c',
    'cc',
    'cpp',
    'c++',
    'csharp',
    'cs',
    'dart',
    'go',
    'java',
    'js',
    'javascript',
    'jsx',
    'kotlin',
    'kt',
    'rust',
    'rs',
    'swift',
    'ts',
    'typescript',
    'tsx',
  ])
    alias: const _CodeLanguageProfile(
      keywords: _cKeywords,
      slashComments: true,
      blockComments: true,
      backtickStrings: true,
    ),
  for (final alias in ['py', 'python', 'rb', 'ruby'])
    alias: const _CodeLanguageProfile(
      keywords: _pythonKeywords,
      hashComments: true,
    ),
  for (final alias in ['bash', 'sh', 'shell', 'zsh'])
    alias: const _CodeLanguageProfile(
      keywords: _shellKeywords,
      hashComments: true,
      backtickStrings: true,
    ),
  for (final alias in ['json', 'jsonc'])
    alias: _CodeLanguageProfile(
      keywords: const {},
      slashComments: alias == 'jsonc',
      blockComments: alias == 'jsonc',
    ),
  for (final alias in ['yaml', 'yml', 'toml'])
    alias: const _CodeLanguageProfile(keywords: {}, hashComments: true),
  for (final alias in ['sql', 'sqlite'])
    alias: const _CodeLanguageProfile(
      keywords: _sqlKeywords,
      dashComments: true,
      blockComments: true,
    ),
  for (final alias in ['html', 'htm', 'xml', 'svg'])
    alias: const _CodeLanguageProfile(
      keywords: _markupKeywords,
      htmlComments: true,
    ),
  'css': const _CodeLanguageProfile(
    keywords: {},
    blockComments: true,
  ),
};

/// Highlights a bounded fenced-code body without changing any source byte.
///
/// Unknown languages, empty language labels, oversized blocks, and adversarial
/// token counts return one plain run. The scanner is a deliberately small
/// lexical highlighter: it never parses or executes code and never touches the
/// Markdown AST used by copy, selection, read-aloud, or structured renderers.
List<TranscriptCodeToken> highlightTranscriptCode(
  String source, {
  required String language,
}) => highlightTranscriptCodeDetailed(source, language: language).tokens;

/// Lexes [source] under [profile], or null when it blew the token budget.
List<TranscriptCodeToken>? _scanTranscriptCode(
  String source,
  _CodeLanguageProfile profile,
) {
  final ranges = <({int start, int end, TranscriptCodeTokenKind kind})>[];
  var index = 0;
  bool add(int end, TranscriptCodeTokenKind kind) {
    if (end <= index) return true;
    if (ranges.isNotEmpty && ranges.last.kind == kind) {
      final previous = ranges.removeLast();
      ranges.add((start: previous.start, end: end, kind: kind));
    } else {
      ranges.add((start: index, end: end, kind: kind));
    }
    index = end;
    return ranges.length <= maxHighlightedTranscriptCodeTokens;
  }

  while (index < source.length) {
    final start = index;
    if (profile.htmlComments && source.startsWith('<!--', index)) {
      final close = source.indexOf('-->', index + 4);
      if (!add(
        close < 0 ? source.length : close + 3,
        TranscriptCodeTokenKind.comment,
      )) {
        return null;
      }
      continue;
    }
    if (profile.blockComments && source.startsWith('/*', index)) {
      final close = source.indexOf('*/', index + 2);
      if (!add(
        close < 0 ? source.length : close + 2,
        TranscriptCodeTokenKind.comment,
      )) {
        return null;
      }
      continue;
    }
    if ((profile.slashComments && source.startsWith('//', index)) ||
        (profile.dashComments && source.startsWith('--', index)) ||
        (profile.hashComments && source.codeUnitAt(index) == 0x23)) {
      final newline = source.indexOf('\n', index);
      if (!add(
        newline < 0 ? source.length : newline,
        TranscriptCodeTokenKind.comment,
      )) {
        return null;
      }
      continue;
    }

    final unit = source.codeUnitAt(index);
    if (unit == 0x22 ||
        unit == 0x27 ||
        (unit == 0x60 && profile.backtickStrings)) {
      final quote = unit;
      index++;
      var escaped = false;
      while (index < source.length) {
        final next = source.codeUnitAt(index++);
        if (escaped) {
          escaped = false;
        } else if (next == 0x5c) {
          escaped = true;
        } else if (next == quote) {
          break;
        }
      }
      final end = index;
      index = start;
      if (!add(end, TranscriptCodeTokenKind.string)) {
        return null;
      }
      continue;
    }

    if (_isCodeDigit(unit)) {
      index++;
      while (index < source.length) {
        final next = source.codeUnitAt(index);
        if (!_isCodeNumberUnit(next)) break;
        index++;
      }
      final end = index;
      index = start;
      if (!add(end, TranscriptCodeTokenKind.number)) {
        return null;
      }
      continue;
    }

    if (_isCodeIdentifierStart(unit)) {
      index++;
      while (index < source.length &&
          _isCodeIdentifierPart(source.codeUnitAt(index))) {
        index++;
      }
      final end = index;
      final word = source.substring(start, end);
      final lower = word.toLowerCase();
      final kind = profile.keywords.contains(lower)
          ? TranscriptCodeTokenKind.keyword
          : const {'true', 'false', 'null', 'none', 'undefined'}.contains(lower)
          ? TranscriptCodeTokenKind.literal
          : TranscriptCodeTokenKind.plain;
      index = start;
      if (!add(end, kind)) {
        return null;
      }
      continue;
    }

    index++;
    final end = index;
    final kind = _isCodeOperator(unit)
        ? TranscriptCodeTokenKind.operator
        : TranscriptCodeTokenKind.plain;
    index = start;
    if (!add(end, kind)) {
      return null;
    }
  }
  return List<TranscriptCodeToken>.unmodifiable([
    for (final range in ranges)
      TranscriptCodeToken(
        source.substring(range.start, range.end),
        kind: range.kind,
      ),
  ]);
}

/// Why a highlight attempt fell back to one plain run.
enum TranscriptCodeDecline {
  /// The language label has no lexical profile.
  noProfile,

  /// Input exceeded [maxHighlightedTranscriptCodeUnits].
  tooLarge,

  /// Styling exceeded [maxHighlightedTranscriptCodeTokens].
  tooManyTokens,
}

/// One highlight attempt: its runs, and why it declined when it did.
typedef TranscriptCodeHighlight = ({
  List<TranscriptCodeToken> tokens,
  TranscriptCodeDecline? declined,
});

/// Highlights [source], reporting whether the highlighter declined.
///
/// [highlightTranscriptCode] answers the same question by returning one plain
/// run, but a caller cannot tell that apart from a file that genuinely has no
/// keywords in it. A host that must say "syntax highlighting is off, and the
/// text is still complete" needs the reason, and the two size bounds are not
/// enough on their own to derive it: the token bound is only knowable after
/// lexing.
TranscriptCodeHighlight highlightTranscriptCodeDetailed(
  String source, {
  required String language,
}) {
  TranscriptCodeHighlight plain(TranscriptCodeDecline reason) => (
    tokens: [TranscriptCodeToken(source, kind: TranscriptCodeTokenKind.plain)],
    declined: reason,
  );

  final profile = _codeLanguageProfiles[language.trim().toLowerCase()];
  if (source.isEmpty) return (tokens: const [], declined: null);
  if (profile == null) return plain(TranscriptCodeDecline.noProfile);
  if (source.length > maxHighlightedTranscriptCodeUnits) {
    return plain(TranscriptCodeDecline.tooLarge);
  }
  final tokens = _scanTranscriptCode(source, profile);
  if (tokens == null) return plain(TranscriptCodeDecline.tooManyTokens);
  return (tokens: tokens, declined: null);
}

/// Where a line begins, for the one construct that spans lines.
enum _TranscriptCodeCarry {
  /// Ordinary code.
  none,

  /// Inside an unclosed `/* … */`.
  block,

  /// Inside an unclosed `<!-- … -->`.
  html,
}

/// Highlights a whole source file one line at a time.
///
/// The transcript's budgets are calibrated for fenced snippets: 4,096 styled
/// runs is roughly 500 lines of ordinary source, so handing a whole file to
/// [highlightTranscriptCode] greys out most real files. Lexing per line keeps
/// every call far inside both bounds, and matches a viewer whose
/// `ListView.builder` builds one line at a time anyway.
///
/// Block and HTML comments are the only constructs here that legitimately span
/// lines, so the carry state for every line is settled in one linear pass at
/// construction. That keeps a jump to line 12,000 correct without lexing the
/// 11,999 lines above it. An unterminated string stops at end of line rather
/// than running to end of file, which is what an editor does and is strictly
/// better than the whole-block lexer's behaviour.
class TranscriptCodeLineHighlighter {
  /// Prepares [lines] for per-line highlighting as [language].
  factory TranscriptCodeLineHighlighter(
    List<String> lines, {
    required String language,
  }) {
    final profile = _codeLanguageProfiles[language.trim().toLowerCase()];
    if (profile == null) {
      return TranscriptCodeLineHighlighter._(
        lines,
        null,
        const [],
        declined: TranscriptCodeDecline.noProfile,
      );
    }

    final carries = List<_TranscriptCodeCarry>.filled(
      lines.length,
      _TranscriptCodeCarry.none,
    );
    TranscriptCodeDecline? declined;
    var carry = _TranscriptCodeCarry.none;
    for (var i = 0; i < lines.length; i++) {
      carries[i] = carry;
      final line = lines[i];
      // Both ways a single line can decline, settled up front so the notice is
      // a property of the file rather than of whatever is on screen. The token
      // bound needs a lex, but a line cannot reach 4,096 runs with fewer than
      // 4,096 characters — so in real source nothing here is ever lexed twice.
      if (declined == null) {
        if (line.length > maxHighlightedTranscriptCodeUnits) {
          declined = TranscriptCodeDecline.tooLarge;
        } else if (line.length > maxHighlightedTranscriptCodeTokens &&
            _scanTranscriptCode(line, profile) == null) {
          declined = TranscriptCodeDecline.tooManyTokens;
        }
      }
      carry = _carryAfterLine(line, profile, carry);
    }
    return TranscriptCodeLineHighlighter._(
      lines,
      profile,
      carries,
      declined: declined,
    );
  }

  TranscriptCodeLineHighlighter._(
    this._lines,
    this._profile,
    this._carries, {
    required this.declined,
  });

  final List<String> _lines;
  final _CodeLanguageProfile? _profile;
  final List<_TranscriptCodeCarry> _carries;

  /// Why some line in this file will render unstyled, when one will.
  ///
  /// Null means every line is highlighted. A host shows its "highlighting is
  /// off, the text is complete" notice exactly when this is non-null and the
  /// reason is not [TranscriptCodeDecline.noProfile] — an unknown language was
  /// never offered highlighting, so there is nothing to explain.
  final TranscriptCodeDecline? declined;

  /// Whether this file has a lexical profile at all.
  bool get hasProfile => _profile != null;

  /// The styled runs for the line at [index], zero-based.
  List<TranscriptCodeToken> tokensFor(int index) {
    final line = _lines[index];
    final profile = _profile;
    if (profile == null || line.isEmpty) {
      return line.isEmpty
          ? const []
          : [TranscriptCodeToken(line, kind: TranscriptCodeTokenKind.plain)];
    }

    final carry = _carries[index];
    if (carry == _TranscriptCodeCarry.none) {
      return _scanTranscriptCode(line, profile) ??
          [TranscriptCodeToken(line, kind: TranscriptCodeTokenKind.plain)];
    }

    // The line opened inside a comment. Close it, then lex what follows as
    // ordinary code — a `*/` halfway down a line is followed by real source.
    final closer = carry == _TranscriptCodeCarry.block ? '*/' : '-->';
    final close = line.indexOf(closer);
    if (close < 0) {
      return [TranscriptCodeToken(line, kind: TranscriptCodeTokenKind.comment)];
    }
    final end = close + closer.length;
    final rest = line.substring(end);
    return [
      TranscriptCodeToken(
        line.substring(0, end),
        kind: TranscriptCodeTokenKind.comment,
      ),
      if (rest.isNotEmpty)
        ...(_scanTranscriptCode(rest, profile) ??
            [TranscriptCodeToken(rest, kind: TranscriptCodeTokenKind.plain)]),
    ];
  }
}

/// Where the line after [line] begins, given it began at [carry].
///
/// Walks the line skipping strings and line comments, so a `/*` inside a
/// string literal does not open a comment that swallows the rest of the file.
_TranscriptCodeCarry _carryAfterLine(
  String line,
  _CodeLanguageProfile profile,
  _TranscriptCodeCarry carry,
) {
  var index = 0;
  var state = carry;
  while (index < line.length) {
    if (state != _TranscriptCodeCarry.none) {
      final closer = state == _TranscriptCodeCarry.block ? '*/' : '-->';
      final close = line.indexOf(closer, index);
      if (close < 0) return state;
      index = close + closer.length;
      state = _TranscriptCodeCarry.none;
      continue;
    }
    if (profile.htmlComments && line.startsWith('<!--', index)) {
      index += 4;
      state = _TranscriptCodeCarry.html;
      continue;
    }
    if (profile.blockComments && line.startsWith('/*', index)) {
      index += 2;
      state = _TranscriptCodeCarry.block;
      continue;
    }
    if ((profile.slashComments && line.startsWith('//', index)) ||
        (profile.dashComments && line.startsWith('--', index)) ||
        (profile.hashComments && line.codeUnitAt(index) == 0x23)) {
      return _TranscriptCodeCarry.none;
    }
    final unit = line.codeUnitAt(index);
    if (unit == 0x22 ||
        unit == 0x27 ||
        (unit == 0x60 && profile.backtickStrings)) {
      index++;
      var escaped = false;
      while (index < line.length) {
        final next = line.codeUnitAt(index++);
        if (escaped) {
          escaped = false;
        } else if (next == 0x5c) {
          escaped = true;
        } else if (next == unit) {
          break;
        }
      }
      continue;
    }
    index++;
  }
  return state;
}

bool _isCodeDigit(int unit) => unit >= 0x30 && unit <= 0x39;

bool _isCodeNumberUnit(int unit) =>
    _isCodeDigit(unit) ||
    (unit >= 0x41 && unit <= 0x46) ||
    (unit >= 0x61 && unit <= 0x66) ||
    unit == 0x2e ||
    unit == 0x5f ||
    unit == 0x78 ||
    unit == 0x58;

bool _isCodeIdentifierStart(int unit) =>
    (unit >= 0x41 && unit <= 0x5a) ||
    (unit >= 0x61 && unit <= 0x7a) ||
    unit == 0x5f ||
    unit == 0x24;

bool _isCodeIdentifierPart(int unit) =>
    _isCodeIdentifierStart(unit) || _isCodeDigit(unit);

bool _isCodeOperator(int unit) => const {
  0x21,
  0x25,
  0x26,
  0x2a,
  0x2b,
  0x2d,
  0x2f,
  0x3a,
  0x3c,
  0x3d,
  0x3e,
  0x3f,
  0x5b,
  0x5d,
  0x7b,
  0x7c,
  0x7d,
  0x7e,
}.contains(unit);

/// A `>` quoted block.
class MarkdownBlockquote extends MarkdownBlock {
  /// Creates a blockquote.
  const MarkdownBlockquote(this.spans);

  /// Inline runs making up the quoted text.
  final List<MarkdownInline> spans;
}

/// A horizontal rule.
class MarkdownThematicBreak extends MarkdownBlock {
  /// Creates a thematic break.
  const MarkdownThematicBreak();
}

/// Per-column horizontal alignment for a [MarkdownTable], read from the
/// delimiter row (`:--` left, `--:` right, `:-:` center, `---` unspecified).
enum MarkdownTableAlignment {
  /// No alignment marker (`---`); the renderer falls back to left.
  none,

  /// Left-aligned column (`:--`).
  left,

  /// Center-aligned column (`:-:`).
  center,

  /// Right-aligned column (`--:`).
  right,
}

/// A GitHub-style pipe table.
///
/// A table is only recognized when a header row is immediately followed by a
/// valid delimiter row (`|---|:--:|`) whose cell count matches the header;
/// otherwise the lines stay paragraph text. Body rows are normalized to the
/// header's column count (extra cells dropped, missing cells filled empty), so
/// a ragged table never throws and never renders a jagged grid.
class MarkdownTable extends MarkdownBlock {
  /// Creates a table from its header, per-column alignments, and body rows.
  const MarkdownTable(this.header, this.alignments, this.rows);

  /// Header cells, one inline run list per column.
  final List<List<MarkdownInline>> header;

  /// Alignment per column; always the same length as [header].
  final List<MarkdownTableAlignment> alignments;

  /// Body rows; each row has exactly [header] `.length` cells.
  final List<List<List<MarkdownInline>>> rows;

  /// Column count, taken from the header.
  int get columnCount => header.length;
}

final RegExp _headingPattern = RegExp(r'^ {0,3}(#{1,6})\s+(.*)$');
final RegExp _fencePattern = RegExp(r'^ {0,3}(`{3,}|~{3,})\s*([\w+#.\-]*)\s*$');
final RegExp _thematicBreakPattern = RegExp(r'^ {0,3}([-*_])(\s*\1){2,}\s*$');
final RegExp _blockquotePattern = RegExp(r'^ {0,3}>\s?');
final RegExp _bulletPattern = RegExp(r'^ {0,3}[-*+]\s+');
final RegExp _orderedPattern = RegExp(r'^ {0,3}(\d{1,9})[.)]\s+');
final RegExp _blankPattern = RegExp(r'^\s*$');

/// One delimiter cell: at least one dash, with optional alignment colons.
final RegExp _tableDelimiterCellPattern = RegExp(r'^:?-+:?$');

/// Parses [source] into block nodes.
///
/// Returns an empty list for null, empty, or whitespace-only input. Input with
/// no markdown syntax comes back as a single [MarkdownParagraph] whose text is
/// byte-identical to the input, so plain messages are never altered.
List<MarkdownBlock> parseTranscriptMarkdown(String? source) {
  final text = source ?? '';
  if (text.trim().isEmpty) {
    return const [];
  }

  final normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  final lines = normalized.split('\n');
  final blocks = <MarkdownBlock>[];
  var i = 0;

  while (i < lines.length) {
    final line = lines[i];

    final fence = _fencePattern.firstMatch(line);
    if (fence != null) {
      final marker = fence.group(1)!;
      final language = fence.group(2) ?? '';
      final body = <String>[];
      var closed = false;
      i++;
      while (i < lines.length) {
        final candidate = lines[i];
        final closer = _fencePattern.firstMatch(candidate);
        // A closing fence uses the same character and is at least as long.
        if (closer != null &&
            closer.group(1)![0] == marker[0] &&
            closer.group(1)!.length >= marker.length &&
            (closer.group(2) ?? '').isEmpty) {
          closed = true;
          i++;
          break;
        }
        body.add(candidate);
        i++;
      }
      blocks.add(
        MarkdownCodeBlock(
          body.join('\n'),
          language: language,
          closed: closed,
        ),
      );
      continue;
    }

    if (_blankPattern.hasMatch(line)) {
      i++;
      continue;
    }

    if (_thematicBreakPattern.hasMatch(line)) {
      blocks.add(const MarkdownThematicBreak());
      i++;
      continue;
    }

    final heading = _headingPattern.firstMatch(line);
    if (heading != null) {
      final level = heading.group(1)!.length;
      final spans = parseTranscriptMarkdownInline(heading.group(2));
      blocks.add(MarkdownHeading(level, spans));
      i++;
      continue;
    }

    if (_blockquotePattern.hasMatch(line)) {
      final buffer = <String>[];
      while (i < lines.length && _blockquotePattern.hasMatch(lines[i])) {
        buffer.add(lines[i].replaceFirst(_blockquotePattern, ''));
        i++;
      }
      blocks.add(
        MarkdownBlockquote(parseTranscriptMarkdownInline(buffer.join('\n'))),
      );
      continue;
    }

    if (_bulletPattern.hasMatch(line)) {
      final items = <List<MarkdownInline>>[];
      while (i < lines.length && _bulletPattern.hasMatch(lines[i])) {
        items.add(
          parseTranscriptMarkdownInline(
            lines[i].replaceFirst(_bulletPattern, ''),
          ),
        );
        i++;
      }
      blocks.add(MarkdownBulletList(items));
      continue;
    }

    final ordered = _orderedPattern.firstMatch(line);
    if (ordered != null) {
      final start = int.tryParse(ordered.group(1)!) ?? 1;
      final items = <List<MarkdownInline>>[];
      while (i < lines.length && _orderedPattern.hasMatch(lines[i])) {
        items.add(
          parseTranscriptMarkdownInline(
            lines[i].replaceFirst(_orderedPattern, ''),
          ),
        );
        i++;
      }
      blocks.add(MarkdownOrderedList(items, start: start));
      continue;
    }

    // Table: a header row immediately followed by a valid delimiter row.
    if (_tableStartsAt(lines, i)) {
      final header = _splitTableRow(line);
      final alignments = _parseDelimiterRow(lines[i + 1])!;
      final headerCells = [
        for (final cell in header) parseTranscriptMarkdownInline(cell),
      ];
      i += 2;
      final rows = <List<List<MarkdownInline>>>[];
      while (i < lines.length && !_startsNewBlock(lines[i])) {
        final cells = _splitTableRow(lines[i]);
        rows.add([
          for (var c = 0; c < headerCells.length; c++)
            parseTranscriptMarkdownInline(c < cells.length ? cells[c] : ''),
        ]);
        i++;
      }
      blocks.add(MarkdownTable(headerCells, alignments, rows));
      continue;
    }

    // Paragraph: run until a blank line or the start of another block.
    final buffer = <String>[];
    while (i < lines.length &&
        !_startsNewBlock(lines[i]) &&
        !_tableStartsAt(lines, i)) {
      buffer.add(lines[i]);
      i++;
    }
    if (buffer.isEmpty) {
      // Defensive: never spin without consuming a line.
      buffer.add(lines[i]);
      i++;
    }
    blocks.add(
      MarkdownParagraph(parseTranscriptMarkdownInline(buffer.join('\n'))),
    );
  }

  return blocks;
}

bool _startsNewBlock(String line) {
  return _blankPattern.hasMatch(line) ||
      _fencePattern.hasMatch(line) ||
      _thematicBreakPattern.hasMatch(line) ||
      _headingPattern.hasMatch(line) ||
      _blockquotePattern.hasMatch(line) ||
      _bulletPattern.hasMatch(line) ||
      _orderedPattern.hasMatch(line);
}

/// Whether a pipe table begins at [lines] index [i]: a pipe-bearing header row
/// whose immediate successor is a delimiter row with the same column count.
bool _tableStartsAt(List<String> lines, int i) {
  if (i + 1 >= lines.length) {
    return false;
  }
  final header = lines[i];
  if (!header.contains('|')) {
    return false;
  }
  final headerCells = _splitTableRow(header);
  if (headerCells.isEmpty) {
    return false;
  }
  final alignments = _parseDelimiterRow(lines[i + 1]);
  return alignments != null && alignments.length == headerCells.length;
}

/// Splits a pipe-table row into trimmed cell strings.
///
/// One optional leading and trailing pipe is dropped, `\|` is left intact for
/// the inline parser to unescape, and `\\` is treated as an escaped backslash.
List<String> _splitTableRow(String line) {
  final trimmed = line.trim();
  final cells = <String>[];
  final current = StringBuffer();
  var i = 0;
  while (i < trimmed.length) {
    final char = trimmed[i];
    if (char == r'\' && i + 1 < trimmed.length) {
      // Keep the escape sequence verbatim; inline parsing resolves it later.
      current
        ..write(char)
        ..write(trimmed[i + 1]);
      i += 2;
      continue;
    }
    if (char == '|') {
      cells.add(current.toString().trim());
      current.clear();
      i++;
      continue;
    }
    current.write(char);
    i++;
  }
  cells.add(current.toString().trim());
  // Drop the empty cells produced by an optional leading/trailing pipe.
  if (cells.length > 1 && trimmed.startsWith('|')) {
    cells.removeAt(0);
  }
  if (cells.length > 1 && trimmed.endsWith('|') && !trimmed.endsWith(r'\|')) {
    cells.removeLast();
  }
  return cells;
}

/// Parses a delimiter row into per-column alignments, or null when [line] is
/// not a valid delimiter row (every cell must be `:?-+:?`).
List<MarkdownTableAlignment>? _parseDelimiterRow(String line) {
  if (!line.contains('-')) {
    return null;
  }
  final cells = _splitTableRow(line);
  if (cells.isEmpty) {
    return null;
  }
  final alignments = <MarkdownTableAlignment>[];
  for (final cell in cells) {
    if (!_tableDelimiterCellPattern.hasMatch(cell)) {
      return null;
    }
    final left = cell.startsWith(':');
    final right = cell.endsWith(':');
    alignments.add(
      left && right
          ? MarkdownTableAlignment.center
          : right
          ? MarkdownTableAlignment.right
          : left
          ? MarkdownTableAlignment.left
          : MarkdownTableAlignment.none,
    );
  }
  return alignments;
}

/// Whether [href] is an http/https URL the transcript may open on tap.
///
/// This is the single source of truth for the product rule that only web URLs
/// are tappable. `file://`, absolute or relative device paths, `mailto:`, and
/// every other scheme return false, so the renderer leaves them as plain text.
/// Opening local files is a future roadmap item and deliberately not enabled.
bool isTranscriptHttpUrl(String? href) {
  if (href == null) {
    return false;
  }
  final trimmed = href.trim();
  if (trimmed.isEmpty) {
    return false;
  }
  final uri = Uri.tryParse(trimmed);
  if (uri == null || !uri.hasScheme) {
    return false;
  }
  final scheme = uri.scheme.toLowerCase();
  return scheme == 'http' || scheme == 'https';
}

/// Parses inline markers in [source] into flat styled runs.
///
/// Unbalanced markers are emitted as literal text. Adjacent runs sharing the
/// same style are merged so callers get the fewest spans possible.
List<MarkdownInline> parseTranscriptMarkdownInline(String? source) {
  final text = source ?? '';
  if (text.isEmpty) {
    return const [];
  }
  // Guard against O(n^2) rescans on a pathological single line (many unclosed
  // `[`, `*`, or backtick markers each rescan to end of string). Above this
  // length inline styling is skipped and the text emitted literally. Fenced
  // code is a block, handled before this, so real code is never affected.
  if (text.length > _maxInlineScanLength) {
    return [MarkdownInline(text)];
  }
  final runs = <MarkdownInline>[];
  _parseInlineInto(runs, text, const _InlineStyle());
  return _mergeRuns(runs);
}

class _InlineStyle {
  const _InlineStyle({
    this.bold = false,
    this.italic = false,
    this.strikethrough = false,
    this.href,
  });

  final bool bold;
  final bool italic;
  final bool strikethrough;
  final String? href;

  _InlineStyle copyWith({
    bool? bold,
    bool? italic,
    bool? strikethrough,
    String? href,
  }) {
    return _InlineStyle(
      bold: bold ?? this.bold,
      italic: italic ?? this.italic,
      strikethrough: strikethrough ?? this.strikethrough,
      href: href ?? this.href,
    );
  }
}

const int _maxInlineDepth = 8;

/// Inline styling is skipped above this length to bound worst-case scanning.
const int _maxInlineScanLength = 20000;

void _parseInlineInto(
  List<MarkdownInline> out,
  String source,
  _InlineStyle style, {
  int depth = 0,
}) {
  // Depth guard: pathological nesting degrades to literal text instead of
  // exhausting the stack.
  if (depth > _maxInlineDepth) {
    _emit(out, source, style);
    return;
  }

  final buffer = StringBuffer();
  var i = 0;

  void flush() {
    if (buffer.isNotEmpty) {
      _emit(out, buffer.toString(), style);
      buffer.clear();
    }
  }

  while (i < source.length) {
    final char = source[i];

    // Backslash escape. CommonMark only escapes ASCII punctuation; before any
    // other character the backslash is literal. Consuming it unconditionally
    // silently mangled `C:\Data\config` into `C:Dataconfig` and `\d+` into
    // `d+`, breaking byte-for-byte preservation of ordinary prose.
    if (char == r'\' &&
        i + 1 < source.length &&
        _isAsciiPunctuation(source[i + 1])) {
      buffer.write(source[i + 1]);
      i += 2;
      continue;
    }

    // Inline code binds tightest and never nests other markers.
    if (char == '`') {
      final ticks = _runLength(source, i, '`');
      final closer = source.indexOf('`' * ticks, i + ticks);
      if (closer != -1) {
        flush();
        out.add(
          MarkdownInline(
            source.substring(i + ticks, closer),
            code: true,
            bold: style.bold,
            italic: style.italic,
            strikethrough: style.strikethrough,
            href: style.href,
          ),
        );
        i = closer + ticks;
        continue;
      }
      buffer.write(char);
      i++;
      continue;
    }

    // Link: [text](href)
    if (char == '[') {
      final link = _matchLink(source, i);
      if (link != null) {
        flush();
        final labelRuns = <MarkdownInline>[];
        _parseInlineInto(
          labelRuns,
          link.text,
          style.copyWith(href: link.href),
          depth: depth + 1,
        );
        out.addAll(labelRuns);
        final visibleLabel = labelRuns.map((run) => run.text).join();
        if (!isTranscriptHttpUrl(link.href) && visibleLabel != link.href) {
          _emit(
            out,
            ' (${link.href})',
            style.copyWith(href: link.href),
          );
        }
        i = link.end;
        continue;
      }
      buffer.write(char);
      i++;
      continue;
    }

    // Strikethrough: ~~text~~
    if (char == '~' && source.startsWith('~~', i)) {
      final closer = source.indexOf('~~', i + 2);
      if (closer != -1 && closer > i + 2) {
        flush();
        _parseInlineInto(
          out,
          source.substring(i + 2, closer),
          style.copyWith(strikethrough: true),
          depth: depth + 1,
        );
        i = closer + 2;
        continue;
      }
      buffer.write(char);
      i++;
      continue;
    }

    // Strong: ** or __ (checked before single-marker emphasis).
    if ((char == '*' || char == '_') && source.startsWith(char * 2, i)) {
      final marker = char * 2;
      final closer = _findEmphasisCloser(source, i + 2, marker, char);
      if (closer != -1) {
        flush();
        _parseInlineInto(
          out,
          source.substring(i + 2, closer),
          style.copyWith(bold: true),
          depth: depth + 1,
        );
        i = closer + 2;
        continue;
      }
      buffer.write(char);
      i++;
      continue;
    }

    // Emphasis: * or _
    if (char == '*' || char == '_') {
      // `_` inside a word (snake_case) is literal, matching common renderers.
      final precededByWord = i > 0 && _isWordChar(source[i - 1]);
      final opensRun =
          i + 1 < source.length &&
          !_isSpace(source[i + 1]) &&
          source[i + 1] != char;
      if (opensRun && !(char == '_' && precededByWord)) {
        final closer = _findEmphasisCloser(source, i + 1, char, char);
        if (closer != -1 &&
            !(char == '_' &&
                closer + 1 < source.length &&
                _isWordChar(source[closer + 1]))) {
          flush();
          _parseInlineInto(
            out,
            source.substring(i + 1, closer),
            style.copyWith(italic: true),
            depth: depth + 1,
          );
          i = closer + 1;
          continue;
        }
      }
      buffer.write(char);
      i++;
      continue;
    }

    buffer.write(char);
    i++;
  }

  flush();
}

/// Finds the closing [marker] starting at [from], skipping inline code spans
/// and escaped characters. Returns -1 when unbalanced.
int _findEmphasisCloser(String source, int from, String marker, String char) {
  var i = from;
  while (i < source.length) {
    final current = source[i];
    if (current == r'\') {
      i += 2;
      continue;
    }
    if (current == '`') {
      final ticks = _runLength(source, i, '`');
      final closer = source.indexOf('`' * ticks, i + ticks);
      if (closer == -1) {
        return -1;
      }
      i = closer + ticks;
      continue;
    }
    if (source.startsWith(marker, i)) {
      // A single-char marker must not match the first half of a double marker.
      if (marker.length == 1 && source.startsWith(char * 2, i)) {
        i += 2;
        continue;
      }
      // Empty spans (`**` immediately closing) are not emphasis.
      if (i == from) {
        return -1;
      }
      // A closer may not be preceded by whitespace.
      if (_isSpace(source[i - 1])) {
        i += marker.length;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

class _LinkMatch {
  const _LinkMatch(this.text, this.href, this.end);

  final String text;
  final String href;
  final int end;
}

/// Matches `[text](href)` at [start], allowing balanced brackets in the label.
_LinkMatch? _matchLink(String source, int start) {
  var depth = 0;
  var i = start;
  var labelEnd = -1;
  while (i < source.length) {
    final char = source[i];
    if (char == r'\') {
      i += 2;
      continue;
    }
    if (char == '[') {
      depth++;
    } else if (char == ']') {
      depth--;
      if (depth == 0) {
        labelEnd = i;
        break;
      }
    }
    i++;
  }
  if (labelEnd == -1 ||
      labelEnd + 1 >= source.length ||
      source[labelEnd + 1] != '(') {
    return null;
  }

  var parens = 0;
  var j = labelEnd + 1;
  var hrefEnd = -1;
  while (j < source.length) {
    final char = source[j];
    if (char == '(') {
      parens++;
    } else if (char == ')') {
      parens--;
      if (parens == 0) {
        hrefEnd = j;
        break;
      }
    } else if (char == '\n') {
      return null;
    }
    j++;
  }
  if (hrefEnd == -1) {
    return null;
  }

  final label = source.substring(start + 1, labelEnd);
  final href = source.substring(labelEnd + 2, hrefEnd);
  if (href.trim().isEmpty) {
    return null;
  }
  return _LinkMatch(label, href, hrefEnd + 1);
}

void _emit(List<MarkdownInline> out, String text, _InlineStyle style) {
  if (text.isEmpty) {
    return;
  }
  out.add(
    MarkdownInline(
      text,
      bold: style.bold,
      italic: style.italic,
      strikethrough: style.strikethrough,
      href: style.href,
    ),
  );
}

List<MarkdownInline> _mergeRuns(List<MarkdownInline> runs) {
  if (runs.length < 2) {
    return runs;
  }
  final merged = <MarkdownInline>[];
  for (final run in runs) {
    final previous = merged.isEmpty ? null : merged.last;
    if (previous != null &&
        previous.bold == run.bold &&
        previous.italic == run.italic &&
        previous.code == run.code &&
        previous.strikethrough == run.strikethrough &&
        previous.href == run.href) {
      merged[merged.length - 1] = MarkdownInline(
        previous.text + run.text,
        bold: run.bold,
        italic: run.italic,
        code: run.code,
        strikethrough: run.strikethrough,
        href: run.href,
      );
      continue;
    }
    merged.add(run);
  }
  return merged;
}

int _runLength(String source, int start, String char) {
  var count = 0;
  var i = start;
  while (i < source.length && source[i] == char) {
    count++;
    i++;
  }
  return count;
}

bool _isSpace(String char) => char == ' ' || char == '\t' || char == '\n';

bool _isAsciiPunctuation(String char) {
  if (char.isEmpty) return false;
  final code = char.codeUnitAt(0);
  return (code >= 0x21 && code <= 0x2F) || // ! " # $ % & ' ( ) * + , - . /
      (code >= 0x3A && code <= 0x40) || // : ; < = > ? @
      (code >= 0x5B && code <= 0x60) || // [ \ ] ^ _ `
      (code >= 0x7B && code <= 0x7E); // { | } ~
}

bool _isWordChar(String char) {
  final code = char.codeUnitAt(0);
  return (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      char == '_';
}

/// Whether [source] contains any markdown the renderer would style.
///
/// Lets callers keep a cheap plain-text path for the common case.
bool transcriptMarkdownLooksPlain(String? source) {
  final text = source ?? '';
  if (text.isEmpty) {
    return true;
  }
  final blocks = parseTranscriptMarkdown(text);
  if (blocks.length != 1) {
    return false;
  }
  final only = blocks.first;
  if (only is! MarkdownParagraph) {
    return false;
  }
  if (only.spans.length != 1) {
    return false;
  }
  final span = only.spans.first;
  return !span.bold &&
      !span.italic &&
      !span.code &&
      !span.strikethrough &&
      span.href == null &&
      span.text == text.trim();
}
