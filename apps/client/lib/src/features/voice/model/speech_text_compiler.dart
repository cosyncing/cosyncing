import 'dart:convert';

import 'package:cosyncing_client/src/platform/speech/speech_utterance.dart';

/// Deterministic, pure-Dart compiler that turns a final `model-output` frame's
/// `text` into bounded plain-text [SpeechUtterance] chunks for a synthesizer.
///
/// The synthesizer never receives raw Markdown, raw JSON, tables, terminal
/// output, or full URLs. The compiler:
/// - speaks normal prose, headings, and list items in document order;
/// - removes Markdown decoration;
/// - omits fenced code, raw JSON, and table blocks, replacing each with a
///   short documented marker (`Code block omitted`, `Table omitted`);
/// - shortens links to useful labels and bare URLs to host names;
/// - emits each chunk as a clean cancellation boundary;
/// - never adds content that was not in the source except the documented
///   omission markers.
///
/// The compiler is stateless and deterministic: the same input always yields
/// the same chunks. It does no I/O and has no Flutter or plugin dependency.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Speakable-text policy").
class SpeechTextCompiler {
  /// Creates a stateless compiler.
  const SpeechTextCompiler();

  /// The documented marker spoken in place of an omitted code/JSON block.
  static const String codeBlockOmitted = 'Code block omitted';

  /// The documented marker spoken in place of an omitted table.
  static const String tableOmitted = 'Table omitted';

  /// Maximum number of characters in a single utterance chunk.
  static const int maxChunkLength = 200;

  /// Compiles [source] (a final frame's `text`) into speakable utterances.
  List<SpeechUtterance> compile(String source) {
    if (source.isEmpty) {
      return const <SpeechUtterance>[];
    }
    final normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    final lines = normalized.split('\n');
    final segments = _scan(lines);
    final out = <SpeechUtterance>[];
    for (final segment in segments) {
      if (segment.kind == _SegmentKind.omission) {
        if (segment.text.isNotEmpty) {
          out.add(
            SpeechUtterance(
              segment.text,
              kind: SpeechUtteranceKind.omissionMarker,
            ),
          );
        }
        continue;
      }
      final cleaned = _cleanInline(segment.text);
      for (final chunk in _boundSentences(cleaned)) {
        final trimmed = chunk.trim();
        if (trimmed.isNotEmpty) {
          out.add(SpeechUtterance(trimmed));
        }
      }
    }
    return out;
  }

  List<_Segment> _scan(List<String> lines) {
    final segments = <_Segment>[];
    var i = 0;
    while (i < lines.length) {
      final line = lines[i];
      if (_isBlank(line)) {
        i++;
        continue;
      }
      if (_isFence(line)) {
        i = _consumeFence(lines, i);
        segments.add(_Segment.omission(codeBlockOmitted));
        continue;
      }
      if (_isTableStart(lines, i)) {
        i = _consumeTable(lines, i);
        segments.add(_Segment.omission(tableOmitted));
        continue;
      }
      if (_isIndentedCodeStart(lines, i)) {
        i = _consumeIndentedCode(lines, i);
        segments.add(_Segment.omission(codeBlockOmitted));
        continue;
      }
      if (_looksLikeJsonBlockStart(line)) {
        final result = _tryConsumeJsonBlock(lines, i);
        if (result.isJson) {
          i = result.nextIndex;
          segments.add(_Segment.omission(codeBlockOmitted));
          continue;
        }
        // Not valid JSON: speak the accumulated lines as prose so nothing
        // is silently dropped.
        final blockLines = lines.sublist(i, result.nextIndex);
        i = result.nextIndex;
        segments.add(
          _Segment.prose(blockLines.map((l) => l.trim()).join(' ')),
        );
        continue;
      }
      final heading = _headingText(line);
      if (heading != null) {
        segments.add(_Segment.prose(heading));
        i++;
        continue;
      }
      final item = _listItemText(line);
      if (item != null) {
        final buffer = StringBuffer(item);
        i++;
        while (i < lines.length && _isListItemContinuation(lines[i])) {
          buffer
            ..write(' ')
            ..write(lines[i].trim());
          i++;
        }
        segments.add(_Segment.prose(buffer.toString()));
        continue;
      }
      if (_isBlockquote(line)) {
        final buffer = StringBuffer();
        while (i < lines.length && _isBlockquote(lines[i])) {
          final text = _blockquoteText(lines[i]);
          if (text.isNotEmpty) {
            if (buffer.isNotEmpty) {
              buffer.write(' ');
            }
            buffer.write(text);
          }
          i++;
        }
        segments.add(_Segment.prose(buffer.toString()));
        continue;
      }
      if (_isHorizontalRule(line)) {
        i++;
        continue;
      }
      // Plain prose paragraph: accumulate consecutive non-blank, non-special
      // lines.
      final buffer = StringBuffer();
      while (i < lines.length && !_isBlank(lines[i]) && !_isSpecial(lines, i)) {
        if (buffer.isNotEmpty) {
          buffer.write(' ');
        }
        buffer.write(lines[i].trim());
        i++;
      }
      segments.add(_Segment.prose(buffer.toString()));
    }
    return segments;
  }

