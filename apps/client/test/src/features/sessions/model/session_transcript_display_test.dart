import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/model/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('lookup grouping', () {
    test('groups two consecutive lookup calls and their results', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _message('user-message', {'key': 'u1', 'text': 'Inspect it'}),
          _toolCall('read-1', ToolDisplayClass.lookup),
          _toolResult('read-1', ToolDisplayClass.lookup),
          _toolCall('grep-1', ToolDisplayClass.lookup),
          _toolResult('grep-1', ToolDisplayClass.lookup),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(entries, hasLength(2));
      final group = entries.last as LookupGroupTranscriptDisplayEntry;
      expect(group.tools, hasLength(2));
      expect(group.tools.first.callId, 'read-1');
      expect(group.tools.first.result, isNotNull);
      expect(group.tools.last.callId, 'grep-1');
    });

    test('execute and assistant messages end a lookup run', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _toolCall('read-1', ToolDisplayClass.lookup),
          _toolCall('exec-1', ToolDisplayClass.execute),
          _toolCall('read-2', ToolDisplayClass.lookup),
          _message('thinking', {'text': 'Checking'}),
          _toolCall('read-3', ToolDisplayClass.lookup),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(entries, hasLength(5));
      expect(entries.whereType<LookupGroupTranscriptDisplayEntry>(), isEmpty);
      expect(
        entries.whereType<ToolTranscriptDisplayEntry>().map((e) => e.callId),
        ['read-1', 'exec-1', 'read-2', 'read-3'],
      );
    });

    test('missing and unknown toolClass stay ungrouped', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _message('tool-call', {'callId': 'missing'}),
          _message('tool-call', {
            'callId': 'future',
            'toolClass': 'future-class',
          }),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(entries, hasLength(2));
      expect(entries.whereType<LookupGroupTranscriptDisplayEntry>(), isEmpty);
    });
  });

  group('tool call/result pairing', () {
    test('pairs a call with a result separated by other frames', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _toolCall('exec-1', ToolDisplayClass.execute),
          _message('thinking', {'text': 'Waiting on the command'}),
          _message('token-count', {'input': 10, 'output': 5}),
          _toolResult('exec-1', ToolDisplayClass.execute),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final tools = entries.whereType<ToolTranscriptDisplayEntry>().toList();
      expect(tools, hasLength(1), reason: 'one invocation is one card');
      expect(tools.single.call, isNotNull);
      expect(tools.single.result, isNotNull);
      expect(tools.single.sourceIndices, [0, 3]);
    });

    test('a running call with no result still renders alone', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [_toolCall('exec-1', ToolDisplayClass.execute)],
        mode: ToolDisplayMode.responsive,
      );

      final tool = entries.single as ToolTranscriptDisplayEntry;
      expect(tool.call, isNotNull);
      expect(tool.result, isNull);
      expect(tool.callId, 'exec-1');
    });

    test('an orphan result from truncated history renders alone', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [_toolResult('exec-lost', ToolDisplayClass.execute)],
        mode: ToolDisplayMode.responsive,
      );

      final tool = entries.single as ToolTranscriptDisplayEntry;
      expect(tool.call, isNull);
      expect(tool.result, isNotNull);
      expect(tool.callId, 'exec-lost');
    });

    test('interleaved concurrent invocations pair by call id', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _toolCall('exec-a', ToolDisplayClass.execute),
          _toolCall('exec-b', ToolDisplayClass.execute),
          _toolResult('exec-b', ToolDisplayClass.execute),
          _toolResult('exec-a', ToolDisplayClass.execute),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final tools = entries.whereType<ToolTranscriptDisplayEntry>().toList();
      expect(tools, hasLength(2));
      expect(tools.map((tool) => tool.callId), ['exec-a', 'exec-b']);
      expect(tools.every((tool) => tool.result != null), isTrue);
    });

    test('a repeated call id pairs each call with its own result', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _toolCall('exec-1', ToolDisplayClass.execute),
          _toolResult('exec-1', ToolDisplayClass.execute),
          _toolCall('exec-1', ToolDisplayClass.execute),
          _toolResult('exec-1', ToolDisplayClass.execute),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final tools = entries.whereType<ToolTranscriptDisplayEntry>().toList();
      expect(tools, hasLength(2));
      expect(tools.first.sourceIndices, [0, 1]);
      expect(tools.last.sourceIndices, [2, 3]);
    });
  });

  group('final messages only', () {
    test('queued prompt does not start a new turn before delivery', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _message('user-message', {'key': 'u1', 'text': 'First turn'}),
          _message('model-output', {'key': 'a1', 'text': 'Preamble'}),
          _message('thinking', {'text': 'Reasoning'}),
          _message('user-message', {
            'key': 'u2',
            'text': 'Queued next turn',
            'queued': true,
          }),
          _message('model-output', {'key': 'a2', 'text': 'First final'}),
        ],
        mode: ToolDisplayMode.finalMessagesOnly,
      );

      final visible = entries
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message)
          .toList();
      expect(
        visible.map((message) => message.raw['text']),
        ['First turn', 'Queued next turn', 'First final'],
      );
    });

    test('delivery starts the next turn and picks its own final answer', () {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: [
          _message('user-message', {'key': 'u1', 'text': 'First turn'}),
          _message('model-output', {'key': 'a1', 'text': 'First final'}),
          _message('user-message', {'key': 'u2', 'text': 'Second turn'}),
          _message('model-output', {'key': 'a2', 'text': 'Second preamble'}),
          _message('model-output', {'key': 'a3', 'text': 'Second final'}),
        ],
        mode: ToolDisplayMode.finalMessagesOnly,
      );

      final text = entries.whereType<MessageTranscriptDisplayEntry>().map(
        (entry) => entry.message.raw['text'],
      );
      expect(
        text,
        ['First turn', 'First final', 'Second turn', 'Second final'],
      );
    });

    test('keeps every safety and delivered-artifact surface', () {
      final messages = <AgentMessage>[
        _message('permission-request', {'requestId': 'p1'}),
        _message('question-request', {'requestId': 'q1'}),
        _message('error', {'message': 'Failed'}),
        _message('notice', {'message': 'Notice'}),
        _message('file-artifact', {'name': 'report.html'}),
        _message('tool-call', {
          'callId': 'tool-1',
          'toolClass': 'execute',
        }),
        _message('terminal-output', {'data': 'hidden'}),
        _message('agent-activity', {'title': 'hidden'}),
      ];

      final entries = buildSessionTranscriptDisplayEntries(
        messages: messages,
        mode: ToolDisplayMode.finalMessagesOnly,
      );
      final visibleTypes = entries
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message.type)
          .toSet();

      expect(
        visibleTypes,
        containsAll({
          AgentMessageType.permissionRequest,
          AgentMessageType.questionRequest,
          AgentMessageType.error,
          AgentMessageType.notice,
          AgentMessageType.fileArtifact,
        }),
      );
      expect(visibleTypes, isNot(contains(AgentMessageType.toolCall)));
      expect(visibleTypes, isNot(contains(AgentMessageType.terminalOutput)));
      expect(visibleTypes, isNot(contains(AgentMessageType.agentActivity)));
    });
  });

  group('request resolutions are state transitions, not Chat rows (CR2)', () {
    final history = <AgentMessage>[
      _message('user-message', {'key': 'u1', 'text': 'Prompt'}),
      _message('permission-request', {'requestId': 'p1'}),
      _message('permission-resolved', {
        'requestId': 'p1',
        'decision': 'approve',
      }),
      _message('question-request', {'requestId': 'q1'}),
      _message('question-resolved', {'requestId': 'q1'}),
      // Orphans (older broker / replayed cache): no matching request at all.
      _message('permission-resolved', {
        'requestId': 'ghost-p',
        'decision': 'reject',
      }),
      _message('question-resolved', {'requestId': 'ghost-q'}),
      _message('model-output', {'key': 'a1', 'text': 'Answer'}),
    ];

    void expectNoResolutionRows(ToolDisplayMode mode) {
      final entries = buildSessionTranscriptDisplayEntries(
        messages: history,
        mode: mode,
      );
      final visibleTypes = entries
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message.type)
          .toList();
      // The requests stay renderable; every resolution — paired or orphan —
      // is invisible as a standalone row. The canonical list is untouched.
      expect(visibleTypes, contains(AgentMessageType.permissionRequest));
      expect(visibleTypes, contains(AgentMessageType.questionRequest));
      expect(
        visibleTypes,
        isNot(contains(AgentMessageType.permissionResolved)),
      );
      expect(
        visibleTypes,
        isNot(contains(AgentMessageType.questionResolved)),
      );
    }

    test('responsive renders no standalone resolution row', () {
      expectNoResolutionRows(ToolDisplayMode.responsive);
    });

    test('tier-1-only renders no standalone resolution row', () {
      expectNoResolutionRows(ToolDisplayMode.tier1Only);
    });

    test('final-only agrees with responsive', () {
      expectNoResolutionRows(ToolDisplayMode.finalMessagesOnly);
    });
  });
}

AgentMessage _toolCall(String callId, ToolDisplayClass displayClass) =>
    _message('tool-call', {
      'callId': callId,
      'toolClass': displayClass.wireValue,
    });

AgentMessage _toolResult(String callId, ToolDisplayClass displayClass) =>
    _message('tool-result', {
      'callId': callId,
      'toolClass': displayClass.wireValue,
    });

AgentMessage _message(String type, Map<String, dynamic> fields) =>
    AgentMessage.fromJson({'type': type, ...fields});
