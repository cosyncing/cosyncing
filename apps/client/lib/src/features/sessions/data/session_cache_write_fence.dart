import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

enum _SessionCacheAdmissionKind { transcript, roster }

/// Scoped token captured when controller work first becomes pending.
final class SessionCacheWriteAdmission {
  SessionCacheWriteAdmission._({
    required this._kind,
    this._brokerSourceKey,
    this._tool,
    this._sessionId,
  });

  final _SessionCacheAdmissionKind _kind;
  final String? _brokerSourceKey;
  final String? _tool;
  final String? _sessionId;
  bool _valid = true;
}

/// Orders rebuildable-cache writes and explicit cache deletion.
///
/// Controllers capture a scoped admission when an event enters their
/// coalescing queue, before a repository call exists. A clear synchronously
/// invalidates matching unclaimed admissions, then drains repository writes
/// already admitted through [write] before deleting. Later events receive new
/// tokens and may rebuild the cache after deletion.
final class SessionCacheWriteFence {
  Future<void> _tail = Future<void>.value();
  final Set<SessionCacheWriteAdmission> _activeAdmissions = {};

  /// Admits pending work for one exact broker-scoped transcript.
  SessionCacheWriteAdmission admitTranscript({
    required String brokerSourceKey,
    required String tool,
    required String sessionId,
  }) {
    final admission = SessionCacheWriteAdmission._(
      kind: _SessionCacheAdmissionKind.transcript,
      brokerSourceKey: brokerSourceKey,
      tool: tool,
      sessionId: sessionId,
    );
    _activeAdmissions.add(admission);
    return admission;
  }

  /// Admits pending work for the broker roster cache.
  SessionCacheWriteAdmission admitRoster() {
    final admission = SessionCacheWriteAdmission._(
      kind: _SessionCacheAdmissionKind.roster,
    );
    _activeAdmissions.add(admission);
    return admission;
  }

  /// Claims [admission] immediately before its repository call.
  ///
  /// The claim and the repository's synchronous FIFO admission happen in one
  /// event-loop turn. False means a clear invalidated the work and no durable
  /// operation may run (or be acknowledged) for it.
  bool claim(SessionCacheWriteAdmission admission) {
    final wasActive = _activeAdmissions.remove(admission);
    return wasActive && admission._valid;
  }

  /// Releases superseded or abandoned controller work without writing it.
  void release(SessionCacheWriteAdmission? admission) {
    if (admission == null) return;
    _activeAdmissions.remove(admission);
  }

  /// Runs one transcript or roster persistence operation in admission order.
  Future<T> write<T>(Future<T> Function() operation) => _enqueue(operation);

  /// Invalidates one exact transcript, drains older writes, then deletes it.
  Future<T> clearTranscript<T>({
    required String brokerSourceKey,
    required String tool,
    required String sessionId,
    required Future<T> Function() operation,
  }) {
    for (final admission in _activeAdmissions) {
      if (admission._kind == _SessionCacheAdmissionKind.transcript &&
          admission._brokerSourceKey == brokerSourceKey &&
          admission._tool == tool &&
          admission._sessionId == sessionId) {
        admission._valid = false;
      }
    }
    return _enqueue(operation);
  }

  /// Invalidates all transcript/roster work, drains writes, then deletes all.
  Future<T> clearAll<T>(Future<T> Function() operation) {
    for (final admission in _activeAdmissions) {
      admission._valid = false;
    }
    return _enqueue(operation);
  }

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    final admittedAfter = _tail;
    final release = Completer<void>();
    _tail = release.future;
    return () async {
      try {
        await admittedAfter;
        return await operation();
      } finally {
        release.complete();
      }
    }();
  }
}

/// App-scoped admission fence shared by both session-cache repositories.
final sessionCacheWriteFenceProvider = Provider<SessionCacheWriteFence>(
  (ref) => SessionCacheWriteFence(),
);