  int _consumeFence(List<String> lines, int start) {
    // Skip the opening fence line, then consume until the closing fence (or
    // end of input). An unclosed fence omits the rest of the document.
    var i = start + 1;
    while (i < lines.length && !_isFence(lines[i])) {
      i++;
    }
    if (i < lines.length) {
      i++;
    }
    return i;
  }

  int _consumeTable(List<String> lines, int start) {
    var i = start;
    while (i < lines.length && _looksLikeTableRow(lines[i])) {
      i++;
    }
    return i;
  }

  int _consumeIndentedCode(List<String> lines, int start) {
    var i = start;
    while (i < lines.length) {
      if (_isBlank(lines[i])) {
        if (i + 1 < lines.length && _isIndented(lines[i + 1])) {
          i++;
          continue;
        }
        break;
      }
      if (_isIndented(lines[i])) {
        i++;
        continue;
      }
      break;
    }
    return i;
  }

  // -- Line classification -------------------------------------------------

  bool _isBlank(String line) => line.trim().isEmpty;

  bool _isFence(String line) => _fenceRegExp.hasMatch(line);

  bool _looksLikeTableRow(String line) =>
      line.contains('|') && line.trim().isNotEmpty;

  bool _isTableSeparator(String line) => _tableSeparatorRegExp.hasMatch(line);

  bool _isTableStart(List<String> lines, int i) =>
      i + 1 < lines.length &&
      _looksLikeTableRow(lines[i]) &&
      _isTableSeparator(lines[i + 1]);

  bool _isIndented(String line) => _indentedRegExp.hasMatch(line);

  bool _isIndentedCodeStart(List<String> lines, int i) {
    if (!_isIndented(lines[i])) {
      return false;
    }
    // A code block starts only after a blank line or at the document start.
    if (i > 0 && !_isBlank(lines[i - 1])) {
      return false;
    }
    // Conservative: never treat indented text as code when it continues a list
    // item (would wrongly omit list content).
    if (_previousNonBlankIsListItem(lines, i)) {
      return false;
    }
    return true;
  }

  bool _previousNonBlankIsListItem(List<String> lines, int i) {
    var j = i - 1;
    while (j >= 0 && _isBlank(lines[j])) {
      j--;
    }
    return j >= 0 && _listItemText(lines[j]) != null;
  }

  bool _looksLikeJsonBlockStart(String line) {
    final trimmed = line.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }

