part of 'message_renderer_registry.dart';

/// Builds the detail rows shown under a bubble body.
///
/// [preferredKeys] is a positive allowlist: only fields a renderer explicitly
/// names are user-meaningful. [includeOtherFields] defaults to false so a new
/// broker-contract field never renders as chat content until someone
/// deliberately adds it here — the contract is versioned and does change, and a
/// blocklist of known-bad names would rot on every addition. The complete
/// payload always stays reachable through the per-message Details dialog.
List<MapEntry<String, Object?>> _collectPayloadRows({
  required AgentMessage message,
  required List<String> preferredKeys,
  bool includeOtherFields = false,
  int maxRows = 6,
}) {
  final rows = <MapEntry<String, Object?>>[];
  final seen = <String>{};

  for (final key in preferredKeys) {
    final value = message.raw[key];
    if (value != null) {
      rows.add(MapEntry(key, value));
      seen.add(key);
    }
  }

  if (!includeOtherFields) {
    return rows.take(maxRows).toList();
  }

  for (final entry in message.raw.entries) {
    if (entry.key == 'type') {
      continue;
    }
    if (seen.contains(entry.key) || entry.value == null) {
      continue;
    }
    rows.add(entry);
  }

  return rows.take(maxRows).toList();
}

/// Drops payload rows that only repeat the bubble body.
///
/// Most renderers pass the same `preferredKeys` to both `_firstPayloadValue`
/// (which becomes the summary) and `_collectPayloadRows`, so the field that
/// produced the summary is otherwise guaranteed to render a second time
/// directly underneath itself.
///
/// This is deliberately the *only* content-based filter. Which fields are
/// user-meaningful is decided by each renderer's `preferredKeys` allowlist, not
/// by a list of banned names here: a renderer that names a field (run summary
/// naming `turnId` on its diagnostic card, say) means it, and a blocklist would
/// both override that intent and rot as the broker contract adds fields.
List<MapEntry<String, Object?>> visibleTranscriptPayloadRows({
  required String summary,
  required List<MapEntry<String, Object?>> rows,
}) {
  final normalizedSummary = summary.trim();
  if (normalizedSummary.isEmpty) {
    return rows;
  }
  return rows
      .where(
        (row) => _stringifyPayloadValue(row.value).trim() != normalizedSummary,
      )
      .toList(growable: false);
}

String _stringifyPayloadValue(Object? value) {
  if (value == null) {
    return '';
  }
  if (value is Map) {
    return value.entries
        .map((entry) => '${entry.key}: ${_stringifyPayloadValue(entry.value)}')
        .join('; ');
  }
  if (value is Iterable) {
    return value.map(_stringifyPayloadValue).join(', ');
  }
  return value.toString();
}

String? _formatTokenSummary(
  AppLocalizations l10n,
  Map<String, dynamic> raw,
) {
  final input = _intValue(raw['input']);
  final output = _intValue(raw['output']);
  final cacheRead = _intValue(raw['cacheRead']);
  final cacheWrite = _intValue(raw['cacheWrite']);
  final cost = _numValue(raw['cost']);
  final pieces = <String>[];

  if (input != null) {
    pieces.add(l10n.transcriptTokenInput(input));
  }
  if (output != null) {
    pieces.add(l10n.transcriptTokenOutput(output));
  }
  if (cacheRead != null) {
    pieces.add(l10n.transcriptTokenCacheRead(cacheRead));
  }
  if (cacheWrite != null) {
    pieces.add(l10n.transcriptTokenCacheWrite(cacheWrite));
  }
  if (cost != null) {
    pieces.add(l10n.transcriptTokenCost(_formatCost(cost)));
  }

  final total = [
    input,
    output,
    cacheRead,
    cacheWrite,
  ].whereType<int>().fold<int>(0, (sum, value) => sum + value);
  if (total > 0) {
    pieces.insert(0, l10n.transcriptTokenTotal(total));
  }

  if (pieces.isEmpty) {
    return null;
  }
  return l10n.transcriptTokenSummary(pieces.join(', '));
}

