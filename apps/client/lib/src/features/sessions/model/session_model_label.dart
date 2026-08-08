import 'package:broker_contract/broker_contract.dart';

const _families = <String, String>{
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
  final currentRaw = _trimmed(session.currentModel?.modelID);
  final legacyRaw = _trimmed(session.model);
  final authored = _humanLabel(session.currentModel?.label, currentRaw);
  if (authored != null) return authored;
  final legacy = _humanLabel(legacyRaw, currentRaw);
  if (legacy != null) return legacy;
  return _derivedLabel(currentRaw ?? legacyRaw);
}

String? _humanLabel(String? value, String? raw) {
  var candidate = value?.trim() ?? '';
  if (candidate.isEmpty) return null;
  if (raw != null && raw.isNotEmpty) {
    candidate = candidate
        .replaceAll(RegExp(RegExp.escape(raw), caseSensitive: false), '')
        .replaceAll(RegExp(r'^[\s·•|,:/—–-]+|[\s·•|,:/—–-]+$'), '')
        .trim();
    if (candidate.isEmpty) return null;
  }
  if (_looksLikeRawId(candidate)) return null;
  return candidate;
}

bool _looksLikeRawId(String value) {
  if (value.contains(' ')) return false;
  final parts = value
      .split(RegExp('[-_/.:]+'))
      .where((part) => part.isNotEmpty);
  return parts.length >= 3 &&
      value.contains(RegExp('[A-Za-z]')) &&
      value.contains(RegExp('[0-9]'));
}

String? _derivedLabel(String? modelId) {
  final raw = modelId?.trim().toLowerCase() ?? '';
  if (raw.isEmpty) return null;
  for (final entry in _families.entries) {
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
  final currentId = _trimmed(current?.modelID);
  if (currentId != null) {
    final provider = current?.providerID.trim() ?? '';
    return provider.isEmpty ? currentId : '$provider/$currentId';
  }
  return _trimmed(session.model);
}

String? _trimmed(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
