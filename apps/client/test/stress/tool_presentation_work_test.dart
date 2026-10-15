// Nightly stress lane: a wall-clock comparison (5x margin) that is meaningful
// on a quiet machine and flaky on a loaded CI runner, so it never runs on a
// pull request.
import 'package:broker_contract/broker_contract.dart';
// The canonical registry import exceeds the style line width; keep the stable
// package path for boundary-safe package import resolution.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/transcript/tool_presentation.dart';
import 'package:flutter_test/flutter_test.dart';

AgentMessage _result(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.toolResult,
  raw: {
    'type': 'tool-result',
    ...raw,
  },
);

void main() {
  test('resolving a summary is constant work in the body size', () {
    // Both fixtures are built ONCE, outside the timed region: this measures
    // the resolver, not the cost of materializing a quarter-megabyte string.
    AgentMessage message(int bodyBytes) => _result({
      'semantic': {
        'kind': 'command',
        'command': 'make test',
        'state': 'completed',
        'stdout': {'text': 'x' * bodyBytes},
      },
    });
    final smallMessage = message(1024);
    final largeMessage = message(1024 * 256);
    resolveToolSummary(result: smallMessage); // warm up

    final small = Stopwatch()..start();
    for (var i = 0; i < 500; i++) {
      resolveToolSummary(result: smallMessage);
    }
    small.stop();
    final large = Stopwatch()..start();
    for (var i = 0; i < 500; i++) {
      resolveToolSummary(result: largeMessage);
    }
    large.stop();
    // A 256x larger body must not make the collapsed summary cost more.
    expect(
      large.elapsedMicroseconds,
      lessThan(5 * (small.elapsedMicroseconds + 50)),
    );
  });
}
