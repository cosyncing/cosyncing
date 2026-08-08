import 'package:cosyncing_client/src/app/app.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/view/sessions_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('app shell renders on device', (tester) async {
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

    expect(find.byType(App), findsOneWidget);
    expect(find.byType(MaterialApp), findsOneWidget);

    // The Sessions destination is width-adaptive: Expanded (>=840dp) shows the
    // two-pane SessionsWorkspace, which has no AppBar; Compact/Medium show the
    // single-pane SessionsPage with an AppBar titled "Sessions". Assert the
    // layout that matches this device's logical width.
    final logicalWidth =
        tester.view.physicalSize.width / tester.view.devicePixelRatio;
    if (WindowSizeClass.fromWidth(logicalWidth).showListDetail) {
      expect(find.byType(SessionsWorkspace), findsOneWidget);
    } else {
      expect(
        find.descendant(
          of: find.byType(AppBar),
          matching: find.text('Sessions'),
        ),
        findsOneWidget,
      );
    }
  });
}
