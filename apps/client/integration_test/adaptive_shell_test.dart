import 'package:cosyncing_client/src/app/app.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

// Form-factor regression gate. Runs on-device (emulator / simulator) so the
// width it reads is the *real* device width, then asserts the adaptive shell
// matches: the wide layout (>= 840 dp, `_wideNavigationBreakpoint` in
// lib/src/app/router/router.dart) renders the two-pane Sessions workspace with
// contextual header actions and no permanent navigation; the narrower layout
// retains the compact bottom navigation.
//
// One test validates both matrix legs — a phone device (iPhone / Pixel 5,
// ~393 dp -> single-pane) and a tablet device (iPad Pro 11 / Pixel Tablet,
// >= 840 dp -> two-pane) — by branching on the device it happens to run on.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('adaptive shell matches device width', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          activeBrokerProfileHydrationProvider.overrideWith((_) async {}),
          sessionListRepositoryProvider.overrideWith(
            (_) async => InMemorySessionListRepository(),
          ),
        ],
        child: const App(),
      ),
    );

    await tester.pumpAndSettle();

    final width = tester.view.physicalSize.width / tester.view.devicePixelRatio;
    final removedDesktopSurface = find.byKey(
      const Key('app-desktop-command-surface'),
    );
    final bottomNavigation = find.byKey(const Key('app-bottom-nav'));
    final attentionAction = find.byKey(
      const Key('sessions-workspace-attention'),
    );
    final settingsAction = find.byKey(
      const Key('sessions-workspace-settings'),
    );
    final newSessionAction = find.byKey(
      const Key('sessions-workspace-global-new'),
    );

    expect(
      removedDesktopSurface,
      findsNothing,
      reason: 'the deleted permanent command surface must not return',
    );

    if (width >= 840) {
      expect(
        attentionAction,
        findsOneWidget,
        reason:
            'wide (>=840dp, width=$width) should expose the contextual '
            'Attention action',
      );
      expect(settingsAction, findsOneWidget);
      expect(newSessionAction, findsOneWidget);
      expect(
        bottomNavigation,
        findsNothing,
        reason:
            'wide (>=840dp, width=$width) should not render compact '
            'bottom navigation',
      );
    } else {
      expect(
        bottomNavigation,
        findsOneWidget,
        reason:
            'compact/medium (<840dp, width=$width) should retain bottom '
            'navigation',
      );
      expect(attentionAction, findsNothing);
      expect(settingsAction, findsNothing);
      expect(newSessionAction, findsNothing);
    }
  });
}
