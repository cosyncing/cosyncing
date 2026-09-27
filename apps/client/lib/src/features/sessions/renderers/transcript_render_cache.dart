/// Parsed markdown and highlighted code for transcript rows, kept by content.
///
/// A row's text is its revision: the same text parses to the same blocks and
/// highlights to the same runs, so both are kept by the text itself and never
/// go stale. A row that scrolls back into view, or is rebuilt from scratch
/// when the list re-centres, finds its blocks here instead of parsing again.
///
/// Both caches are bounded by what their entries retain, least recently used
/// first out: the code units of every string an entry keeps (its text, and
/// for code its language label too; the parsed form is proportional to the
/// text) plus [TranscriptRenderCache.entryUnits] for the entry itself, so
/// many small entries are bounded as surely as a few large ones. An entry
/// too large to be worth keeping (an eighth of the bound or more) is parsed
/// and returned without being kept, so one oversized row cannot empty the
/// cache for every other; an empty text is never kept, as there is nothing
/// to save by keeping it.
library;

import 'dart:collection';

import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:flutter/foundation.dart';

/// A least-recently-used map bounded by a weight per entry: the units the
/// caller gives it plus [TranscriptRenderCache.entryUnits], so no entry is
/// free.
final class _WeightedLru<K, V> {
  _WeightedLru(this.budget);

  final int budget;
  final LinkedHashMap<K, ({V value, int weight})> _entries = LinkedHashMap();
  int _weight = 0;

  int get weight => _weight;
  int get length => _entries.length;

  V? lookup(K key) {
    final entry = _entries.remove(key);
    if (entry == null) return null;
    _entries[key] = entry;
    return entry.value;
  }

  /// Keeps [value] for [key], which with it retains [units] code units.
  void insert(K key, V value, int units) {
    final weight = units + TranscriptRenderCache.entryUnits;
    if (weight * 8 >= budget) return;
    final previous = _entries.remove(key);
    if (previous != null) _weight -= previous.weight;
    _entries[key] = (value: value, weight: weight);
    _weight += weight;
    while (_weight > budget && _entries.isNotEmpty) {
      final oldest = _entries.keys.first;
      _weight -= _entries.remove(oldest)!.weight;
    }
  }

  void clear() {
    _entries.clear();
    _weight = 0;
  }
}

/// See the library documentation.
final class TranscriptRenderCache {
  /// Creates caches retaining at most [markdownBudget] and [codeBudget] code
  /// units (see the library documentation).
  TranscriptRenderCache({
    this.markdownBudget = 1 << 20,
    this.codeBudget = 1 << 19,
  }) : _markdown = _WeightedLru(markdownBudget),
       _code = _WeightedLru(codeBudget);

  /// The most markdown source, in code units with each entry's own cost,
  /// kept parsed.
  final int markdownBudget;

  /// The most code and language labels, in code units with each entry's own
  /// cost, kept highlighted.
  final int codeBudget;

  /// What one entry costs beyond the strings it keeps, in code units: an
  /// estimate of the map entry, its key and the list of blocks or runs, so
  /// that an entry with little or no text still counts against the budget.
  static const int entryUnits = 64;

  final _WeightedLru<String, List<MarkdownBlock>> _markdown;
  final _WeightedLru<(String, String), List<TranscriptCodeToken>> _code;

  /// [source] parsed (see [parseTranscriptMarkdown]), and whether it came
  /// from the cache. With [keep] false a miss is not kept: text that is
  /// still changing (a reply streaming in) would only push out text that is
  /// not.
  ({List<MarkdownBlock> blocks, bool hit}) markdown(
    String source, {
    bool keep = true,
  }) {
    final cached = _markdown.lookup(source);
    if (cached != null) return (blocks: cached, hit: true);
    final blocks = List<MarkdownBlock>.unmodifiable(
      parseTranscriptMarkdown(source),
    );
    if (keep && source.isNotEmpty) {
      _markdown.insert(source, blocks, source.length);
    }
    return (blocks: blocks, hit: false);
  }

  /// [source] highlighted as [language] (see [highlightTranscriptCode]), and
  /// whether it came from the cache. With [keep] false a miss is not kept.
  ({List<TranscriptCodeToken> tokens, bool hit}) code(
    String source, {
    required String language,
    bool keep = true,
  }) {
    final key = (language, source);
    final cached = _code.lookup(key);
    if (cached != null) return (tokens: cached, hit: true);
    final tokens = List<TranscriptCodeToken>.unmodifiable(
      highlightTranscriptCode(source, language: language),
    );
    // The key keeps the label as well as the code.
    if (keep && source.isNotEmpty) {
      _code.insert(key, tokens, language.length + source.length);
    }
    return (tokens: tokens, hit: false);
  }

  /// Code units the markdown cache retains: its sources, and [entryUnits]
  /// for each. Never more than [markdownBudget].
  int get markdownUnits => _markdown.weight;

  /// Markdown sources held.
  int get markdownEntries => _markdown.length;

  /// Code units the code cache retains: its code and language labels, and
  /// [entryUnits] for each entry. Never more than [codeBudget].
  int get codeUnits => _code.weight;

  /// Code blocks held.
  int get codeEntries => _code.length;

  /// Forgets everything.
  void clear() {
    _markdown.clear();
    _code.clear();
  }
}

/// The cache transcript rows share.
final TranscriptRenderCache transcriptRenderCache = TranscriptRenderCache();

/// Whether [a] and [b] render the same (the parsed blocks carry no identity
/// of their own).
bool sameTranscriptMarkdownBlock(MarkdownBlock a, MarkdownBlock b) {
  bool sameRuns(List<MarkdownInline> x, List<MarkdownInline> y) =>
      listEquals(x, y);
  bool sameItems(List<List<MarkdownInline>> x, List<List<MarkdownInline>> y) {
    if (x.length != y.length) return false;
    for (var i = 0; i < x.length; i++) {
      if (!sameRuns(x[i], y[i])) return false;
    }
    return true;
  }

  bool sameRows(
    List<List<List<MarkdownInline>>> x,
    List<List<List<MarkdownInline>>> y,
  ) {
    if (x.length != y.length) return false;
    for (var i = 0; i < x.length; i++) {
      if (!sameItems(x[i], y[i])) return false;
    }
    return true;
  }

  if (identical(a, b)) return true;
  return switch ((a, b)) {
    (final MarkdownParagraph x, final MarkdownParagraph y) => sameRuns(
      x.spans,
      y.spans,
    ),
    (final MarkdownHeading x, final MarkdownHeading y) =>
      x.level == y.level && sameRuns(x.spans, y.spans),
    (final MarkdownBulletList x, final MarkdownBulletList y) => sameItems(
      x.items,
      y.items,
    ),
    (final MarkdownOrderedList x, final MarkdownOrderedList y) =>
      x.start == y.start && sameItems(x.items, y.items),
    (final MarkdownCodeBlock x, final MarkdownCodeBlock y) =>
      x.code == y.code && x.language == y.language && x.closed == y.closed,
    (final MarkdownBlockquote x, final MarkdownBlockquote y) => sameRuns(
      x.spans,
      y.spans,
    ),
    (MarkdownThematicBreak(), MarkdownThematicBreak()) => true,
    (final MarkdownTable x, final MarkdownTable y) =>
      sameItems(x.header, y.header) &&
          listEquals(x.alignments, y.alignments) &&
          sameRows(x.rows, y.rows),
    _ => false,
  };
}
