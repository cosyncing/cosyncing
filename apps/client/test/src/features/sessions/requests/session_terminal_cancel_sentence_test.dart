import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A synced Claude terminal can take back a call the app was asked about: its
/// "Show Claude's dialog", Escape, or the app's own Stop ending the turn. The
/// broker closes the card with who did it, and the card says so, instead of
/// "Resolved in another client.".
const _cardId = 'cm-1@00000000000000c1';

MessageWireEvent _held() => const MessageWireEvent(
  seq: 1,
  message: AgentMessage(
    type: AgentMessageType.permissionRequest,
    raw: {
      'type': 'permission-request',
      'requestId': _cardId,
      'title': 'Bash',
      'toolName': 'Bash',
      'inputPreview': 'command: make',
      'permissionMode': 'default',
    },
  ),
);

MessageWireEvent _closed(Map<String, Object> attribution) => MessageWireEvent(
  seq: 2,
  message: AgentMessage(
    type: AgentMessageType.permissionResolved,
    raw: {
      'type': 'permission-resolved',
      'requestId': _cardId,
      'decision': 'external',
      ...attribution,
    },
  ),
);

Future<void> _pump(WidgetTester tester, Map<String, Object> attribution) async {
  final connection = ScriptedSessionDetailConnection(
    events: [_held(), _closed(attribution)],
  );
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], connection: connection),
  );
  await tester.pumpAndSettle();
}

void main() {
  final l10n = lookupAppLocalizations(const Locale('en'));

  testWidgets('"Show Claude\'s dialog" closes the card as answered in the '
      'terminal', (tester) async {
    await _pump(tester, {'releaseReason': 'band'});
    expect(find.text(l10n.sessionRequestReleaseBand), findsOneWidget);
    expect(find.text(l10n.sessionRequestResolvedElsewhere), findsNothing);
  });

  testWidgets('Escape at the keyboard closes the card as answered in the '
      'terminal', (tester) async {
    // The broker sends the same reason for both: the person is at the
    // terminal, and the call is in Claude's hands there.
    await _pump(tester, {'releaseReason': 'band'});
    expect(find.text('You answered it in your terminal.'), findsOneWidget);
    expect(find.text(l10n.sessionRequestResolvedElsewhere), findsNothing);
  });

  testWidgets("the app's own Stop closes the card as answered in the app", (
    tester,
  ) async {
    await _pump(tester, {'decidedBy': 'app'});
    expect(find.text(l10n.sessionRequestDecidedByApp), findsOneWidget);
    expect(find.text(l10n.sessionRequestResolvedElsewhere), findsNothing);
  });

  testWidgets('a broker that says nothing still reads as another client', (
    tester,
  ) async {
    await _pump(tester, const {});
    expect(find.text(l10n.sessionRequestResolvedElsewhere), findsOneWidget);
  });
}