  /// Tries to consume a raw (unfenced) JSON object or array block starting
  /// at [start].
  ///
  /// Accumulates lines while tracking structural depth with a string-aware
  /// counter (so braces/brackets inside string literals do not affect
  /// depth). While the structure is still open (depth > 0) blank lines are
  /// consumed as valid JSON whitespace; once depth returns to zero a blank
  /// line terminates the block so following prose is never swallowed. The
  /// block is then validated with [jsonDecode]; a [Map] or [List] is
  /// omitted as a code block. Anything else - a scalar, malformed JSON, or
  /// a block that never closes - is reported as not JSON so the caller
  /// speaks it as conservative prose. [jsonDecode] is the source of truth;
  /// the depth counter is only a heuristic for when to stop accumulating.
  ({bool isJson, int nextIndex}) _tryConsumeJsonBlock(
    List<String> lines,
    int start,
  ) {
    final block = <String>[];
    var depth = 0;
    var inString = false;
    var escape = false;
    var i = start;
    while (i < lines.length) {
      final line = lines[i];
      if (_isBlank(line)) {
        if (depth <= 0) {
          // Already closed: the blank line belongs to following prose.
          break;
        }
        // Still structurally open: blank lines are valid JSON whitespace.
        block.add(line);
        i++;
        continue;
      }
      block.add(line);
      for (final rune in line.runes) {
        final ch = String.fromCharCode(rune);
        if (escape) {
          escape = false;
          continue;
        }
        if (inString) {
          if (ch == '"') {
            inString = false;
          } else if (ch == r'\') {
            escape = true;
          }
          continue;
        }
        if (ch == '"') {
          inString = true;
        } else if (ch == '{' || ch == '[') {
          depth++;
        } else if (ch == '}' || ch == ']') {
          depth--;
        }
      }
      i++;
      if (depth <= 0) {
        break;
      }
    }
    if (depth != 0) {
      return (isJson: false, nextIndex: i);
    }
    try {
      final decoded = jsonDecode(block.join('\n'));
      if (decoded is Map || decoded is List) {
        return (isJson: true, nextIndex: i);
      }
      return (isJson: false, nextIndex: i);
    } on FormatException {
      return (isJson: false, nextIndex: i);
    }
  }

  String? _headingText(String line) =>
      _headingRegExp.firstMatch(line)?.group(1)?.trim();

  String? _listItemText(String line) =>
      _listItemRegExp.firstMatch(line)?.group(2)?.trim();

  bool _isBlockquote(String line) => _blockquoteRegExp.hasMatch(line);

  String _blockquoteText(String line) =>
      _blockquoteRegExp.firstMatch(line)?.group(1)?.trim() ?? '';

  bool _isHorizontalRule(String line) => _horizontalRuleRegExp.hasMatch(line);

  bool _isListItemContinuation(String line) {
    if (_isBlank(line) || _isFence(line)) {
      return false;
    }
    if (_headingText(line) != null ||
        _listItemText(line) != null ||
        _isBlockquote(line) ||
        _isHorizontalRule(line)) {
      return false;
    }
    return _isIndented(line);
  }

  /// Whether the line begins a block that should break a prose paragraph.
  bool _isSpecial(List<String> lines, int i) {
    return _isFence(lines[i]) ||
        _isTableStart(lines, i) ||
        _looksLikeJsonBlockStart(lines[i]) ||
        _headingText(lines[i]) != null ||
        _listItemText(lines[i]) != null ||
        _isBlockquote(lines[i]) ||
        _isHorizontalRule(lines[i]);
  }

  // -- Inline cleaning -----------------------------------------------------

  String _cleanInline(String text) {
    var s = text;
    // Images: keep alt text (a description), drop the URL. No alt -> drop.
    s = s.replaceAllMapped(_imageRegExp, (m) => m[1] ?? '');
    // Inline links: keep the label, or shorten a label-less link to its host.
    s = s.replaceAllMapped(_linkRegExp, (m) {
      final label = m[1] ?? '';
      if (label.isNotEmpty) {
        return label;
      }
      return _hostOf(m[2] ?? '');
    });
    // Reference links: keep the label.
    s = s.replaceAllMapped(_referenceLinkRegExp, (m) => m[1] ?? '');
    // Bare URLs: shorten to the host name.
    s = s.replaceAllMapped(_bareUrlRegExp, (m) => _hostOf(m[0] ?? ''));
    // Inline code: strip the backticks, keep the inner text.
    s = s.replaceAllMapped(_inlineCodeRegExp, (m) => m[1] ?? '');
    // Emphasis: strip markers, keep text.
    s = _stripEmphasis(s);
    // HTML tags: remove, keep surrounding text.
    s = s.replaceAll(_htmlTagRegExp, '');
    // Common HTML entities.
    s = _decodeEntities(s);
    // Collapse whitespace.
    s = s.replaceAll(_whitespaceRegExp, ' ').trim();
    return s;
  }

