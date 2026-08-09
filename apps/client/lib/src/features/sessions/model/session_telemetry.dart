import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/foundation.dart';

/// Latest cost and context telemetry for one session.
///
/// Token counts and context-usage metadata stream once per turn. Rendering each
/// frame as its own transcript row buries the conversation under telemetry that
/// is only ever read as a current value, so the transcript drops these frames
/// and this projection retains the newest reading instead. The PoC statusline
/// (`apps/poc-ui/public/app.js`) established the same rule: coalesce to the
/// latest value in a compact chip, never a transcript bubble.
@immutable
final class SessionTelemetry {
  /// Creates a telemetry snapshot.
  const SessionTelemetry({
    this.inputTokens,
    this.outputTokens,
    this.cacheReadTokens,
    this.cacheWriteTokens,
    this.cost,
    this.contextPercent,
    this.contextUsedTokens,
    this.contextMaxTokens,
    this.totalRuntimeMs,
    this.agentRuntimeMs,
    this.executionRuntimeMs,
    this.turnCount,
  });

  /// Folds telemetry frames from [messages] into one latest-value snapshot.
  factory SessionTelemetry.fromMessages(List<AgentMessage> messages) {
    var telemetry = SessionTelemetry.empty;
    for (final message in messages) {
      telemetry = telemetry.applyMessage(message);
    }
    return telemetry;
  }

  /// Empty telemetry, used before any reading arrives.
  static const SessionTelemetry empty = SessionTelemetry();

  /// Prompt tokens for the latest reading.
  final int? inputTokens;

  /// Completion tokens for the latest reading.
  final int? outputTokens;

  /// Cache-read tokens for the latest reading.
  final int? cacheReadTokens;

  /// Cache-write tokens for the latest reading.
  final int? cacheWriteTokens;

  /// Reported cost in USD, when the adapter supplies one.
  final double? cost;

  /// Context window consumed, 0-100.
  final double? contextPercent;

  /// Context tokens consumed, when reported.
  final int? contextUsedTokens;

  /// Context window size, when reported.
  final int? contextMaxTokens;

  /// Total session runtime in milliseconds.
  final int? totalRuntimeMs;

  /// Agent-side runtime in milliseconds.
  final int? agentRuntimeMs;

  /// Execution-side runtime in milliseconds.
  final int? executionRuntimeMs;

  /// Completed turns, when reported.
  final int? turnCount;

  /// Sum of every token bucket in the latest reading.
  int? get totalTokens {
    final parts = [
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    ].whereType<int>();
    if (parts.isEmpty) return null;
    return parts.fold<int>(0, (sum, value) => sum + value);
  }

  /// Whether any token reading has arrived.
  bool get hasTokens => totalTokens != null;

  /// Whether any context reading has arrived.
  bool get hasContext => contextPercent != null;

  /// Whether any runtime reading has arrived.
  bool get hasRuntime => totalRuntimeMs != null;

  /// Whether this snapshot carries nothing worth showing.
  bool get isEmpty => !hasTokens && !hasContext && !hasRuntime;

  /// Whether context pressure warrants a warning treatment.
  ///
  /// Matches the PoC statusline threshold.
  bool get isContextCritical => (contextPercent ?? 0) >= 85;

  /// Applies one live telemetry delta without rescanning transcript history.
  SessionTelemetry applyMessage(AgentMessage message) {
    switch (message.type) {
      case AgentMessageType.tokenCount:
        return _applyTokens(message.raw);
      case AgentMessageType.runSummary:
        // A run summary carries authoritative end-of-turn totals.
        return _applyRuntime(
          message.raw,
        )._applyTokens(_asMap(message.raw['tokens']));
      case AgentMessageType.metadataUpdate:
        return _applyMetadata(message.raw);
      case _:
        return this;
    }
  }

  SessionTelemetry _applyTokens(Map<String, dynamic> raw) {
    final input = _intOf(raw['input']);
    final output = _intOf(raw['output']);
    final cacheRead = _intOf(raw['cacheRead']);
    final cacheWrite = _intOf(raw['cacheWrite']);
    final cost = _doubleOf(raw['cost']);
    if (input == null &&
        output == null &&
        cacheRead == null &&
        cacheWrite == null &&
        cost == null) {
      return this;
    }
    return _copyWith(
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost: cost,
    );
  }

  SessionTelemetry _applyRuntime(Map<String, dynamic> raw) {
    return _copyWith(
      totalRuntimeMs: _intOf(raw['totalRuntimeMs']) ?? _intOf(raw['runtimeMs']),
      agentRuntimeMs: _intOf(raw['agentRuntimeMs']),
      executionRuntimeMs: _intOf(raw['executionRuntimeMs']),
      turnCount: _intOf(raw['turnCount']) ?? _intOf(raw['turns']),
    );
  }

  SessionTelemetry _applyMetadata(Map<String, dynamic> raw) {
    final key = raw['key'];
    if (key is! String) return this;
    final value = raw['value'];
    return switch (key) {
      'contextUsage' || 'context-usage' || 'context' => _applyContext(value),
      'runtimeTotals' ||
      'runtime-totals' => value is Map ? _applyRuntime(_asMap(value)) : this,
      _ => this,
    };
  }