String _formatRunSummary(
  AppLocalizations l10n,
  Map<String, dynamic> raw,
) {
  final status = _stringValue(raw['status']) ?? l10n.transcriptUpdatedStatus;
  final duration =
      _formatDuration(_intValue(raw['totalRuntimeMs'])) ??
      _formatDuration(_intValue(raw['agentRuntimeMs'])) ??
      _formatDuration(_intValue(raw['executionRuntimeMs']));
  final tokens = raw['tokens'] is Map<String, dynamic>
      ? _formatTokenSummary(l10n, raw['tokens'] as Map<String, dynamic>)
      : null;
  final parts = <String>[l10n.transcriptRunStatus(status)];
  if (duration != null) {
    parts.add(duration);
  }
  if (tokens != null) {
    parts.add(tokens);
  }
  return parts.join(' - ');
}

String _formatGoalState(
  AppLocalizations l10n,
  Map<String, dynamic> raw,
) {
  final title = _stringValue(raw['title']) ?? l10n.currentGoal;
  final status = _stringValue(raw['status']) ?? l10n.transcriptUpdatedStatus;
  final detail = _stringValue(raw['detail']);
  final elapsed = _formatDuration(_intValue(raw['elapsedMs']));
  final parts = <String>[l10n.transcriptGoalSummary(status, title)];
  if (detail != null && detail.isNotEmpty) {
    parts.add(detail);
  }
  if (elapsed != null) {
    parts.add(elapsed);
  }
  return parts.join(' - ');
}

String _formatTaskListSummary(
  AppLocalizations l10n,
  Map<String, dynamic> raw,
  List<_TaskListItem> items,
) {
  final title = _stringValue(raw['title']) ?? l10n.tasks;
  final status = _stringValue(raw['status']) ?? l10n.transcriptUpdatedStatus;
  if (items.isEmpty) {
    return l10n.transcriptTaskListEmpty(title, status);
  }

  final open = items.where((item) => item.status == 'open').length;
  final running = items.where((item) => item.status == 'in-progress').length;
  final done = items.where((item) => item.status == 'done').length;
  final cancelled = items.where((item) => item.status == 'cancelled').length;
  final counts = <String>[
    if (open > 0) l10n.transcriptTaskOpen(open),
    if (running > 0) l10n.transcriptTaskInProgress(running),
    if (done > 0) l10n.transcriptTaskDone(done),
    if (cancelled > 0) l10n.transcriptTaskCanceled(cancelled),
  ];
  final suffix = counts.isEmpty
      ? l10n.transcriptTaskCount(items.length)
      : counts.join(', ');
  return l10n.transcriptTaskListSummary(title, status, suffix);
}

String _formatAgentActivity(
  AppLocalizations l10n,
  Map<String, dynamic> raw,
) {
  final kind = _stringValue(raw['kind']) ?? l10n.activity;
  final status = _stringValue(raw['status']) ?? l10n.transcriptUpdatedStatus;
  final title = _stringValue(raw['title']) ?? l10n.agentActivity;
  final subtitle = _stringValue(raw['subtitle']);
  final elapsed = _formatDuration(_intValue(raw['elapsedMs']));
  final agentsDone = _intValue(raw['agentsDone']);
  final agentsTotal = _intValue(raw['agentsTotal']);
  final toolCalls = _intValue(raw['toolCalls']);
  final parts = <String>[
    l10n.transcriptAgentActivitySummary(kind, status, title),
  ];
  if (subtitle != null && subtitle.isNotEmpty) {
    parts.add(subtitle);
  }
  if (elapsed != null) {
    parts.add(elapsed);
  }
  if (agentsDone != null && agentsTotal != null) {
    parts.add(l10n.agentsProgress(agentsDone, agentsTotal));
  }
  if (toolCalls != null) {
    parts.add(l10n.transcriptToolCalls(toolCalls));
  }
  return parts.join(' - ');
}

