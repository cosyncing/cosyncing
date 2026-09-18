import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/pairing/controller/installer_pairing_handoff_controller.dart';
import 'package:cosyncing_client/src/features/pairing/view/installer_pairing_startup_barrier.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('shows progress instead of its child while pairing', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          installerPairingInProgressProvider.overrideWith((ref) => true),
        ],
        child: const _TestApp(),
      ),
    );

    expect(
      find.byKey(const Key('installer-pairing-startup-barrier')),
      findsOne,
    );
    expect(find.text('Finishing setup…'), findsOne);
    expect(find.text('routed content'), findsNothing);
  });

  testWidgets('shows its child when startup pairing is idle', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: _TestApp()),
    );
    await tester.pump();

    expect(find.text('routed content'), findsOne);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('blocks the child during the initial asynchronous read', (
    tester,
  ) async {
    final outcome = Completer<InstallerPairingHandoffOutcome>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          installerPairingHandoffProvider.overrideWith(
            (ref) => outcome.future,
          ),
        ],
        child: const _TestApp(),
      ),
    );

    expect(
      find.byKey(const Key('installer-pairing-startup-barrier')),
      findsOne,
    );
    expect(find.text('routed content'), findsNothing);

    outcome.complete(InstallerPairingHandoffOutcome.absent);
    await tester.pump();
    expect(find.text('routed content'), findsOne);
  });

  testWidgets('explains a secure-storage failure and retains retry', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          installerPairingHandoffProvider.overrideWith(
            (ref) async =>
                InstallerPairingHandoffOutcome.secureStorageUnavailable,
          ),
        ],
        child: const _TestApp(),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('installer-pairing-storage-error')), findsOne);
    expect(find.text('Couldn’t save secure access'), findsOne);
    expect(find.text('Try again'), findsOne);
    expect(find.text('routed content'), findsNothing);
  });

  testWidgets('explains a handoff claim failure and offers retry', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          installerPairingHandoffProvider.overrideWith(
            (ref) async => InstallerPairingHandoffOutcome.discardFailed,
          ),
        ],
        child: const _TestApp(),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('installer-pairing-discard-error')), findsOne);
    expect(find.text('Couldn’t secure the setup request'), findsOne);
    expect(find.text('Try again'), findsOne);
    expect(find.text('routed content'), findsNothing);
  });

  testWidgets('explains a consumed offer failure before manual sign-in', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          installerPairingHandoffProvider.overrideWith(
            (ref) async => InstallerPairingHandoffOutcome.failed,
          ),
        ],
        child: const _TestApp(),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('installer-pairing-import-error')), findsOne);
    expect(find.text('Automatic setup didn’t finish'), findsOne);
    expect(find.text('Continue to sign in'), findsOne);
    expect(find.text('routed content'), findsNothing);

    await tester.tap(find.text('Continue to sign in'));
    await tester.pump();
    expect(find.text('routed content'), findsOne);
  });
}

class _TestApp extends StatelessWidget {
  const _TestApp();

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: InstallerPairingStartupBarrier(
        child: Text('routed content'),
      ),
    );
  }
}