  String _stripEmphasis(String s) {
    var result = s;
    result = result.replaceAllMapped(_tripleEmphasisRegExp, (m) => m[1] ?? '');
    result = result.replaceAllMapped(_boldStarRegExp, (m) => m[1] ?? '');
    result = result.replaceAllMapped(_italicStarRegExp, (m) => m[1] ?? '');
    result = result.replaceAllMapped(_boldUnderscoreRegExp, (m) => m[1] ?? '');
    result = result.replaceAllMapped(
      _italicUnderscoreRegExp,
      (m) => '${m[1] ?? ''}${m[2] ?? ''}',
    );
    result = result.replaceAllMapped(_strikethroughRegExp, (m) => m[1] ?? '');
    return result;
  }

  String _hostOf(String url) {
    final cleaned = url.replaceAll(_trailingPunctRegExp, '');
    final host = Uri.tryParse(cleaned)?.host;
    if (host != null && host.isNotEmpty) {
      return host;
    }
    return cleaned;
  }

  String _decodeEntities(String s) {
    return s
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&apos;', "'")
        .replaceAll('&nbsp;', ' ');
  }

  // -- Chunking ------------------------------------------------------------

  List<String> _boundSentences(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) {
      return const <String>[];
    }
    final out = <String>[];
    for (final sentence in _splitSentences(trimmed)) {
      out.addAll(_boundChunk(sentence));
    }
    return out;
  }

  List<String> _splitSentences(String text) {
    final raw = <String>[];
    var start = 0;
    for (var i = 0; i < text.length; i++) {
      final ch = text[i];
      if (ch != '.' && ch != '!' && ch != '?') {
        continue;
      }
      // Don't split inside a domain (openai.com) or decimal (3.14): a
      // sentence-ender must be followed by a non-alphanumeric boundary.
      if (i + 1 < text.length && _isAlnum(text[i + 1])) {
        continue;
      }
      var end = i + 1;
      while (end < text.length && _isClosingPunct(text[end])) {
        end++;
      }
      final chunk = text.substring(start, end).trim();
      if (chunk.isNotEmpty) {
        raw.add(chunk);
      }
      start = end;
      while (start < text.length && text[start] == ' ') {
        start++;
      }
    }
    final tail = text.substring(start).trim();
    if (tail.isNotEmpty) {
      raw.add(tail);
    }
    return raw;
  }

  bool _isAlnum(String c) {
    final unit = c.codeUnitAt(0);
    return (unit >= 48 && unit <= 57) || // 0-9
        (unit >= 65 && unit <= 90) || // A-Z
        (unit >= 97 && unit <= 122); // a-z
  }

  List<String> _boundChunk(String s) {
    if (s.length <= maxChunkLength) {
      return [s];
    }
    final pieces = <String>[];
    var buffer = StringBuffer();
    var i = 0;
    while (i < s.length) {
      var j = i;
      while (j < s.length) {
        final ch = s[j];
        if ((ch == ',' || ch == ';' || ch == ':') &&
            j + 1 < s.length &&
            s[j + 1] == ' ') {
          break;
        }
        j++;
      }
      var segEnd = j;
      if (j < s.length && (s[j] == ',' || s[j] == ';' || s[j] == ':')) {
        segEnd = j + 1;
      }
      final piece = s.substring(i, segEnd);
      if (buffer.isEmpty) {
        buffer.write(piece);
      } else if (buffer.length + piece.length <= maxChunkLength) {
        buffer.write(piece);
      } else {
        pieces.add(buffer.toString().trim());
        buffer = StringBuffer(piece.trim());
      }
      i = segEnd;
      if (i < s.length && s[i] == ' ') {
        i++;
      }
    }
    final last = buffer.toString().trim();
    if (last.isNotEmpty) {
      pieces.add(last);
    }
    return pieces
        .expand((c) => c.length <= maxChunkLength ? [c] : _hardSplit(c))
        .toList();
  }

  List<String> _hardSplit(String s) {
    final out = <String>[];
    var start = 0;
    while (start < s.length) {
      if (s.length - start <= maxChunkLength) {
        final chunk = s.substring(start).trim();
        if (chunk.isNotEmpty) {
          out.add(chunk);
        }
        break;
      }
      final end = start + maxChunkLength;
      final space = s.lastIndexOf(' ', end);
      final cut = space > start ? space : end;
      final chunk = s.substring(start, cut).trim();
      if (chunk.isNotEmpty) {
        out.add(chunk);
      }
      start = cut;
      while (start < s.length && s[start] == ' ') {
        start++;
      }
    }
    return out;
  }

  bool _isClosingPunct(String c) =>
      c == '"' ||
      c == "'" ||
      c == ')' ||
      c == ']' ||
      c == '!' ||
      c == '?' ||
      c == '\u201d' ||
      c == '\u2019';
}