List<_TaskListItem> _taskItems(Object? value) {
  if (value is! Iterable) {
    return const [];
  }
  return value
      .whereType<Map<Object?, Object?>>()
      .map((item) {
        final title = _stringValue(item['title']);
        if (title == null || title.isEmpty) {
          return null;
        }
        return _TaskListItem(
          title: title,
          status: _stringValue(item['status']) ?? 'open',
          detail: _stringValue(item['detail']),
          priority: _stringValue(item['priority']),
        );
      })
      .whereType<_TaskListItem>()
      .toList(growable: false);
}

List<_ActivityChild> _activityChildren(Object? value) {
  if (value is! Iterable) {
    return const [];
  }
  return value
      .whereType<Map<Object?, Object?>>()
      .map((child) {
        final title = _stringValue(child['title']);
        if (title == null || title.isEmpty) {
          return null;
        }
        return _ActivityChild(
          title: title,
          status: _stringValue(child['status']) ?? 'pending',
          phase: _stringValue(child['phase']),
          elapsedMs: _intValue(child['elapsedMs']),
        );
      })
      .whereType<_ActivityChild>()
      .toList(growable: false);
}

String? _stringValue(Object? value) {
  if (value == null) {
    return null;
  }
  final text = value.toString().trim();
  return text.isEmpty ? null : text;
}

int? _intValue(Object? value) {
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.toInt();
  }
  return null;
}

num? _numValue(Object? value) {
  if (value is num) {
    return value;
  }
  return null;
}

String? _formatDuration(int? milliseconds) {
  if (milliseconds == null || milliseconds < 0) {
    return null;
  }
  final totalSeconds = (milliseconds / 1000).round();
  final minutes = totalSeconds ~/ 60;
  final seconds = totalSeconds % 60;
  if (minutes > 0) {
    return '${minutes}m ${seconds}s';
  }
  return '${seconds}s';
}

String _formatCost(num cost) => '\$${cost.toStringAsFixed(4)}';

class _TaskListItem {
  const _TaskListItem({
    required this.title,
    required this.status,
    this.detail,
    this.priority,
  });

  final String title;
  final String status;
  final String? detail;
  final String? priority;
}

class _ActivityChild {
  const _ActivityChild({
    required this.title,
    required this.status,
    this.phase,
    this.elapsedMs,
  });

  final String title;
  final String status;
  final String? phase;
  final int? elapsedMs;
}

/// A UTF-8- and line-bounded tool detail preview.
final class ToolTextPreview {
  /// Creates a preview result.
  const ToolTextPreview({required this.text, required this.isTruncated});

  /// Bounded text shown inline.
  final String text;

  /// Whether [text] omits any part of the full payload.
  final bool isTruncated;
}

/// Applies the D9 40-line and 4,096-byte cap.
///
/// Command and result output set [keepTail] so the most recent output remains
/// visible. Diffs and other text keep the head.
ToolTextPreview buildToolTextPreview(
  String fullText, {
  required bool keepTail,
  int maxLines = 40,
  int maxUtf8Bytes = 4096,
}) {
  var preview = fullText;
  final lines = fullText.split('\n');
  if (lines.length > maxLines) {
    preview = keepTail
        ? lines.sublist(lines.length - maxLines).join('\n')
        : lines.take(maxLines).join('\n');
  }

  if (utf8.encode(preview).length > maxUtf8Bytes) {
    preview = keepTail
        ? _utf8Tail(preview, maxUtf8Bytes)
        : _utf8Head(preview, maxUtf8Bytes);
  }
  return ToolTextPreview(
    text: preview,
    isTruncated: preview != fullText,
  );
}

String _utf8Head(String value, int maxBytes) {
  final buffer = StringBuffer();
  var used = 0;
  for (final rune in value.runes) {
    final character = String.fromCharCode(rune);
    final bytes = utf8.encode(character).length;
    if (used + bytes > maxBytes) break;
    buffer.write(character);
    used += bytes;
  }
  return buffer.toString();
}

String _utf8Tail(String value, int maxBytes) {
  final kept = <int>[];
  var used = 0;
  for (final rune in value.runes.toList().reversed) {
    final bytes = utf8.encode(String.fromCharCode(rune)).length;
    if (used + bytes > maxBytes) break;
    kept.add(rune);
    used += bytes;
  }
  return String.fromCharCodes(kept.reversed);
}
