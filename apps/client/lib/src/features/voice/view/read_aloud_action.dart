import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_controller.dart';
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Manual read-aloud action for a final `model-output` message.
///
/// Shows a speaker icon only after a canonical `model-output` frame with
/// `final: true`, non-empty complete text, a stable identity, and when TTS
/// synthesis is available. While this message owns playback, shows compact
/// pause/resume (where supported) plus stop. Errors show a compact indicator
/// with both a retry affordance and a Stop button (Stop is always available by
/// product requirement, even in a scoped error state where silence was never
/// confirmed). Never auto-starts.
///
/// When hidden (not eligible, not newest, or synthesis unavailable) this widget
/// is a zero-height [SizedBox.shrink] with no padding. When visible, it owns
/// its own top padding so the parent layout never adds an invisible gap.
///
/// Pass [isNewestForIdentity] `true` only for the newest eligible frame sharing
/// this message's resolved identity; older duplicates hide the action.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Final-message read-aloud").
class ReadAloudAction extends ConsumerWidget {
  /// Creates a read-aloud action for [message].
  const ReadAloudAction({
    required this.message,
    required this.isNewestForIdentity,
    this.showIdleAction = true,
    super.key,
  });

  /// The message this action belongs to.
  final AgentMessage message;

  /// Whether this message is the newest eligible frame for its identity.
  final bool isNewestForIdentity;

  /// Whether the idle "Read aloud" button renders.
  ///
  /// The chat transcript passes `false`: starting playback lives in the
  /// per-message context menu there, so an idle 48px button on every model
  /// message is pure clutter. Live playback and error-retry controls still
  /// render — they are transient and need an inline stop.
  final bool showIdleAction;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    if (!isReadAloudEligible(message)) return const SizedBox.shrink();
    if (!isNewestForIdentity) return const SizedBox.shrink();

    final identity = resolveReadAloudIdentity(message)!;
    final state = ref.watch(readAloudControllerProvider);

    if (!state.capabilities.synthesis) return const SizedBox.shrink();

    final activeKey = state.activeMessageKey;
    final isActive = activeKey == identity;

    if (isActive) {
      return _padded(
        _PlaybackControls(
          identity: identity,
          isPaused: state.isPaused,
          canPauseResume: state.capabilities.pauseResume,
          onPause: () => ref.read(readAloudControllerProvider.notifier).pause(),
          onResume: () =>
              ref.read(readAloudControllerProvider.notifier).resume(),
          onStop: () => ref.read(readAloudControllerProvider.notifier).stop(),
        ),
      );
    }

    final outputState = state.outputState;
    if (outputState is SpeechOutputError &&
        outputState.messageKey == identity) {
      return _padded(
        _ErrorRetryRow(
          identity: identity,
          onRetry: () => ref
              .read(readAloudControllerProvider.notifier)
              .speakForMessage(message),
          onStop: () => ref.read(readAloudControllerProvider.notifier).stop(),
        ),
      );
    }

    if (!showIdleAction) return const SizedBox.shrink();

    return _padded(
      IconButton(
        key: ValueKey('read-aloud-$identity'),
        icon: const Icon(Icons.volume_up_outlined),
        tooltip: l10n.readAloud,
        onPressed: () => ref
            .read(readAloudControllerProvider.notifier)
            .speakForMessage(message),
      ),
    );
  }

  /// Wraps [child] in a top-padded container so the action owns its spacing.
  /// Hidden states return [SizedBox.shrink] directly (no padding).
  Widget _padded(Widget child) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: child,
    );
  }
}

class _PlaybackControls extends StatelessWidget {
  const _PlaybackControls({
    required this.identity,
    required this.isPaused,
    required this.canPauseResume,
    required this.onPause,
    required this.onResume,
    required this.onStop,
  });

  final String identity;
  final bool isPaused;
  final bool canPauseResume;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (canPauseResume)
          IconButton(
            key: ValueKey('read-aloud-pause-$identity'),
            icon: Icon(isPaused ? Icons.play_arrow : Icons.pause),
            tooltip: isPaused ? l10n.resume : l10n.pause,
            onPressed: isPaused ? onResume : onPause,
          ),
        IconButton(
          key: ValueKey('read-aloud-stop-$identity'),
          icon: const Icon(Icons.stop),
          tooltip: l10n.stop,
          onPressed: onStop,
        ),
      ],
    );
  }
}

class _ErrorRetryRow extends StatelessWidget {
  const _ErrorRetryRow({
    required this.identity,
    required this.onRetry,
    required this.onStop,
  });

  final String identity;
  final VoidCallback onRetry;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(right: 4),
          child: Icon(
            Icons.error_outline,
            size: 16,
            color: theme.colorScheme.error,
          ),
        ),
        IconButton(
          key: ValueKey('read-aloud-$identity'),
          icon: const Icon(Icons.volume_up_outlined),
          tooltip: l10n.readAloudRetry,
          onPressed: onRetry,
        ),
        IconButton(
          key: ValueKey('read-aloud-stop-$identity'),
          icon: const Icon(Icons.stop),
          tooltip: l10n.stop,
          onPressed: onStop,
        ),
      ],
    );
  }
}