class _Segment {
  _Segment.prose(this.text) : kind = _SegmentKind.prose;
  _Segment.omission(this.text) : kind = _SegmentKind.omission;

  final _SegmentKind kind;
  final String text;
}

enum _SegmentKind { prose, omission }

final RegExp _fenceRegExp = RegExp(r'^\s{0,3}(?:```|~~~)');
final RegExp _tableSeparatorRegExp = RegExp(
  r'^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$',
);
final RegExp _indentedRegExp = RegExp(r'^( {4,}|\t)');
final RegExp _headingRegExp = RegExp(r'^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$');
final RegExp _listItemRegExp = RegExp(r'^\s{0,3}([-*+]|\d+\.)\s+(.*)$');
final RegExp _blockquoteRegExp = RegExp(r'^\s{0,3}>\s?(.*)$');
final RegExp _horizontalRuleRegExp = RegExp(r'^\s{0,3}([-*_])(\s*\1){2,}\s*$');
final RegExp _imageRegExp = RegExp(r'!\[([^\]]*)\]\(([^)]*)\)');
final RegExp _linkRegExp = RegExp(r'\[([^\]]*)\]\(([^)]*)\)');
final RegExp _referenceLinkRegExp = RegExp(r'\[([^\]]+)\]\[([^\]]*)\]');
final RegExp _bareUrlRegExp = RegExp(r'https?://[^\s)\]]+');
final RegExp _inlineCodeRegExp = RegExp('`([^`]+)`');
final RegExp _tripleEmphasisRegExp = RegExp(
  r'\*\*\*([^\s*](?:[^*]*[^\s*])?)\*\*\*',
);
final RegExp _boldStarRegExp = RegExp(r'\*\*([^\s*](?:[^*]*[^\s*])?)\*\*');
final RegExp _italicStarRegExp = RegExp(r'\*([^\s*](?:[^*]*[^\s*])?)\*');
final RegExp _boldUnderscoreRegExp = RegExp(r'__([^\s_](?:[^_]*[^\s_])?)__');
final RegExp _italicUnderscoreRegExp = RegExp(
  r'(^|[\s(\[])_([^\s_](?:[^_]*[^\s_])?)_(?=$|[\s).,!?:;\]])',
);
final RegExp _strikethroughRegExp = RegExp('~~([^~]+)~~');
final RegExp _htmlTagRegExp = RegExp('</?[a-zA-Z][^>]*>');
final RegExp _whitespaceRegExp = RegExp(r'\s+');
final RegExp _trailingPunctRegExp = RegExp(r'[.,;:!?]+$');
