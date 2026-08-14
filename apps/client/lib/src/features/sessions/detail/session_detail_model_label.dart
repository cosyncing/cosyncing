part of 'session_detail_page.dart';

/// Deriving a short, human model name for the composer's model button.
///
/// The bar must never render a raw model id (`claude-opus-4-8`) — that is what
/// makes the composer read like a debug console.
///
/// The advertised [ModelOption.label] is the preferred source but is *not*
/// trusted: it is broker JSON (`label: json['label'] as String`), and real
/// brokers ship labels that already embed the id, e.g.
/// `Opus · claude-opus-4-8`. The pipeline is therefore sanitize the advertised
/// label ([_humanModelLabel]) → derive from the id ([_shortModelLabel]) →
/// generic.

/// Short, human family names keyed by a token found in a raw model id.
///
/// Insertion order is the match order, so the most specific token wins.
const _modelFamilyLabels = <String, String>{
  'opus': 'Opus',
  'sonnet': 'Sonnet',
  'haiku': 'Haiku',
  'gpt': 'GPT',
  'gemini': 'Gemini',
  'grok': 'Grok',
  'llama': 'Llama',
  'mistral': 'Mistral',
  'deepseek': 'DeepSeek',
  'qwen': 'Qwen',
  'kimi': 'Kimi',
  'glm': 'GLM',
};

/// Vendor/prefix tokens that never make a useful button label on their own.
const _modelVendorTokens = <String>{
  'anthropic',
  'openai',
  'google',
  'models',
  'claude',
  'chat',
};

/// Separator glyphs a broker may use to join a label to an embedded id.
const _labelSeparators = r'·•\-–—/|,:';

/// Sanitizes a broker-advertised model label into something human.
///
/// Returns null when nothing legible survives, so the caller can fall through
/// to [_shortModelLabel] and then to a generic label.
///
/// Genuinely human labels are returned untouched — the id is only excised when
/// it is actually present, so `Opus 4.8` and `GPT-5.4` survive intact while
/// `Opus · claude-opus-4-8` collapses to `Opus` and a bare `claude-opus-4-8`
/// drops through entirely.
String? _humanModelLabel(String? advertisedLabel, String? rawModelID) {
  var candidate = advertisedLabel?.trim() ?? '';
  if (candidate.isEmpty) {
    return null;
  }
  final id = rawModelID?.trim() ?? '';
  if (id.isNotEmpty) {
    final stripped = candidate.replaceAll(
      RegExp(RegExp.escape(id), caseSensitive: false),
      '',
    );
    if (stripped != candidate) {
      final tidied = _tidyLabelRemnant(stripped);
      // Only adopt the stripped form when something human survived. A label
      // that is *nothing but* the id keeps its original text and is judged by
      // [_looksLikeModelId] below, so a legible product name that happens to
      // equal the id (`GPT-5.4`) is preserved while `claude-opus-4-8` is not.
      if (tidied.isNotEmpty) {
        candidate = tidied;
      }
    }
  }
  if (_looksLikeModelId(candidate)) {
    return null;
  }
  return candidate;
}

/// Cleans up the punctuation an excised id leaves behind, e.g. the orphaned
/// `·` in `Opus · ` or the empty parens in `Opus ()`.
String _tidyLabelRemnant(String value) => value
    .replaceAll(RegExp(r'\(\s*\)|\[\s*\]|\{\s*\}'), ' ')
    .replaceAll(RegExp(r'\s+'), ' ')
    .replaceAll(RegExp('(\\s*[$_labelSeparators]\\s*){2,}'), ' · ')
    .replaceAll(RegExp('^[\\s$_labelSeparators()\\[\\]{}]+'), '')
    .replaceAll(RegExp('[\\s$_labelSeparators()\\[\\]{}]+\$'), '')
    .trim();

/// Whether [value] reads as a model id rather than a human name.
///
/// The tell is a single unspaced run of three or more separator-delimited
/// segments carrying a digit — `claude-opus-4-8`, `gpt-4o-mini`. Two-segment
/// names like `GPT-5.4` and anything containing a space (`Opus 4.8`,
/// `Claude Opus`) are left alone, so this never eats a real product name.
bool _looksLikeModelId(String value) {
  // Judge a canonical form. [_tidyLabelRemnant] rewrites an excised id's
  // orphaned punctuation as a *space-padded* separator, so a mangled remnant
  // like `claude · 4-8` used to read as human purely because tidying inserted
  // spaces — and shipped to the composer verbatim. Collapse padded separators
  // back to a bare one before deciding.
  final normalized = value
      .replaceAll(RegExp('\\s*[$_labelSeparators]\\s*'), '-')
      .trim();
  if (normalized.contains(RegExp(r'\s'))) {
    return false;
  }
  if (!normalized.contains(RegExp('[A-Za-z]')) ||
      !normalized.contains(RegExp('[0-9]'))) {
    return false;
  }
  final segments = normalized
      .split(RegExp('[${_labelSeparators}_]'))
      .where((segment) => segment.isNotEmpty)
      .length;
  return segments >= 3;
}

/// Derives a short, human model name from a raw model id.
///
/// Used only when the session's model is absent from the broker's advertised
/// options, where there is no `label` to read. `claude-opus-4-8` becomes
/// `Opus`; an unrecognised id falls back to its first meaningful token so the
/// bar still never renders the dashed id verbatim. Returns null when nothing
/// legible can be derived, letting the caller show a generic `Model`.
String? _shortModelLabel(String? rawModelID) {
  final raw = rawModelID?.trim().toLowerCase() ?? '';
  if (raw.isEmpty) {
    return null;
  }
  for (final entry in _modelFamilyLabels.entries) {
    if (raw.contains(entry.key)) {
      return entry.value;
    }
  }
  for (final token in raw.split(RegExp('[^a-z0-9]+'))) {
    if (token.isEmpty ||
        _modelVendorTokens.contains(token) ||
        !RegExp('[a-z]').hasMatch(token)) {
      continue;
    }
    return token[0].toUpperCase() + token.substring(1);
  }
  return null;
}

/// Tooltip carrying everything the bar deliberately does not show: the full
/// model id and the reasoning effort.
String _modelTooltip(
  AppLocalizations l10n,
  String? rawModelID,
  String? effort,
) {
  final id = rawModelID?.trim() ?? '';
  if (id.isEmpty) {
    return l10n.sessionComposerModelGenericLabel;
  }
  return effort == null
      ? l10n.sessionComposerModelTooltipWithId(id)
      : l10n.sessionComposerModelTooltipWithIdAndEffort(id, effort);
}
