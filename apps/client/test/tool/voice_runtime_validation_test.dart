import 'package:flutter_test/flutter_test.dart';

import '../../tool/src/voice_runtime_review_html.dart';
import '../../tool/voice_runtime_validation.dart' as runtime;

void main() {
  group('voice runtime evidence', () {
    test('defines distinct complete target checklists', () {
      final android = runtime.observationsForVoiceRuntimeTarget(
        runtime.VoiceRuntimeTarget.android,
      );
      final web = runtime.observationsForVoiceRuntimeTarget(
        runtime.VoiceRuntimeTarget.web,
      );
      final windows = runtime.observationsForVoiceRuntimeTarget(
        runtime.VoiceRuntimeTarget.windows,
      );

      expect(android.map((item) => item.id), contains('on_device_only_policy'));
      expect(web.map((item) => item.id), contains('refresh_reconnect_cleanup'));
      expect(windows.map((item) => item.id), contains('beta_asr_capability'));
      for (final observations in [android, web, windows]) {
        expect(observations, isNotEmpty);
        expect(
          observations.map((item) => item.id).toSet(),
          hasLength(observations.length),
        );
      }
    });

    test('requires HTTPS for web evidence', () {
      expect(
        runtime.isSecureVoiceWebUri(Uri.parse('https://broker.example/cosy/')),
        isTrue,
      );
      expect(
        runtime.isSecureVoiceWebUri(Uri.parse('https://broker.example/')),
        isFalse,
      );
      expect(
        runtime.isSecureVoiceWebUri(Uri.parse('http://localhost:7734/cosy/')),
        isFalse,
      );
      expect(runtime.isSecureVoiceWebUri(Uri.parse('file:///cosy/')), isFalse);
    });

    test('parses all supported target names', () {
      expect(
        runtime.parseVoiceRuntimeTarget('ANDROID'),
        runtime.VoiceRuntimeTarget.android,
      );
      expect(
        runtime.parseVoiceRuntimeTarget('web'),
        runtime.VoiceRuntimeTarget.web,
      );
      expect(
        runtime.parseVoiceRuntimeTarget('windows'),
        runtime.VoiceRuntimeTarget.windows,
      );
      expect(
        () => runtime.parseVoiceRuntimeTarget('macos'),
        throwsFormatException,
      );
    });

    test('prefers a native launcher over a Windows shell script', () {
      expect(
        runtime.selectVoiceRuntimeExecutablePath(
          <String>[
            r'C:\tools\flutter\bin\flutter',
            r'C:\tools\flutter\bin\flutter.bat',
          ],
          windows: true,
        ),
        r'C:\tools\flutter\bin\flutter.bat',
      );
      expect(
        runtime.selectVoiceRuntimeExecutablePath(
          <String>['/opt/flutter/bin/flutter'],
          windows: false,
        ),
        '/opt/flutter/bin/flutter',
      );
    });

    test('requires successful non-empty Visual Studio component evidence', () {
      expect(
        runtime.isVisualStudioComponentInstalled(
          exitCode: 0,
          installationPath: r'C:\Program Files (x86)\Microsoft Visual Studio',
        ),
        isTrue,
      );
      expect(
        runtime.isVisualStudioComponentInstalled(
          exitCode: 1,
          installationPath: r'C:\Visual Studio',
        ),
        isFalse,
      );
      expect(
        runtime.isVisualStudioComponentInstalled(
          exitCode: 0,
          installationPath: '   ',
        ),
        isFalse,
      );
    });

    test('accepts complete not-run Android evidence', () {
      final evidence = _evidence(runtime.VoiceRuntimeTarget.android);

      expect(runtime.validateVoiceRuntimeEvidence(evidence), isEmpty);
      expect(evidence['overallStatus'], 'NOT_RUN');
    });

    test('rejects missing checks and pass without an observation note', () {
      final evidence = _evidence(runtime.VoiceRuntimeTarget.windows);
      final observations = evidence['observations']! as Map<String, Object?>;
      ((observations..remove('beta_asr_capability')).values.first!
            as Map<String, Object?>)
        ..['status'] = 'PASS'
        ..['note'] = '';

      expect(
        runtime.validateVoiceRuntimeEvidence(evidence),
        containsAll(<String>[
          'observations.beta_asr_capability is required.',
          <String>[
            'observations.app_launch.note must describe the observation',
            'or why it was not run.',
          ].join(' '),
        ]),
      );
    });

    test('rejects aggregate pass when preflight was not ready', () {
      final evidence = _evidence(runtime.VoiceRuntimeTarget.web);
      final observations = evidence['observations']! as Map<String, Object?>;
      for (final value in observations.values) {
        final observation = value! as Map<String, Object?>;
        observation['status'] = 'PASS';
        observation['note'] = 'Observed explicitly on the target runtime.';
      }
      evidence['overallStatus'] = runtime.computeVoiceRuntimeOverallStatus(
        observations,
      );

      expect(
        runtime.validateVoiceRuntimeEvidence(evidence),
        contains('overallStatus cannot be PASS when preflight is not READY.'),
      );
    });

    test('rejects ready preflight with a skipped check', () {
      final evidence = _evidence(runtime.VoiceRuntimeTarget.android);
      final preflight = evidence['preflight']! as Map<String, Object?>;
      preflight['status'] = 'READY';

      expect(
        runtime.validateVoiceRuntimeEvidence(evidence),
        contains('preflight.status must be NOT_READY for its checks.'),
      );
    });

    test('renders a self-contained human review page from evidence', () {
      final evidence = _evidence(runtime.VoiceRuntimeTarget.windows);
      final html = renderVoiceRuntimeReviewHtml(
        evidence,
        sourceEvidence: r'C:\evidence\windows-preflight.json',
      );

      expect(html, startsWith('<!doctype html>'));
      expect(html, contains('Voice runtime review'));
      expect(html, contains('beta_asr_capability'));
      expect(html, contains('Export evidence JSON'));
      expect(html, contains('sourceEvidence'));
      expect(html, contains('never records audio'));
      expect(
        html,
        contains(r"JSON.stringify(result, null, 2) + '\n'"),
      );
      expect(html, contains(r"lines.join('\n')"));
      expect(html, isNot(contains('https://')));
    });

    test('escapes embedded evidence that could close a script tag', () {
      final evidence = _evidence(runtime.VoiceRuntimeTarget.web);
      evidence['operator'] = '</script><script>alert(1)</script>';

      final html = renderVoiceRuntimeReviewHtml(
        evidence,
        sourceEvidence: '</script>',
      );

      expect(html, isNot(contains('</script><script>alert(1)</script>')));
      expect(html, contains(r'\u003c/script\u003e'));
    });
  });
}

