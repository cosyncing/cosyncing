import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/features/voice/view/voice_waveform.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:flutter/material.dart';

/// Compact full-width voice panel shown below the composer row while
/// listening or processing.
///
/// Shows a real waveform (or a static listening indicator when no level
/// events exist), the latest partial transcript, and Stop/Cancel icon
/// buttons. The panel is an unframed inner section - it does not add a nested
/// card.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Composer UX").
class VoiceInputPanel extends StatelessWidget {
  /// Creates a voice input panel.
  const VoiceInputPanel({
    required this.state,
    required this.onStop,
    required this.onCancel,
    super.key,
  });

  /// The current voice-input state.
  final VoiceInputState state;

  /// Callback when the user taps Stop (finalize transcript).
  final VoidCallback onStop;

  /// Callback when the user taps Cancel (discard).
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final color = theme.colorScheme.primary;
    final samples = state.soundLevelHistory;
    final isProcessing = state.isProcessing;

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Waveform or static listening indicator.
          if (samples.isNotEmpty)
            VoiceWaveform(
              key: const Key('voice-input-waveform'),
              samples: samples,
              color: color,
            )
          else
            SizedBox(
              height: VoiceWaveform.height,
              child: Center(
                child: SelectableText(
                  isProcessing ? l10n.voiceFinalizing : l10n.voiceListening,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  semanticsLabel: isProcessing
                      ? l10n.voiceFinalizingSemantics
                      : l10n.voiceListeningSemantics,
                ),
              ),
            ),
          if (state.partialTranscript.isNotEmpty) ...[
            const SizedBox(height: 4),
            SelectionArea(
              child: Text(
                state.partialTranscript,
                style: theme.textTheme.bodyMedium,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              IconButton(
                key: const Key('voice-input-stop'),
                icon: const Icon(Icons.stop),
                tooltip: l10n.stop,
                onPressed: isProcessing ? null : onStop,
              ),
              IconButton(
                key: const Key('voice-input-cancel'),
                icon: const Icon(Icons.close),
                tooltip: l10n.cancel,
                onPressed: onCancel,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Shows the first-use recognition-policy disclosure dialog.
///
/// The copy clearly states that the platform speech service may process audio
/// online. "On device only" is offered only when [onDeviceAvailable] is true
/// (conservatively Android/iOS/macOS). "Allow platform service" and "Cancel"
/// are always offered.
///
/// Returns the chosen policy, or `null` when the user cancels.
Future<SpeechRecognitionPolicy?> showVoicePolicyChooser(
  BuildContext context, {
  required bool onDeviceAvailable,
}) {
  final l10n = AppLocalizations.of(context);
  return showDialog<SpeechRecognitionPolicy>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(l10n.voiceInputTitle),
      content: SelectableText(l10n.voicePolicyBody),
      actions: [
        if (onDeviceAvailable)
          TextButton(
            key: const Key('voice-policy-on-device'),
            onPressed: () => Navigator.of(context).pop(
              SpeechRecognitionPolicy.onDeviceOnly,
            ),
            child: Text(l10n.voiceOnDeviceOnly),
          ),
        TextButton(
          key: const Key('voice-policy-platform-service'),
          onPressed: () => Navigator.of(context).pop(
            SpeechRecognitionPolicy.platformServiceAllowed,
          ),
          child: Text(l10n.voiceAllowPlatformService),
        ),
        TextButton(
          key: const Key('voice-policy-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
      ],
    ),
  );
}
