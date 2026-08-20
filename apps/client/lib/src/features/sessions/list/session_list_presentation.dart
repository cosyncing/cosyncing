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

const _modelFamilies = <String, String>{
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
  'longcat': 'LongCat',
};

/// Compact trustworthy model text for roster metadata.
///
/// Raw provider ids never pass through as a fallback: an unknown id is omitted
/// instead of turning the roster into a debug console.
String? sessionModelLabel(SessionInfo session) {
  final currentRaw = _trimmedModelValue(session.currentModel?.modelID);
  final legacyRaw = _trimmedModelValue(session.model);
  final authored = _humanModelLabel(session.currentModel?.label, currentRaw);
  if (authored != null) return authored;
  final legacy = _humanModelLabel(legacyRaw, currentRaw);
  if (legacy != null) return legacy;
  return _derivedModelLabel(currentRaw ?? legacyRaw);
}

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
      .split(RegExp('[-_/.:]+'))
      .where((part) => part.isNotEmpty);
  return parts.length >= 3 &&
      value.contains(RegExp('[A-Za-z]')) &&
      value.contains(RegExp('[0-9]'));
}

String? _derivedModelLabel(String? modelId) {
  final raw = modelId?.trim().toLowerCase() ?? '';
  if (raw.isEmpty) return null;
  // Never guess from a provider-qualified id. Pairing digits out of
  // `kimi-code/k3-256k` produced `Kimi 3.256`, and the digit-free sibling
  // produced a bare `Kimi`; both are invented names. The adapter authors
  // `currentModel.label`, and with no label the roster shows nothing.
  if (raw.contains('/') || raw.contains(':')) return null;
  for (final entry in _modelFamilies.entries) {
    final familyStart = raw.indexOf(entry.key);
    if (familyStart < 0) continue;
    final familyEnd = familyStart + entry.key.length;
    final matches = RegExp(r'\d+').allMatches(raw).where((match) {
      final value = match.group(0)!;
      // Published model ids commonly end in YYYYMMDD release stamps. They are
      // technical identity, not the model family version shown in the roster.
      return value.length < 6;
    }).toList();
    final before = matches.where((match) => match.end <= familyStart).toList();
    final after = matches.where((match) => match.start >= familyEnd).toList();
    final useAfter =
        before.isEmpty ||
        (after.isNotEmpty &&
            after.first.start - familyEnd <= familyStart - before.last.end);
    final numbers = useAfter
        ? after.take(2).map((match) => match.group(0)!).toList()
        : before.reversed
              .take(2)
              .map((match) => match.group(0)!)
              .toList()
              .reversed
              .toList();
    if (numbers.isEmpty) return entry.value;
    final version = numbers.length >= 2
        ? '${numbers[0]}.${numbers[1]}'
        : numbers.first;
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