Map<String, Object?> _evidence(runtime.VoiceRuntimeTarget target) {
  final observations = <String, Object?>{
    for (final definition in runtime.observationsForVoiceRuntimeTarget(target))
      definition.id: <String, Object?>{
        'description': definition.description,
        'status': 'NOT_RUN',
        'note': 'Runtime observation not recorded.',
      },
  };
  return <String, Object?>{
    'schemaVersion': runtime.voiceRuntimeEvidenceSchemaVersion,
    'target': runtime.voiceRuntimeTargetName(target),
    'createdAt': '2026-07-13T12:00:00Z',
    'updatedAt': '2026-07-13T12:00:00Z',
    'operator': 'tester',
    'appVersion': '1.0.0+1',
    'environment': <String, Object?>{
      'hostOs': 'test',
      'hostOsVersion': 'test-version',
      'dartVersion': '3.12.2',
      if (target == runtime.VoiceRuntimeTarget.web)
        'url': 'https://broker.example/cosy/',
    },
    'preflight': <String, Object?>{
      'status': 'NOT_READY',
      'checks': <Object?>[
        <String, Object?>{
          'id': 'toolchain',
          'status': 'NOT_RUN',
          'detail': 'Synthetic test fixture.',
        },
      ],
    },
    'overallStatus': 'NOT_RUN',
    'observations': observations,
  };
}
