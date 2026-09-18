import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/pairing/controller/installer_pairing_handoff_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final _installerPairingFailureDismissedProvider = StateProvider<bool>(
  (ref) => false,
);

/// Defers authentication UI while an installer handoff is being completed.
class InstallerPairingStartupBarrier extends ConsumerWidget {
  /// Creates the startup pairing barrier around [child].
  const InstallerPairingStartupBarrier({required this.child, super.key});

  /// The routed application shown after startup pairing finishes.
  final Widget? child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final handoff = ref.watch(installerPairingHandoffProvider);
    final outcome = handoff.valueOrNull;
    if (outcome == InstallerPairingHandoffOutcome.secureStorageUnavailable ||
        outcome == InstallerPairingHandoffOutcome.discardFailed) {
      final l10n = AppLocalizations.of(context);
      final discardFailed =
          outcome == InstallerPairingHandoffOutcome.discardFailed;
      return Scaffold(
        key: Key(
          discardFailed
              ? 'installer-pairing-discard-error'
              : 'installer-pairing-storage-error',
        ),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      discardFailed
                          ? l10n.installerPairingDiscardTitle
                          : l10n.installerPairingStorageTitle,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      discardFailed
                          ? l10n.installerPairingDiscardBody
                          : l10n.installerPairingStorageBody,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: () =>
                          ref.invalidate(installerPairingHandoffProvider),
                      child: Text(l10n.installerPairingRetry),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }
    final failureDismissed = ref.watch(
      _installerPairingFailureDismissedProvider,
    );
    if (outcome == InstallerPairingHandoffOutcome.failed && !failureDismissed) {
      final l10n = AppLocalizations.of(context);
      return Scaffold(
        key: const Key('installer-pairing-import-error'),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      l10n.installerPairingFailedTitle,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      l10n.installerPairingFailedBody,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: () {
                        ref
                                .read(
                                  _installerPairingFailureDismissedProvider
                                      .notifier,
                                )
                                .state =
                            true;
                      },
                      child: Text(l10n.installerPairingContinue),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }
    if (!handoff.isLoading && !ref.watch(installerPairingInProgressProvider)) {
      return child ?? const SizedBox.shrink();
    }

    final l10n = AppLocalizations.of(context);
    return Scaffold(
      key: const Key('installer-pairing-startup-barrier'),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const CircularProgressIndicator(),
                  const SizedBox(height: 16),
                  Text(
                    l10n.installerPairingFinishingTitle,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    l10n.installerPairingFinishingBody,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
