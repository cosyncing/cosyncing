import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_schedule_diagnostics.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_scheduled_message_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the same tool/session under two profiles keeps separate readings', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    container.read(inlineScheduleDiagnosticsProvider.notifier)
      ..record(
        _key('profile-a'),
        InlineScheduleDiagnostics(
          freshness: InlineScheduleFreshness.stale,
          scheduleCount: 3,
          passiveFailureKind: FailureKind.unauthorized,
          passiveFailureDetail: 'a-only token detail',
        ),
      )
      ..record(
        _key('profile-b'),
        InlineScheduleDiagnostics(
          freshness: InlineScheduleFreshness.unknown,
          scheduleCount: 0,
        ),
      );

    final readings = container.read(inlineScheduleDiagnosticsProvider);
    expect(readings[_key('profile-a')]?.scheduleCount, 3);
    expect(
      readings[_key('profile-b')]?.scheduleCount,
      0,
      reason: "profile-b must not inherit profile-a's row count",
    );
    expect(
      readings[_key('profile-b')]?.passiveFailureKind,
      isNull,
      reason: "nor profile-a's failure",
    );
    expect(readings[_key('profile-b')]?.passiveFailureDetail, isNull);
  });

  test('a ninth session evicts the oldest reading', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final store = container.read(inlineScheduleDiagnosticsProvider.notifier);

    for (
      var i = 0;
      i < InlineScheduleDiagnosticsController.retainedSessions;
      i++
    ) {
      store.record(
        _key('profile-a', sessionId: 'session-$i'),
        InlineScheduleDiagnostics(
          freshness: InlineScheduleFreshness.fresh,
          scheduleCount: i,
        ),
      );
    }
    expect(
      container.read(inlineScheduleDiagnosticsProvider).length,
      InlineScheduleDiagnosticsController.retainedSessions,
    );

    store.record(
      _key('profile-a', sessionId: 'session-new'),
      InlineScheduleDiagnostics(
        freshness: InlineScheduleFreshness.fresh,
        scheduleCount: 99,
      ),
    );

    final readings = container.read(inlineScheduleDiagnosticsProvider);
    expect(
      readings.length,
      InlineScheduleDiagnosticsController.retainedSessions,
      reason: 'the cap holds',
    );
    expect(
      readings[_key('profile-a', sessionId: 'session-0')],
      isNull,
      reason: 'the oldest insertion is the one evicted',
    );
    expect(
      readings[_key('profile-a', sessionId: 'session-new')]?.scheduleCount,
      99,
    );
  });

  test('an oversized broker detail is truncated and marked', () {
    final oversized = 'x' * 5000;
    final diagnostics = InlineScheduleDiagnostics(
      freshness: InlineScheduleFreshness.stale,
      scheduleCount: 1,
      passiveFailureKind: FailureKind.rejected,
      passiveFailureDetail: oversized,
    );

    final detail = diagnostics.passiveFailureDetail!;
    expect(
      detail.length,
      InlineScheduleDiagnostics.detailCharacterLimit +
          InlineScheduleDiagnostics.truncationMarker.length,
      reason:
          'an eight-entry cap is not a memory bound if each entry can '
          'retain an unbounded error body',
    );
    expect(
      detail.endsWith(InlineScheduleDiagnostics.truncationMarker),
      isTrue,
      reason: 'a cut body must never read as complete',
    );
  });

  test('a detail within the limit is kept verbatim', () {
    final diagnostics = InlineScheduleDiagnostics(
      freshness: InlineScheduleFreshness.stale,
      scheduleCount: 1,
      passiveFailureDetail: 'short detail [CODE] (status 400)',
    );
    expect(
      diagnostics.passiveFailureDetail,
      'short detail [CODE] (status 400)',
    );
  });
}

InlineScheduleDiagnosticsKey _key(
  String scopeKey, {
  String sessionId = 'session-1',
}) => InlineScheduleDiagnosticsKey(
  brokerScopeKey: scopeKey,
  tool: 'codex',
  sessionId: sessionId,
);
