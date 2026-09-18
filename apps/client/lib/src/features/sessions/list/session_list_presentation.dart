/// Title resolution for session surfaces that render before the broker's
/// authoritative `SessionInfo` arrives.
///
/// Every pre-authoritative title source in the client — the opened-sessions
/// working set, its persisted snapshot, the bounded N3 roster snapshot — writes
/// the session id into its own title slot when it has nothing better. That
/// placeholder is fine to *store* (it is stable, locale-free identity) and
/// wrong to *show*: a native id is a fingerprint the user cannot recognise, and
/// flashing it where a name belongs is the U3 defect.
///
/// So display code asks this for a title it actually knows, and substitutes a
/// localized neutral label when the answer is null. Titles are display only;
/// routing, grouping and control decisions stay on `tool`/`sessionId`.
library;

import 'package:broker_contract/broker_contract.dart';

/// Returns the first genuinely known human title among [candidates], or null.
///
/// A candidate is skipped when it is null, blank, or equal to [sessionId] —
/// the last because that is precisely the placeholder every unresolved source
/// writes. The one false negative is a session a user really did name after its
/// own id; it shows the neutral label until the authoritative frame lands,
/// which is strictly better than showing a fingerprint. Authoritative titles do
/// not come through here: callers take `SessionInfo.title` first, so a broker
/// that genuinely reports the id as the title still renders it.
String? knownSessionTitle(
  Iterable<String?> candidates, {
  required String sessionId,
}) {
  for (final candidate in candidates) {
    final trimmed = candidate?.trim();
    if (trimmed == null || trimmed.isEmpty) continue;
    if (trimmed == sessionId.trim()) continue;
    return trimmed;
  }
  return null;
}

/// Compact trustworthy model text for roster metadata.
///
/// Raw provider ids never pass through as a fallback. When an adapter has not
/// authored a label, a compact label is derived only for a known model family;
/// an unknown id is omitted instead of turning the roster into a debug console.
String? sessionModelLabel(SessionInfo session) {
  final currentRaw = _trimmedModelValue(session.currentModel?.modelID);
  final legacyRaw = _trimmedModelValue(session.model);
  final authored = _humanModelLabel(session.currentModel?.label, currentRaw);
  if (authored != null) return authored;
  if (currentRaw != null && legacyRaw != currentRaw) {
    final legacy = _humanModelLabel(legacyRaw, currentRaw);
    if (legacy != null) return legacy;
  }
  return _derivedModelLabel(currentRaw ?? legacyRaw);
}

const _modelFamilies = <String, String>{
  'opus': 'Opus',
  'sonnet': 'Sonnet',
  'haiku': 'Haiku',
  'fable': 'Fable',
  'gpt': 'GPT',
  'gemini': 'Gemini',
  'grok': 'Grok',
  'llama': 'Llama',
  'mistral': 'Mistral',
  'minimax': 'MiniMax',
  'deepseek': 'DeepSeek',
  'qwen': 'Qwen',
  'glm': 'GLM',
  'longcat': 'LongCat',
};

String? _humanModelLabel(String? value, String? raw) {
  var candidate = value?.trim() ?? '';
  if (candidate.isEmpty) return null;
  if (raw != null && raw.isNotEmpty) {
    candidate = candidate
        .replaceAll(RegExp(RegExp.escape(raw), caseSensitive: false), '')
        .replaceAll(RegExp(r'^[\s·•|,:/—–-]+|[\s·•|,:/—–-]+$'), '')
        .trim();
    if (candidate.isEmpty) return null;
  }
  if (_looksLikeRawModelId(candidate)) return null;
  return candidate;
}

bool _looksLikeRawModelId(String value) {
  if (value.contains(' ')) return false;
  // A provider-qualified value is a raw id whatever else it looks like: no
  // human label carries `/` or `:`. Without this, a digit-free id such as
  // `kimi-code/kimi-for-coding` failed the segments+letter+digit test and was
  // passed through verbatim as if it were a name.
  if (value.contains('/') || value.contains(':')) return true;
  final parts = value
      // A decimal point belongs inside a human version (`GPT-5.4`). The
      // composer uses the same boundary: only product separators split an id.
      .split(RegExp('[-_/:]+'))
      .where((part) => part.isNotEmpty);
  return parts.length >= 3 &&
      value.contains(RegExp('[A-Za-z]')) &&
      value.contains(RegExp('[0-9]'));
}

String? _derivedModelLabel(String? modelId) {
  final raw = modelId?.trim().toLowerCase() ?? '';
  if (raw.isEmpty) return null;

  // Provider-qualified identities are safe to inspect only after discarding
  // the provider. The complete identity remains available in the tooltip.
  final leaf = raw.split(RegExp('[/:]')).last;
  final openAiReasoning = RegExp(r'^o(\d+(?:\.\d+)?)(-mini)?$').firstMatch(
    leaf,
  );
  if (openAiReasoning != null) {
    return 'o${openAiReasoning.group(1)}${openAiReasoning.group(2) ?? ''}';
  }
  for (final entry in _modelFamilies.entries) {
    final familyMatch = RegExp(
      '(?:^|[-_.])(${RegExp.escape(entry.key)})(?=\$|[-_.0-9])',
    ).firstMatch(leaf);
    if (familyMatch == null) continue;
    final familyStart = familyMatch.end - entry.key.length;
    final familyEnd = familyStart + entry.key.length;
    final matches =
        RegExp(
          r'\d+(?:\.\d+)?[a-z]?',
        ).allMatches(leaf).where((match) {
          final value = match.group(0)!;
          // Release dates and context sizes are technical suffixes, not
          // versions.
          final suffix = leaf.substring(match.end);
          return value.replaceAll(RegExp('[^0-9]'), '').length < 6 &&
              !value.endsWith('b') &&
              !value.endsWith('k') &&
              !suffix.startsWith(RegExp('[bk]'));
        }).toList();
    final before = matches.where((match) => match.end <= familyStart).toList();
    final after = matches.where((match) => match.start >= familyEnd).toList();
    final useAfter =
        before.isEmpty ||
        (after.isNotEmpty &&
            after.first.start - familyEnd <= familyStart - before.last.end);
    final nearest = useAfter
        ? after.take(2).toList()
        : before.reversed.take(2).toList().reversed.toList();
    if (nearest.isEmpty) return entry.value;
    final first = nearest.first.group(0)!;
    final version = first.contains('.') || nearest.length == 1
        ? first
        : '$first.${nearest[1].group(0)!}';
    if (entry.key == 'minimax' && leaf.contains('m$version')) {
      return '${entry.value} M$version';
    }
    return entry.key == 'gpt'
        ? '${entry.value}-$version'
        : '${entry.value} $version';
  }
  return null;
}

/// Full technical model identity for a tooltip, never inline roster text.
String? sessionModelTechnicalId(SessionInfo session) {
  final current = session.currentModel;
  final currentId = _trimmedModelValue(current?.modelID);
  if (currentId != null) {
    final provider = current?.providerID.trim() ?? '';
    return provider.isEmpty ? currentId : '$provider/$currentId';
  }
  return _trimmedModelValue(session.model);
}

String? _trimmedModelValue(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
