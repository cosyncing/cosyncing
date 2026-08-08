import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/features/voice/view/voice_input_panel.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

VoiceInputState _state({
  SpeechInputState inputState = const SpeechInputListening(),
  List<double> samples = const [],
  SpeechRecognitionPolicy? chosenPolicy,
}) {
  return VoiceInputState(
    inputState: inputState,
    capabilities: const SpeechInputCapabilities(
      recognition: true,
      onDeviceRecognition: true,
      soundLevelEvents: true,
    ),
    soundLevelHistory: samples,
    chosenPolicy: chosenPolicy,
  );
}

void main() {
  group('VoiceInputPanel', () {
    testWidgets('shows waveform when samples exist', (tester) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(samples: [0.2, 0.5, 0.8, 0.3]),
              onStop: () {},
              onCancel: () {},
            ),
          ),
        ),
      );
      expect(find.byKey(const Key('voice-input-waveform')), findsOneWidget);
    });

    testWidgets('shows static listening indicator when no samples', (
      tester,
    ) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(samples: []),
              onStop: () {},
              onCancel: () {},
            ),
          ),
        ),
      );
      expect(find.text('Listening…'), findsOneWidget);
      expect(find.byKey(const Key('voice-input-waveform')), findsNothing);
    });

    testWidgets('shows finalizing text when processing with no samples', (
      tester,
    ) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(
                inputState: const SpeechInputProcessing(),
                samples: [],
              ),
              onStop: () {},
              onCancel: () {},
            ),
          ),
        ),
      );
      expect(find.text('Finalizing…'), findsOneWidget);
    });

    testWidgets('shows partial transcript', (tester) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(
                inputState: const SpeechInputListening(
                  partialTranscript: 'hello',
                ),
              ),
              onStop: () {},
              onCancel: () {},
            ),
          ),
        ),
      );
      expect(find.text('hello'), findsOneWidget);
    });

    testWidgets('stop and cancel buttons have stable keys and tooltips', (
      tester,
    ) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(),
              onStop: () {},
              onCancel: () {},
            ),
          ),
        ),
      );
      final stopButton = find.byKey(const Key('voice-input-stop'));
      final cancelButton = find.byKey(const Key('voice-input-cancel'));
      expect(stopButton, findsOneWidget);
      expect(cancelButton, findsOneWidget);
      expect(
        tester.widget<IconButton>(stopButton).tooltip,
        'Stop',
      );
      expect(
        tester.widget<IconButton>(cancelButton).tooltip,
        'Cancel',
      );
    });

    testWidgets('stop is disabled when processing', (tester) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(
                inputState: const SpeechInputProcessing(),
              ),
              onStop: () {},
              onCancel: () {},
            ),
          ),
        ),
      );
      final stopButton = tester.widget<IconButton>(
        find.byKey(const Key('voice-input-stop')),
      );
      expect(stopButton.onPressed, isNull);
    });

    testWidgets('stop callback fires', (tester) async {
      var stopCalled = false;
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(),
              onStop: () => stopCalled = true,
              onCancel: () {},
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('voice-input-stop')));
      expect(stopCalled, isTrue);
    });

    testWidgets('cancel callback fires', (tester) async {
      var cancelCalled = false;
      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: VoiceInputPanel(
              state: _state(),
              onStop: () {},
              onCancel: () => cancelCalled = true,
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('voice-input-cancel')));
      expect(cancelCalled, isTrue);
    });

    testWidgets('no layout overflow at 360px width', (tester) async {
      tester.view.physicalSize = const Size(360 * 3, 800 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        _localizedApp(
          home: Scaffold(
            body: SizedBox(
              width: 360,
              child: VoiceInputPanel(
                state: _state(
                  samples: List.generate(60, (i) => 0.3 + (i % 5) * 0.1),
                  inputState: const SpeechInputListening(
                    partialTranscript:
                        'A long partial transcript that might overflow',
                  ),
                ),
                onStop: () {},
                onCancel: () {},
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('showVoicePolicyChooser', () {
    testWidgets('shows on-device option when available', (tester) async {
      SpeechRecognitionPolicy? result;
      await tester.pumpWidget(
        _localizedApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
                onPressed: () async {
                  result = await showVoicePolicyChooser(
                    context,
                    onDeviceAvailable: true,
                  );
                },
                child: const Text('show'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('show'));
      await tester.pumpAndSettle();
      expect(find.text('On device only'), findsOneWidget);
      expect(find.text('Allow device speech service'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      await tester.tap(find.text('On device only'));
      await tester.pumpAndSettle();
      expect(result, SpeechRecognitionPolicy.onDeviceOnly);
    });

    testWidgets('hides on-device option when not available', (tester) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
                onPressed: () => showVoicePolicyChooser(
                  context,
                  onDeviceAvailable: false,
                ),
                child: const Text('show'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('show'));
      await tester.pumpAndSettle();
      expect(find.text('On device only'), findsNothing);
      expect(find.text('Allow device speech service'), findsOneWidget);
    });

    testWidgets('cancel returns null', (tester) async {
      SpeechRecognitionPolicy? result = SpeechRecognitionPolicy.onDeviceOnly;
      await tester.pumpWidget(
        _localizedApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
                onPressed: () async {
                  result = await showVoicePolicyChooser(
                    context,
                    onDeviceAvailable: true,
                  );
                },
                child: const Text('show'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('show'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(result, isNull);
    });

    testWidgets('allow platform service returns correct policy', (
      tester,
    ) async {
      SpeechRecognitionPolicy? result;
      await tester.pumpWidget(
        _localizedApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
                onPressed: () async {
                  result = await showVoicePolicyChooser(
                    context,
                    onDeviceAvailable: true,
                  );
                },
                child: const Text('show'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('show'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Allow device speech service'));
      await tester.pumpAndSettle();
      expect(result, SpeechRecognitionPolicy.platformServiceAllowed);
    });

    testWidgets('disclosure text mentions online processing', (tester) async {
      await tester.pumpWidget(
        _localizedApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
                onPressed: () => showVoicePolicyChooser(
                  context,
                  onDeviceAvailable: true,
                ),
                child: const Text('show'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('show'));
      await tester.pumpAndSettle();
      expect(find.textContaining('online'), findsOneWidget);
    });
  });
}

Widget _localizedApp({required Widget home}) {
  return MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: home,
  );
}