  SessionTelemetry _applyContext(Object? value) {
    // A bare number is a percent, expressed either as 0-1 or 0-100.
    if (value is num) {
      final raw = value.toDouble();
      return _copyWith(
        contextPercent: _clampPercent(raw <= 1 ? raw * 100 : raw),
      );
    }
    if (value is! Map) return this;
    final map = _asMap(value);
    final used =
        _intOf(map['used']) ??
        _intOf(map['tokensUsed']) ??
        _intOf(map['input']) ??
        _intOf(map['current']);
    final max =
        _intOf(map['max']) ??
        _intOf(map['tokensTotal']) ??
        _intOf(map['limit']) ??
        _intOf(map['total']);
    // percent/pct may be given as a 0-1 fraction or a 0-100 value, so the
    // fraction heuristic applies to them. A `ratio` is always 0-1, and a
    // computed used/max is ALREADY a percentage — rescaling either of those
    // was double-counting low usage (1500/200000 = 0.75% showing as 75%).
    var percent = _doubleOf(map['percent']) ?? _doubleOf(map['pct']);
    if (percent != null) {
      if (percent <= 1) percent *= 100;
    } else {
      final ratio = _doubleOf(map['ratio']);
      if (ratio != null) {
        percent = ratio * 100;
      } else if (used != null && max != null && max > 0) {
        percent = used / max * 100;
      }
    }
    if (percent == null) return this;
    return _copyWith(
      contextPercent: _clampPercent(percent),
      contextUsedTokens: used,
      contextMaxTokens: max,
    );
  }

  SessionTelemetry _copyWith({
    int? inputTokens,
    int? outputTokens,
    int? cacheReadTokens,
    int? cacheWriteTokens,
    double? cost,
    double? contextPercent,
    int? contextUsedTokens,
    int? contextMaxTokens,
    int? totalRuntimeMs,
    int? agentRuntimeMs,
    int? executionRuntimeMs,
    int? turnCount,
  }) {
    return SessionTelemetry(
      inputTokens: inputTokens ?? this.inputTokens,
      outputTokens: outputTokens ?? this.outputTokens,
      cacheReadTokens: cacheReadTokens ?? this.cacheReadTokens,
      cacheWriteTokens: cacheWriteTokens ?? this.cacheWriteTokens,
      cost: cost ?? this.cost,
      contextPercent: contextPercent ?? this.contextPercent,
      contextUsedTokens: contextUsedTokens ?? this.contextUsedTokens,
      contextMaxTokens: contextMaxTokens ?? this.contextMaxTokens,
      totalRuntimeMs: totalRuntimeMs ?? this.totalRuntimeMs,
      agentRuntimeMs: agentRuntimeMs ?? this.agentRuntimeMs,
      executionRuntimeMs: executionRuntimeMs ?? this.executionRuntimeMs,
      turnCount: turnCount ?? this.turnCount,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is SessionTelemetry &&
      other.inputTokens == inputTokens &&
      other.outputTokens == outputTokens &&
      other.cacheReadTokens == cacheReadTokens &&
      other.cacheWriteTokens == cacheWriteTokens &&
      other.cost == cost &&
      other.contextPercent == contextPercent &&
      other.contextUsedTokens == contextUsedTokens &&
      other.contextMaxTokens == contextMaxTokens &&
      other.totalRuntimeMs == totalRuntimeMs &&
      other.agentRuntimeMs == agentRuntimeMs &&
      other.executionRuntimeMs == executionRuntimeMs &&
      other.turnCount == turnCount;

  @override
  int get hashCode => Object.hash(
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
    contextPercent,
    contextUsedTokens,
    contextMaxTokens,
    totalRuntimeMs,
    agentRuntimeMs,
    executionRuntimeMs,
    turnCount,
  );
}

/// Whether [message] is pure telemetry that the transcript must not render.
///
/// Run summaries are deliberately excluded: they are a per-turn diagnostic
/// record, not a streaming meter, and their renderer surfaces `turnId` on
/// purpose.
bool isSessionTelemetryMessage(AgentMessage message) {
  if (message.type == AgentMessageType.tokenCount) return true;
  if (message.type != AgentMessageType.metadataUpdate) return false;
  final key = message.raw['key'];
  return key is String &&
      const {
        'contextUsage',
        'context-usage',
        'context',
        'runtimeTotals',
        'runtime-totals',
        'sessionStats',
      }.contains(key);
}

Map<String, dynamic> _asMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return <String, dynamic>{
      for (final entry in value.entries) '${entry.key}': entry.value,
    };
  }
  return const <String, dynamic>{};
}

double _clampPercent(double value) => value.clamp(0, 100).toDouble();

int? _intOf(Object? value) {
  if (value is int) return value;
  if (value is num) return value.round();
  if (value is String) return int.tryParse(value.trim());
  return null;
}

double? _doubleOf(Object? value) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value.trim());
  return null;
}
