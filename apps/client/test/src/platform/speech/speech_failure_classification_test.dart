import 'package:cosyncing_client/src/platform/speech/speech_failure_classification.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('classifySpeechFailureSignal', () {
    void expectKind(String signal, SpeechInputFailureKind kind) {
      expect(
        classifySpeechFailureSignal(signal),
        kind,
        reason: 'signal "$signal"',
      );
    }

    test('maps browser DOM exception names', () {
      expectKind('InvalidStateError', SpeechInputFailureKind.alreadyActive);
      expectKind('NotAllowedError', SpeechInputFailureKind.permissionDenied);
      expectKind('SecurityError', SpeechInputFailureKind.secureContext);
      expectKind('NotFoundError', SpeechInputFailureKind.noCaptureDevice);
      expectKind('NetworkError', SpeechInputFailureKind.network);
      expectKind('AbortError', SpeechInputFailureKind.startFailed);
    });

    test('maps plugin/web error codes', () {
      expectKind('error_permission', SpeechInputFailureKind.permissionDenied);
      expectKind('not-allowed', SpeechInputFailureKind.permissionDenied);
      expectKind('audio-capture', SpeechInputFailureKind.noCaptureDevice);
      expectKind('error_network', SpeechInputFailureKind.network);
      expectKind('error_no_match', SpeechInputFailureKind.noSpeech);
      expectKind('no-speech', SpeechInputFailureKind.noSpeech);
      expectKind('error_busy', SpeechInputFailureKind.recognizerBusy);
    });

    test('service-not-allowed is service, not permission', () {
      // `service-not-allowed` contains `not-allowed`; the service family must
      // win so a transient service error is not shown as a permission denial.
      expectKind(
        'service-not-allowed',
        SpeechInputFailureKind.serviceUnavailable,
      );
    });

    test('an unknown code falls back to startFailed', () {
      expectKind(
        'error_language_unavailable',
        SpeechInputFailureKind.startFailed,
      );
    });

    test('every kind has a non-empty default reason', () {
      for (final kind in SpeechInputFailureKind.values) {
        expect(defaultSpeechFailureReason(kind), isNotEmpty);
      }
      // The network reason keeps the wording other surfaces assert on.
      expect(
        defaultSpeechFailureReason(SpeechInputFailureKind.network),
        contains('platform service'),
      );
    });
  });
}
