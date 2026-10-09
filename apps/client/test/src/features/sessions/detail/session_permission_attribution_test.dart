import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_test/flutter_test.dart';

/// Who answered a settled approval, folded for the card that stays on screen.
///
/// A mod-synced session has two places the same prompt can be answered, and the
/// decision value alone cannot tell them apart: `external` covers the terminal
/// answering, the app answering, and nobody answering at all.
void main() {
  AgentMessage card() => AgentMessage.fromJson({
    'type': 'permission-request',
    'requestId': 'perm-1',
    'title': 'Bash',
    'permissionMode': 'default',
  });

  AgentMessage resolved({
    String decision = 'external',
    String? decidedBy,
    String? releaseReason,
  }) => AgentMessage.fromJson({
    'type': 'permission-resolved',
    'requestId': 'perm-1',
    'decision': decision,
    if (decidedBy != null) 'decidedBy': decidedBy,
    if (releaseReason != null) 'releaseReason': releaseReason,
  });

  TranscriptHistoryWindow windowWith(AgentMessage resolution) {
    final window = TranscriptHistoryWindow.fromHistory(
      HistoryWireEvent(
        messages: [card(), resolution],
        reset: true,
        cursor: 'initial',
      ),
    );
    return window;
  }

  ResolvedRequestAttribution? attribution(TranscriptHistoryWindow window) =>
      window.resolvedRequestAttributions['perm-1'];

  group('settled permission attribution', () {
    test('names the terminal when the terminal answered', () {
      final settled = attribution(
        windowWith(resolved(decidedBy: 'band')),
      );

      expect(settled?.decider, PermissionDecidedBy.band);
      expect(settled?.releaseReason, isNull);
    });

    test('names the app when a tap in the app answered', () {
      final settled = attribution(
        windowWith(resolved(decision: 'approve', decidedBy: 'app')),
      );

      expect(settled?.decider, PermissionDecidedBy.app);
    });

    test('a deadline carries its reason, which the decision cannot say', () {
      // `decision: external` with nobody answering reads as "resolved in
      // another client" — a sentence about a seat that never existed.
      final settled = attribution(
        windowWith(
          resolved(decidedBy: 'expired', releaseReason: 'expired'),
        ),
      );

      expect(settled?.decider, PermissionDecidedBy.expired);
      expect(settled?.releaseReason, PermissionReleaseReason.expired);
    });

    test('an older broker folds nothing, so the card says nothing', () {
      final settled = attribution(windowWith(resolved()));

      expect(settled, isNull);
      // The decision itself still folds, which is what closes the card.
      expect(
        windowWith(resolved()).resolvedRequestDecisions['perm-1'],
        'external',
      );
    });

    test('a resolution for a question asks for no attribution', () {
      final window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: [
            AgentMessage.fromJson({
              'type': 'question-request',
              'requestId': 'q-1',
              'questions': [
                {'question': 'Which branch?'},
              ],
            }),
            AgentMessage.fromJson({'type': 'question-resolved'}),
          ],
          reset: true,
          cursor: 'initial',
        ),
      );

      // The resolution above carries no requestId on purpose: nothing is folded
      // for an id the frame never named.
      expect(window.resolvedRequestAttributions, isEmpty);
    });
  });
}
