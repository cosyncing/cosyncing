import 'package:broker_contract/broker_contract.dart';
import 'package:path/path.dart' as p;

/// Places replayed file cards after their original source rows across loaded
/// history runs. Canonical pages, cursors and the Files collection stay intact.
/// A source outside the loaded window does not become a new card at the tail.
///
/// Immutable run indexes and projections are reused while only the live tail
/// changes, so streaming does not repeatedly scan older transcript pages.
List<List<AgentMessage>> positionTranscriptArtifacts(
  List<List<AgentMessage>> runs, {
  List<bool>? contiguousBefore,
  void Function(AgentMessage source, AgentMessage artifact)? onPlacement,
}) {
  final indexes = [for (final run in runs) _index(run)];
  final placements = List.generate(
    runs.length,
    (_) => <(int, AgentMessage)>[],
  );
  for (final index in indexes) {
    for (final artifact in index.artifacts) {
      final anchor = artifact.raw['transcriptAnchor'] as Map;
      final matches = <(int, int)>[];
      for (var run = 0; run < indexes.length; run++) {
        final candidates = indexes[run];
        if (anchor['type'] == 'workspace-write') {
          final path = anchor['path'];
          final createdAt = anchor['createdAt'];
          if (path is! String || path.isEmpty || createdAt is! num) continue;
          for (final write in candidates.writes) {
            if (!_sameWritePath(path, write.$1)) continue;
            // Both bounding prompts must be loaded with no decoded gap in
            // between. This rules out a later rewrite of an old cached path,
            // even when the actual creating write is still off screen.
            final before = _boundingPrompt(
              indexes,
              run,
              write.$2,
              earlier: true,
              contiguousBefore: contiguousBefore,
            );
            final after = _boundingPrompt(
              indexes,
              run,
              write.$2,
              earlier: false,
              contiguousBefore: contiguousBefore,
            );
            if (before != null &&
                after != null &&
                before <= createdAt &&
                createdAt < after) {
              matches.add((run, write.$2));
            }
          }
        } else {
          final row = candidates.anchors[(anchor['type'], anchor['key'])];
          if (row != null && row >= 0) matches.add((run, row));
        }
      }
      // Paths from an older cache are only a recovery hint. Several writes
      // of the same file cannot establish which version this card belongs to.
      if (matches.length != 1) continue;
      final (run, row) = matches.single;
      onPlacement?.call(runs[run][row], artifact);
      placements[run].add((row, artifact));
    }
  }
  return [
    for (var run = 0; run < runs.length; run++)
      indexes[run].present(runs[run], placements[run]),
  ];
}

num? _boundingPrompt(
  List<_ArtifactRunIndex> indexes,
  int run,
  int row, {
  required bool earlier,
  required List<bool>? contiguousBefore,
}) {
  var at = run;
  while (true) {
    final prompts = indexes[at].prompts;
    final eligible = prompts.where(
      (prompt) => at != run || (earlier ? prompt.$1 < row : prompt.$1 > row),
    );
    if (eligible.isNotEmpty) {
      return earlier ? eligible.last.$2 : eligible.first.$2;
    }
    final next = earlier ? at - 1 : at + 1;
    if (next < 0 ||
        next >= indexes.length ||
        contiguousBefore == null ||
        !contiguousBefore[earlier ? at : next]) {
      return null;
    }
    at = next;
  }
}

final Expando<_ArtifactRunIndex> _indexes = Expando('artifact placement');

_ArtifactRunIndex _index(List<AgentMessage> messages) =>
    _indexes[messages] ??= _ArtifactRunIndex(messages);

bool _isAnchoredArtifact(AgentMessage message) =>
    message.type == AgentMessageType.fileArtifact &&
    message.raw['transcriptAnchor'] is Map;

bool _sameWritePath(String left, String right) {
  String normalize(String value) {
    final normalized = p.posix.normalize(value.replaceAll(r'\', '/'));
    return RegExp('^[A-Za-z]:/').hasMatch(normalized)
        ? normalized.toLowerCase()
        : normalized;
  }

  final a = normalize(left);
  final b = normalize(right);
  bool absolute(String value) =>
      p.posix.isAbsolute(value) || RegExp('^[a-z]:/').hasMatch(value);
  return a == b ||
      (!absolute(a) && b.endsWith('/$a')) ||
      (!absolute(b) && a.endsWith('/$b'));
}

final class _ArtifactRunIndex {
  _ArtifactRunIndex(List<AgentMessage> messages) {
    for (var row = 0; row < messages.length; row++) {
      final message = messages[row];
      if (_isAnchoredArtifact(message)) {
        artifacts.add(message);
        continue;
      }
      final key = switch (message.type) {
        AgentMessageType.toolCall ||
        AgentMessageType.toolResult => message.raw['callId'],
        AgentMessageType.modelOutput ||
        AgentMessageType.thinking ||
        AgentMessageType.userMessage => message.raw['key'],
        _ => null,
      };
      if (message.type == AgentMessageType.userMessage &&
          !message.userMessageQueued) {
        final sentAt = message.raw['sentAt'];
        prompts.add((row, sentAt is num ? sentAt : null));
      }
      if (key is String && key.isNotEmpty) {
        anchors.update(
          (message.type.wireValue, key),
          (_) => -1,
          ifAbsent: () => row,
        );
      }
      final name = message.raw['toolName'] ?? message.raw['name'];
      final path = message.raw['path'];
      if (message.type == AgentMessageType.toolResult &&
          name is String &&
          name.toLowerCase() == 'write' &&
          message.raw['isError'] != true &&
          message.raw['pending'] != true &&
          path is String &&
          path.isNotEmpty) {
        writes.add((path, row));
      }
    }
  }

  final Map<(Object?, Object?), int> anchors = {};
  final List<(String, int)> writes = [];
  final List<(int, num?)> prompts = [];
  final List<AgentMessage> artifacts = [];
  List<(int, AgentMessage)>? _placements;
  List<AgentMessage>? _presented;

  List<AgentMessage> present(
    List<AgentMessage> messages,
    List<(int, AgentMessage)> placements,
  ) {
    if (artifacts.isEmpty && placements.isEmpty) {
      _placements = null;
      _presented = null;
      return messages;
    }
    final previous = _placements;
    if (previous != null &&
        previous.length == placements.length &&
        Iterable<int>.generate(previous.length).every(
          (i) =>
              previous[i].$1 == placements[i].$1 &&
              identical(previous[i].$2, placements[i].$2),
        )) {
      return _presented!;
    }
    final after = <int, List<AgentMessage>>{};
    for (final (row, artifact) in placements) {
      (after[row] ??= []).add(artifact);
    }
    _placements = placements;
    return _presented = List<AgentMessage>.unmodifiable([
      for (var row = 0; row < messages.length; row++) ...[
        if (!_isAnchoredArtifact(messages[row])) messages[row],
        ...?after[row],
      ],
    ]);
  }
}
