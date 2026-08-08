import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'src/voice_runtime_review_html.dart';

/// Version of the runtime evidence document written by this tool.
const int voiceRuntimeEvidenceSchemaVersion = 1;

/// Runtime targets covered by the non-Apple V3 validation pass.
enum VoiceRuntimeTarget { android, web, windows }

/// One runtime behavior that an operator must observe explicitly.
class VoiceRuntimeObservationDefinition {
  /// Creates an observation definition.
  const VoiceRuntimeObservationDefinition(this.id, this.description);

  /// Stable machine-readable identifier.
  final String id;

  /// Concrete behavior the operator must check.
  final String description;
}

const Map<VoiceRuntimeTarget, List<VoiceRuntimeObservationDefinition>>
_observations = {
  VoiceRuntimeTarget.android: [
    VoiceRuntimeObservationDefinition(
      'app_launch',
      'The packaged app launches on the recorded Android device and opens a '
          'connected session.',
    ),
    VoiceRuntimeObservationDefinition(
      'tts_completed_message',
      'Read aloud appears only on a completed assistant message and speaks '
          'that completed message through the platform TTS engine.',
    ),
    VoiceRuntimeObservationDefinition(
      'tts_stop',
      'Stop ends active read-aloud playback and the UI returns to idle.',
    ),
    VoiceRuntimeObservationDefinition(
      'microphone_permission_grant',
      'First voice use requests microphone permission and recognition starts '
          'after permission is granted.',
    ),
    VoiceRuntimeObservationDefinition(
      'microphone_permission_denial_recovery',
      'Permission denial is visible and a later permitted attempt recovers '
          'without restarting the app.',
    ),
    VoiceRuntimeObservationDefinition(
      'on_device_only_policy',
      'On-device-only recognition either runs without network fallback or is '
          'rejected with an actionable unavailable state.',
    ),
    VoiceRuntimeObservationDefinition(
      'platform_service_disclosure',
      'The first-use chooser discloses possible platform-service processing '
          'before platform-service recognition is allowed.',
    ),
    VoiceRuntimeObservationDefinition(
      'asr_partial_final_draft',
      'Partial speech text is shown while listening; after Stop, only the '
          'final transcript is inserted into the draft and is not sent.',
    ),
    VoiceRuntimeObservationDefinition(
      'waveform_real_levels',
      'The waveform changes with real microphone sound-level callbacks rather '
          'than running as a decorative animation.',
    ),
    VoiceRuntimeObservationDefinition(
      'audio_focus_handoff',
      'Starting voice input while TTS is speaking stops TTS before recognition '
          'begins.',
    ),
    VoiceRuntimeObservationDefinition(
      'background_cancellation',
      'Backgrounding or leaving the session cancels active recognition and '
          'does not insert a late transcript.',
    ),
  ],
  VoiceRuntimeTarget.web: [
    VoiceRuntimeObservationDefinition(
      'app_launch_secure_origin',
      'The production /cosy/ build opens from the recorded HTTPS origin and '
          'connects to a session.',
    ),
    VoiceRuntimeObservationDefinition(
      'secure_context_feature_detection',
      'The page is a secure context and voice controls reflect actual Web '
          'Speech feature availability.',
    ),
    VoiceRuntimeObservationDefinition(
      'tts_completed_message',
      'Read aloud appears only on a completed assistant message and browser '
          'speech synthesis speaks that completed message.',
    ),
    VoiceRuntimeObservationDefinition(
      'tts_stop',
      'Stop ends active browser speech synthesis and the UI returns to idle.',
    ),
    VoiceRuntimeObservationDefinition(
      'microphone_permission_grant',
      'The browser permission prompt is handled and recognition starts after '
          'microphone permission is granted.',
    ),
    VoiceRuntimeObservationDefinition(
      'microphone_permission_denial_recovery',
      'Permission denial is visible and recognition can recover after the '
          'site permission is restored.',
    ),
    VoiceRuntimeObservationDefinition(
      'platform_service_disclosure',
      'The first-use chooser discloses possible browser/platform-service '
          'processing before recognition is allowed.',
    ),
    VoiceRuntimeObservationDefinition(
      'asr_partial_final_draft',
      'Partial speech text is shown while listening; after Stop, only the '
          'final transcript is inserted into the draft and is not sent.',
    ),
    VoiceRuntimeObservationDefinition(
      'waveform_real_levels',
      'The waveform changes with real microphone sound-level callbacks rather '
          'than running as a decorative animation.',
    ),
    VoiceRuntimeObservationDefinition(
      'refresh_reconnect_cleanup',
      'Refreshing or reconnecting cancels speech activity and does not '
          'autoplay or insert a stale transcript.',
    ),
    VoiceRuntimeObservationDefinition(
      'unsupported_asr_fallback',
      'When Web Speech recognition is unavailable, voice input is disabled '
          'without affecting text chat or TTS.',
    ),
  ],
  VoiceRuntimeTarget.windows: [
    VoiceRuntimeObservationDefinition(
      'app_launch',
      'The Windows desktop build launches natively and opens a connected '
          'session.',
    ),
    VoiceRuntimeObservationDefinition(
      'tts_completed_message',
      'Read aloud appears only on a completed assistant message and speaks '
          'that completed message with the Windows default voice.',
    ),
    VoiceRuntimeObservationDefinition(
      'tts_stop',
      'Stop ends active Windows TTS playback and the UI returns to idle.',
    ),
    VoiceRuntimeObservationDefinition(
      'beta_asr_capability',
      'The beta Windows recognition adapter reports its real capability '
          'without promising unavailable behavior.',
    ),
    VoiceRuntimeObservationDefinition(
      'microphone_permission_recovery',
      'Permission or recognizer errors are visible and a later valid attempt '
          'can recover without restarting the app.',
    ),
    VoiceRuntimeObservationDefinition(
      'platform_service_disclosure',
      'The first-use chooser discloses possible platform-service processing '
          'before recognition is allowed.',
    ),
    VoiceRuntimeObservationDefinition(
      'asr_partial_final_draft',
      'If recognition is supported, partial text and final draft insertion '
          'work and recognition never sends the draft automatically.',
    ),
    VoiceRuntimeObservationDefinition(
      'waveform_or_honest_unavailable',
      'Sound-level callbacks drive the waveform, or their absence is shown '
          'honestly as a static listening state.',
    ),
    VoiceRuntimeObservationDefinition(
      'unsupported_asr_fallback',
      'On a Windows installation without recognition support, voice input is '
          'unavailable while text chat and TTS remain usable.',
    ),
  ],
};

/// Parses a supported runtime target name.
VoiceRuntimeTarget parseVoiceRuntimeTarget(String value) {
  return switch (value.toLowerCase()) {
    'android' => VoiceRuntimeTarget.android,
    'web' => VoiceRuntimeTarget.web,
    'windows' => VoiceRuntimeTarget.windows,
    _ => throw FormatException('Unsupported voice runtime target: $value'),
  };
}

/// Returns the wire name for [target].
String voiceRuntimeTargetName(VoiceRuntimeTarget target) => target.name;

/// Returns the complete required observation list for [target].
List<VoiceRuntimeObservationDefinition> observationsForVoiceRuntimeTarget(
  VoiceRuntimeTarget target,
) => List.unmodifiable(_observations[target]!);

/// Whether [uri] satisfies the HTTPS requirement for web runtime evidence.
bool isSecureVoiceWebUri(Uri uri) =>
    uri.scheme == 'https' &&
    uri.hasAuthority &&
    uri.host.isNotEmpty &&
    (uri.path == '/cosy' || uri.path.startsWith('/cosy/'));

/// Selects an executable path from `which`/`where.exe` output.
///
/// Windows archives contain both an extensionless shell script and a `.bat`
/// launcher. The extensionless entry is not a Win32 executable, so a native
/// launcher must take precedence there.
String? selectVoiceRuntimeExecutablePath(
  Iterable<String> paths, {
  required bool windows,
}) {
  final nonEmpty = paths
      .map((path) => path.trim())
      .where((path) => path.isNotEmpty);
  if (!windows) return nonEmpty.firstOrNull;
  return nonEmpty
          .where(
            (path) => const ['.exe', '.com', '.bat', '.cmd'].any(
              (extension) => path.toLowerCase().endsWith(extension),
            ),
          )
          .firstOrNull ??
      nonEmpty.firstOrNull;
}

/// Whether `vswhere` proved that a required Visual Studio component exists.
bool isVisualStudioComponentInstalled({
  required int exitCode,
  required String installationPath,
}) => exitCode == 0 && installationPath.trim().isNotEmpty;

/// Computes the aggregate status from an observations object.
String computeVoiceRuntimeOverallStatus(Map<String, Object?> observations) {
  var hasNotRun = false;
  for (final value in observations.values) {
    if (value is! Map<String, Object?>) return 'FAIL';
    final status = value['status'];
    if (status == 'FAIL') return 'FAIL';
    if (status != 'PASS') hasNotRun = true;
  }
  return hasNotRun ? 'NOT_RUN' : 'PASS';
}

/// Validates one decoded runtime-evidence document.
///
/// An empty result means the document is structurally valid. This validates
/// evidence integrity, not whether an operator's observation was correct.
List<String> validateVoiceRuntimeEvidence(Map<String, Object?> evidence) {
  final errors = <String>[];
  if (evidence['schemaVersion'] != voiceRuntimeEvidenceSchemaVersion) {
    errors.add(
      'schemaVersion must be $voiceRuntimeEvidenceSchemaVersion.',
    );
  }

  VoiceRuntimeTarget? target;
  final targetValue = evidence['target'];
  if (targetValue is String) {
    try {
      target = parseVoiceRuntimeTarget(targetValue);
    } on FormatException {
      errors.add('target must be android, web, or windows.');
    }
  } else {
    errors.add('target must be a string.');
  }

  for (final field in ['createdAt', 'updatedAt']) {
    final value = evidence[field];
    if (value is! String || DateTime.tryParse(value) == null) {
      errors.add('$field must be an ISO-8601 timestamp.');
    }
  }
  for (final field in ['operator', 'appVersion']) {
    final value = evidence[field];
    if (value is! String || value.trim().isEmpty) {
      errors.add('$field must be a non-empty string.');
    }
  }

  final preflight = _stringObjectMap(evidence['preflight']);
  if (preflight == null) {
    errors.add('preflight must be an object.');
  } else {
    final status = preflight['status'];
    if (status != 'READY' && status != 'NOT_READY') {
      errors.add('preflight.status must be READY or NOT_READY.');
    }
    final checks = preflight['checks'];
    if (checks is! List<Object?> || checks.isEmpty) {
      errors.add('preflight.checks must be a non-empty list.');
    } else {
      var allChecksPassed = true;
      for (var index = 0; index < checks.length; index += 1) {
        final check = _stringObjectMap(checks[index]);
        if (check == null) {
          errors.add('preflight.checks[$index] must be an object.');
          allChecksPassed = false;
          continue;
        }
        for (final field in ['id', 'detail']) {
          final value = check[field];
          if (value is! String || value.trim().isEmpty) {
            errors.add(
              'preflight.checks[$index].$field must be a non-empty string.',
            );
          }
        }
        final checkStatus = check['status'];
        if (checkStatus != 'PASS' && checkStatus != 'NOT_RUN') {
          errors.add(
            'preflight.checks[$index].status must be PASS or NOT_RUN.',
          );
          allChecksPassed = false;
        } else if (checkStatus != 'PASS') {
          allChecksPassed = false;
        }
      }
      final expectedStatus = allChecksPassed ? 'READY' : 'NOT_READY';
      if (status != expectedStatus) {
        errors.add('preflight.status must be $expectedStatus for its checks.');
      }
    }
  }

  final environment = _stringObjectMap(evidence['environment']);
  if (environment == null || environment.isEmpty) {
    errors.add('environment must be a non-empty object.');
  } else {
    for (final field in ['hostOs', 'hostOsVersion', 'dartVersion']) {
      final value = environment[field];
      if (value is! String || value.trim().isEmpty) {
        errors.add('environment.$field must be a non-empty string.');
      }
    }
  }

  final observations = _stringObjectMap(evidence['observations']);
  if (observations == null) {
    errors.add('observations must be an object.');
  } else if (target != null) {
    final required = observationsForVoiceRuntimeTarget(
      target,
    ).map((definition) => definition.id).toSet();
    final actual = observations.keys.toSet();
    for (final missing in required.difference(actual)) {
      errors.add('observations.$missing is required.');
    }
    for (final extra in actual.difference(required)) {
      errors.add('observations.$extra is not defined for ${target.name}.');
    }

    for (final entry in observations.entries) {
      final observation = _stringObjectMap(entry.value);
      if (observation == null) {
        errors.add('observations.${entry.key} must be an object.');
        continue;
      }
      final status = observation['status'];
      if (status != 'PASS' && status != 'FAIL' && status != 'NOT_RUN') {
        errors.add(
          'observations.${entry.key}.status must be PASS, FAIL, or NOT_RUN.',
        );
      }
      final note = observation['note'];
      if (note is! String || note.trim().isEmpty) {
        errors.add(
          'observations.${entry.key}.note must describe the observation or '
          'why it was not run.',
        );
      }
      final description = observation['description'];
      final definition = _observations[target]!
          .where((candidate) => candidate.id == entry.key)
          .firstOrNull;
      if (definition != null && description != definition.description) {
        errors.add(
          'observations.${entry.key}.description must match the fixed '
          'checklist.',
        );
      }
    }

    final expectedOverall = computeVoiceRuntimeOverallStatus(observations);
    if (evidence['overallStatus'] != expectedOverall) {
      errors.add('overallStatus must be $expectedOverall.');
    }
    if (expectedOverall == 'PASS' && preflight?['status'] != 'READY') {
      errors.add('overallStatus cannot be PASS when preflight is not READY.');
    }
  }

  if (target == VoiceRuntimeTarget.web) {
    final url = environment?['url'];
    final uri = url is String ? Uri.tryParse(url) : null;
    if (uri == null || !isSecureVoiceWebUri(uri)) {
      errors.add('Web evidence requires an HTTPS environment.url.');
    }
  }

  return errors;
}

Map<String, Object?>? _stringObjectMap(Object? value) {
  if (value is Map<String, Object?>) return value;
  if (value is! Map<Object?, Object?>) return null;
  final result = <String, Object?>{};
  for (final entry in value.entries) {
    final key = entry.key;
    if (key is! String) return null;
    result[key] = entry.value;
  }
  return result;
}

Future<void> main(List<String> arguments) async {
  if (arguments.isEmpty || arguments.contains('--help')) {
    _writeUsage();
    return;
  }

  try {
    final command = arguments.first;
    final options = _parseOptions(arguments.skip(1).toList());
    switch (command) {
      case 'preflight':
        await _runPreflight(options);
      case 'record':
        await _runRecord(options);
      case 'review':
        _runReview(options);
      case 'validate':
        await _runValidate(options);
      case 'launch':
        await _runLaunch(options);
      default:
        throw FormatException('Unknown command: $command');
    }
  } on FormatException catch (error) {
    stderr.writeln('ERROR: ${error.message}');
    _writeUsage();
    exitCode = 2;
  } on FileSystemException catch (error) {
    stderr.writeln('ERROR: ${error.message}');
    exitCode = 2;
  }
}

void _writeUsage() {
  stdout.writeln('''
Voice V3 runtime evidence tool

Run from the monorepo root:
  bash scripts/client/voice_runtime_validation.sh preflight --target <target> [options]
  bash scripts/client/voice_runtime_validation.sh launch --target <target> [options]
  bash scripts/client/voice_runtime_validation.sh review --input <evidence.json> [options]
  bash scripts/client/voice_runtime_validation.sh record --input <evidence.json> [options]
  bash scripts/client/voice_runtime_validation.sh validate --input <evidence.json>

Targets: android, web, windows

Preflight options:
  --target <target>   Required target.
  --device <id>       Android device id (first attached device by default).
  --url <https-url>   Required production /cosy/ URL for web.
  --resolve-ip <ip>   Optional web DNS override (recorded in evidence).
  --operator <name>   Evidence operator (defaults to the host username).
  --output <path>     New JSON evidence path (a timestamped path by default).

Launch options:
  --target <target>   Required target.
  --device <id>       Android device id.
  --url <https-url>   Required web URL; opens the detected Chromium browser.
  --resolve-ip <ip>   Optional Chromium host resolver override for web.

Record options:
  --input <path>      Required preflight or prior evidence JSON.
  --operator <name>   Optional operator correction.
  --output <path>     New JSON evidence path (source is never overwritten).

Review options:
  --input <path>      Required preflight or prior evidence JSON.
  --output <path>     New self-contained HTML path (timestamped by default).
''');
}

Map<String, String> _parseOptions(List<String> arguments) {
  final result = <String, String>{};
  var index = 0;
  while (index < arguments.length) {
    final argument = arguments[index];
    if (!argument.startsWith('--')) {
      throw FormatException('Unexpected argument: $argument');
    }
    final equals = argument.indexOf('=');
    if (equals > 2) {
      result[argument.substring(2, equals)] = argument.substring(equals + 1);
      index += 1;
      continue;
    }
    if (index + 1 >= arguments.length ||
        arguments[index + 1].startsWith('--')) {
      throw FormatException('Missing value for $argument.');
    }
    result[argument.substring(2)] = arguments[index + 1];
    index += 2;
  }
  return result;
}

Future<void> _runPreflight(Map<String, String> options) async {
  _requireRepositoryRoot();
  final target = parseVoiceRuntimeTarget(_requiredOption(options, 'target'));
  final now = DateTime.now().toUtc();
  final checks = await _preflightChecks(target, options);
  final ready = checks.every((check) => check['status'] == 'PASS');
  final environment = <String, Object?>{
    'hostOs': Platform.operatingSystem,
    'hostOsVersion': Platform.operatingSystemVersion,
    'dartVersion': Platform.version.split(' ').first,
    if (options['device'] case final device?) 'deviceId': device,
    if (options['url'] case final url?) 'url': url,
    if (options['resolve-ip'] case final resolveIp?) 'resolveIp': resolveIp,
  };
  final observations = <String, Object?>{
    for (final definition in observationsForVoiceRuntimeTarget(target))
      definition.id: <String, Object?>{
        'description': definition.description,
        'status': 'NOT_RUN',
        'note': 'Runtime observation not recorded.',
      },
  };
  final evidence = <String, Object?>{
    'schemaVersion': voiceRuntimeEvidenceSchemaVersion,
    'target': target.name,
    'createdAt': now.toIso8601String(),
    'updatedAt': now.toIso8601String(),
    'operator': options['operator'] ?? _defaultOperator(),
    'appVersion': _readAppVersion(),
    'environment': environment,
    'preflight': <String, Object?>{
      'status': ready ? 'READY' : 'NOT_READY',
      'checks': checks,
    },
    'overallStatus': 'NOT_RUN',
    'observations': observations,
  };
  final errors = validateVoiceRuntimeEvidence(evidence);
  if (errors.isNotEmpty) {
    throw FormatException('Generated invalid evidence: ${errors.join(' ')}');
  }
  final output = options['output'] ?? _defaultOutputPath(target, 'preflight');
  _writeNewEvidence(output, evidence);
  _printPreflight(checks, ready: ready);
  stdout
    ..writeln('Evidence: $output')
    ..writeln(
      'Next: run launch, then review this evidence (or use terminal record).',
    );
}

Future<List<Map<String, Object?>>> _preflightChecks(
  VoiceRuntimeTarget target,
  Map<String, String> options,
) async {
  final checks = <Map<String, Object?>>[];
  final flutter = await _findExecutable('flutter');
  checks.add(await _flutterPreflightCheck(flutter));

  switch (target) {
    case VoiceRuntimeTarget.android:
      final adb = await _findExecutable('adb');
      checks.add(
        _check('adb', adb != null, adb ?? 'adb was not found on PATH'),
      );
      if (adb != null) {
        final result = await _runCommand(adb, ['devices', '-l']);
        final devices = _androidDeviceIds(result.stdout.toString());
        final requested = options['device'];
        final found = requested == null
            ? devices.isNotEmpty
            : devices.contains(requested);
        final deviceSummary = devices.isEmpty ? 'none' : devices.join(', ');
        checks.add(
          _check(
            'android_device',
            result.exitCode == 0 && found,
            requested == null
                ? 'Attached devices: $deviceSummary'
                : 'Requested $requested; attached: $deviceSummary',
          ),
        );
      } else {
        checks.add(_check('android_device', false, 'adb is unavailable'));
      }
    case VoiceRuntimeTarget.web:
      final url = options['url'];
      final uri = url == null ? null : Uri.tryParse(url);
      checks.add(
        _check(
          'https_app_url',
          uri != null && isSecureVoiceWebUri(uri),
          url ?? 'Pass --url with the production HTTPS /cosy/ URL',
        ),
      );
      if (uri != null && isSecureVoiceWebUri(uri)) {
        final resolveIp = options['resolve-ip'];
        if (resolveIp != null && InternetAddress.tryParse(resolveIp) == null) {
          checks.add(
            _check(
              'https_app_reachable',
              false,
              '--resolve-ip is not a valid IP address: $resolveIp',
            ),
          );
        } else {
          checks.add(await _probeHttpsApp(uri, resolveIp: resolveIp));
        }
      } else {
        checks.add(
          _check(
            'https_app_reachable',
            false,
            'The production HTTPS /cosy/ URL was not valid.',
          ),
        );
      }
      final browser = await _findChromium();
      checks.add(
        _check(
          'chromium',
          browser != null,
          browser ?? 'Chromium/Chrome was not found',
        ),
      );
    case VoiceRuntimeTarget.windows:
      checks.add(
        _check(
          'windows_host',
          Platform.isWindows,
          Platform.isWindows
              ? Platform.operatingSystemVersion
              : 'Run this preflight from the Windows host, not WSL.',
        ),
      );
      if (flutter != null && Platform.isWindows) {
        final result = await _runCommand(flutter, ['devices', '--machine']);
        final hasWindows = _flutterDevicesContain(
          result.stdout.toString(),
          'windows',
        );
        checks.add(
          _check(
            'windows_flutter_device',
            result.exitCode == 0 && hasWindows,
            hasWindows
                ? 'Flutter reports a Windows desktop device.'
                : 'Flutter does not report a Windows desktop device; verify '
                      'Visual Studio C++ tooling.',
          ),
        );
      } else {
        checks.add(
          _check(
            'windows_flutter_device',
            false,
            'Windows Flutter device check could not run.',
          ),
        );
      }
      checks.add(_windowsSymlinkPreflightCheck());
      final nuget = await _findExecutable('nuget');
      checks.add(
        _check(
          'nuget',
          nuget != null,
          nuget ??
              'nuget.exe was not found on PATH; current flutter_tts Windows '
                  'builds require it.',
        ),
      );
      checks.add(await _windowsVisualStudioAtlPreflightCheck());
  }
  return checks;
}

Map<String, Object?> _windowsSymlinkPreflightCheck() {
  if (!Platform.isWindows) {
    return _check(
      'windows_plugin_symlinks',
      false,
      'Run this check on Windows.',
    );
  }
  final directory = Directory.systemTemp.createTempSync(
    'cosyncing-voice-symlink-',
  );
  try {
    final target = File('${directory.path}\\target.txt')
      ..writeAsStringSync('x');
    final link = Link('${directory.path}\\target-link.txt')
      ..createSync(target.path);
    return _check(
      'windows_plugin_symlinks',
      link.existsSync(),
      link.existsSync()
          ? 'Windows permits Flutter plugin symlink creation.'
          : 'Windows did not create the test symlink.',
    );
  } on FileSystemException catch (error) {
    return _check(
      'windows_plugin_symlinks',
      false,
      'Flutter plugin symlinks are unavailable: ${error.message}. Enable '
          'Windows Developer Mode, then rerun preflight.',
    );
  } finally {
    directory.deleteSync(recursive: true);
  }
}

Future<Map<String, Object?>> _windowsVisualStudioAtlPreflightCheck() async {
  if (!Platform.isWindows) {
    return _check(
      'visual_studio_atl',
      false,
      'Run this check on Windows.',
    );
  }
  final vswhere = await _findVisualStudioWhere();
  if (vswhere == null) {
    return _check(
      'visual_studio_atl',
      false,
      'vswhere.exe was not found; Visual Studio ATL could not be verified.',
    );
  }
  try {
    final result = await _runCommand(vswhere, [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.ATL',
      '-property',
      'installationPath',
    ]);
    final installationPath = result.stdout.toString().trim();
    final installed = isVisualStudioComponentInstalled(
      exitCode: result.exitCode,
      installationPath: installationPath,
    );
    return _check(
      'visual_studio_atl',
      installed,
      installed
          ? 'Visual Studio C++ ATL is installed at $installationPath.'
          : 'Visual Studio component Microsoft.VisualStudio.Component.VC.ATL '
                'is required by current Windows plugins.',
    );
  } on ProcessException catch (error) {
    return _check('visual_studio_atl', false, error.message);
  }
}

Future<Map<String, Object?>> _flutterPreflightCheck(String? flutter) async {
  if (flutter == null) {
    return _check('flutter', false, 'flutter was not found on PATH');
  }
  try {
    final result = await _runCommand(flutter, ['--version', '--machine']);
    if (result.exitCode != 0) {
      final failure = result.stderr.toString().trim();
      return _check(
        'flutter',
        false,
        '$flutter exited ${result.exitCode}: $failure',
      );
    }
    final decoded = jsonDecode(result.stdout.toString());
    final version = _stringObjectMap(decoded)?['frameworkVersion'];
    return _check(
      'flutter',
      version is String && version.isNotEmpty,
      version is String && version.isNotEmpty
          ? '$flutter (Flutter $version)'
          : '$flutter returned no frameworkVersion.',
    );
  } on FormatException {
    return _check('flutter', false, '$flutter returned invalid JSON.');
  } on ProcessException catch (error) {
    return _check('flutter', false, error.message);
  }
}

Future<Map<String, Object?>> _probeHttpsApp(
  Uri uri, {
  required String? resolveIp,
}) async {
  if (resolveIp != null) {
    final curl = await _findExecutable('curl');
    if (curl == null) {
      return _check(
        'https_app_reachable',
        false,
        '--resolve-ip requires curl on PATH.',
      );
    }
    final port = uri.hasPort ? uri.port : 443;
    final nullDevice = Platform.isWindows ? 'NUL' : '/dev/null';
    final result = await _runCommand(curl, [
      '--silent',
      '--show-error',
      '--output',
      nullDevice,
      '--write-out',
      '%{http_code}',
      '--resolve',
      '${uri.host}:$port:$resolveIp',
      uri.toString(),
    ]);
    final statusCode = int.tryParse(result.stdout.toString().trim());
    final pass =
        result.exitCode == 0 &&
        statusCode != null &&
        statusCode >= 200 &&
        statusCode < 400;
    return _check(
      'https_app_reachable',
      pass,
      result.exitCode == 0
          ? 'GET $uri via $resolveIp returned HTTP $statusCode.'
          : 'curl failed via $resolveIp: ${result.stderr.toString().trim()}',
    );
  }

  final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
  try {
    final request = await client
        .getUrl(uri)
        .timeout(const Duration(seconds: 8));
    request.headers.set(
      HttpHeaders.userAgentHeader,
      'cosyncing-voice-preflight/1',
    );
    final response = await request.close().timeout(const Duration(seconds: 8));
    final statusCode = response.statusCode;
    await response.drain<void>();
    final pass = statusCode >= 200 && statusCode < 400;
    return _check(
      'https_app_reachable',
      pass,
      'GET $uri returned HTTP $statusCode.',
    );
  } on HandshakeException catch (error) {
    return _check(
      'https_app_reachable',
      false,
      'TLS handshake failed: ${error.message}',
    );
  } on SocketException catch (error) {
    return _check(
      'https_app_reachable',
      false,
      'Connection failed: ${error.message}',
    );
  } on TimeoutException {
    return _check('https_app_reachable', false, 'Connection timed out.');
  } finally {
    client.close(force: true);
  }
}

Map<String, Object?> _check(String id, bool pass, String detail) => {
  'id': id,
  'status': pass ? 'PASS' : 'NOT_RUN',
  'detail': detail,
};

void _printPreflight(
  List<Map<String, Object?>> checks, {
  required bool ready,
}) {
  for (final check in checks) {
    stdout.writeln(
      '${check['status']} ${check['id']}: ${check['detail']}',
    );
  }
  stdout.writeln('Preflight: ${ready ? 'READY' : 'NOT_READY'}');
}

Future<void> _runRecord(Map<String, String> options) async {
  _requireRepositoryRoot();
  final input = _requiredOption(options, 'input');
  final evidence = _readEvidence(input);
  final sourceErrors = validateVoiceRuntimeEvidence(evidence);
  if (sourceErrors.isNotEmpty) {
    throw FormatException(
      'Source evidence is invalid: ${sourceErrors.join(' ')}',
    );
  }
  final target = parseVoiceRuntimeTarget(evidence['target']! as String);
  final observations = _stringObjectMap(evidence['observations'])!;

  stdout
    ..writeln('Recording ${target.name} runtime evidence.')
    ..writeln(
      'For every check type PASS, FAIL, or NOT_RUN exactly. A non-empty '
      'observation note is mandatory. Press Enter to preserve an existing '
      'value.',
    );
  for (final definition in observationsForVoiceRuntimeTarget(target)) {
    final current = _stringObjectMap(observations[definition.id])!;
    stdout
      ..writeln('\n${definition.id}: ${definition.description}')
      ..writeln('Current: ${current['status']} - ${current['note']}');
    final status = _readStatus();
    if (status == null) continue;
    final note = _readRequiredLine('Observation note: ');
    observations[definition.id] = <String, Object?>{
      'description': definition.description,
      'status': status,
      'note': note,
    };
  }

  final now = DateTime.now().toUtc();
  evidence['updatedAt'] = now.toIso8601String();
  evidence['operator'] = options['operator'] ?? evidence['operator'];
  evidence['sourceEvidence'] = input;
  evidence['overallStatus'] = computeVoiceRuntimeOverallStatus(observations);
  final errors = validateVoiceRuntimeEvidence(evidence);
  if (errors.isNotEmpty) {
    throw FormatException('Evidence is invalid: ${errors.join(' ')}');
  }
  final output =
      options['output'] ?? _defaultOutputPath(target, 'runtime-evidence');
  _writeNewEvidence(output, evidence);
  stdout
    ..writeln('\nOverall: ${evidence['overallStatus']}')
    ..writeln('Evidence: $output');
}

void _runReview(Map<String, String> options) {
  _requireRepositoryRoot();
  final input = _requiredOption(options, 'input');
  final evidence = _readEvidence(input);
  final errors = validateVoiceRuntimeEvidence(evidence);
  if (errors.isNotEmpty) {
    throw FormatException(
      'Source evidence is invalid: ${errors.join(' ')}',
    );
  }
  final target = parseVoiceRuntimeTarget(evidence['target']! as String);
  final output =
      options['output'] ?? _defaultOutputPath(target, 'human-review', 'html');
  _writeNewTextFile(
    output,
    renderVoiceRuntimeReviewHtml(
      evidence,
      sourceEvidence: input,
    ),
  );
  stdout
    ..writeln('Human review page: $output')
    ..writeln('Open it in a browser, export JSON, then run validate on it.');
}

String? _readStatus() {
  while (true) {
    stdout.write('Status [PASS/FAIL/NOT_RUN, Enter keeps current]: ');
    final value = stdin.readLineSync();
    if (value == null || value.trim().isEmpty) return null;
    final normalized = value.trim().toUpperCase();
    if (normalized == 'PASS' ||
        normalized == 'FAIL' ||
        normalized == 'NOT_RUN') {
      return normalized;
    }
    stdout.writeln('Type PASS, FAIL, or NOT_RUN exactly.');
  }
}

String _readRequiredLine(String prompt) {
  while (true) {
    stdout.write(prompt);
    final value = stdin.readLineSync()?.trim() ?? '';
    if (value.isNotEmpty) return value;
    stdout.writeln('A note is required.');
  }
}

Future<void> _runValidate(Map<String, String> options) async {
  final input = _requiredOption(options, 'input');
  final errors = validateVoiceRuntimeEvidence(_readEvidence(input));
  if (errors.isNotEmpty) {
    for (final error in errors) {
      stderr.writeln('FAIL: $error');
    }
    exitCode = 1;
    return;
  }
  stdout.writeln('PASS: $input is valid voice runtime evidence.');
}

Future<void> _runLaunch(Map<String, String> options) async {
  _requireRepositoryRoot();
  final target = parseVoiceRuntimeTarget(_requiredOption(options, 'target'));
  switch (target) {
    case VoiceRuntimeTarget.android:
      final flutter = await _requireExecutable('flutter');
      final arguments = ['run'];
      if (options['device'] case final device?) {
        arguments.addAll(['-d', device]);
      }
      final process = await _startCommand(
        flutter,
        arguments,
      );
      exitCode = await process.exitCode;
    case VoiceRuntimeTarget.web:
      final url = _requiredOption(options, 'url');
      final uri = Uri.tryParse(url);
      if (uri == null || !isSecureVoiceWebUri(uri)) {
        throw const FormatException('Web launch requires an HTTPS URL.');
      }
      final browser = await _findChromium();
      if (browser == null) {
        throw const FormatException('Chromium/Chrome was not found.');
      }
      final resolveIp = options['resolve-ip'];
      if (resolveIp != null && InternetAddress.tryParse(resolveIp) == null) {
        throw FormatException('--resolve-ip is not a valid IP: $resolveIp');
      }
      await Process.start(
        browser,
        [
          if (resolveIp != null)
            '--host-resolver-rules=MAP ${uri.host} $resolveIp',
          url,
        ],
        mode: ProcessStartMode.detached,
      );
      stdout.writeln('Opened $url in $browser');
    case VoiceRuntimeTarget.windows:
      if (!Platform.isWindows) {
        throw const FormatException(
          'Windows launch must run from Windows PowerShell, not WSL.',
        );
      }
      final flutter = await _requireExecutable('flutter');
      final process = await _startCommand(
        flutter,
        ['run', '-d', 'windows'],
      );
      exitCode = await process.exitCode;
  }
}

Future<String?> _findExecutable(String command) async {
  final locator = Platform.isWindows ? 'where.exe' : 'which';
  try {
    final result = await Process.run(locator, [command]);
    if (result.exitCode != 0) return null;
    return selectVoiceRuntimeExecutablePath(
      result.stdout.toString().split(RegExp(r'[\r\n]+')),
      windows: Platform.isWindows,
    );
  } on ProcessException {
    return null;
  }
}

Future<String?> _findVisualStudioWhere() async {
  final onPath = await _findExecutable('vswhere.exe');
  if (onPath != null) return onPath;
  final programFilesX86 = Platform.environment['ProgramFiles(x86)'];
  if (programFilesX86 == null || programFilesX86.isEmpty) return null;
  final candidate =
      '$programFilesX86\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  return File(candidate).existsSync() ? candidate : null;
}

Future<ProcessResult> _runCommand(
  String executable,
  List<String> arguments,
) {
  if (_isWindowsBatchFile(executable)) {
    return Process.run('cmd.exe', ['/d', '/c', executable, ...arguments]);
  }
  return Process.run(executable, arguments);
}

Future<Process> _startCommand(
  String executable,
  List<String> arguments,
) {
  if (_isWindowsBatchFile(executable)) {
    return Process.start(
      'cmd.exe',
      ['/d', '/c', executable, ...arguments],
      mode: ProcessStartMode.inheritStdio,
    );
  }
  return Process.start(
    executable,
    arguments,
    mode: ProcessStartMode.inheritStdio,
  );
}

bool _isWindowsBatchFile(String executable) {
  if (!Platform.isWindows) return false;
  final normalized = executable.toLowerCase();
  return normalized.endsWith('.bat') || normalized.endsWith('.cmd');
}

Future<String> _requireExecutable(String command) async {
  final executable = await _findExecutable(command);
  if (executable == null) {
    throw FormatException('$command was not found on PATH.');
  }
  return executable;
}

Future<String?> _findChromium() async {
  for (final candidate in [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    if (Platform.isWindows) 'chrome.exe',
    if (Platform.isWindows) 'msedge.exe',
  ]) {
    final executable = await _findExecutable(candidate);
    if (executable != null) return executable;
  }
  if (Platform.isWindows) {
    for (final candidate in [
      r'C:\Program Files\Google\Chrome\Application\chrome.exe',
      r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    ]) {
      if (File(candidate).existsSync()) return candidate;
    }
  }
  return null;
}

List<String> _androidDeviceIds(String output) {
  final devices = <String>[];
  for (final line in const LineSplitter().convert(output)) {
    if (line.startsWith('List of devices') || line.trim().isEmpty) continue;
    final fields = line.trim().split(RegExp(r'\s+'));
    if (fields.length >= 2 && fields[1] == 'device') devices.add(fields.first);
  }
  return devices;
}

bool _flutterDevicesContain(String output, String id) {
  try {
    final decoded = jsonDecode(output);
    if (decoded is! List<Object?>) return false;
    return decoded.any((item) {
      final device = _stringObjectMap(item);
      return device?['id'] == id;
    });
  } on FormatException {
    return false;
  }
}

Map<String, Object?> _readEvidence(String path) {
  final decoded = jsonDecode(File(path).readAsStringSync());
  final evidence = _stringObjectMap(decoded);
  if (evidence == null) {
    throw const FormatException('Evidence root must be a JSON object.');
  }
  return evidence;
}

void _writeNewEvidence(String path, Map<String, Object?> evidence) {
  _writeNewTextFile(
    path,
    '${const JsonEncoder.withIndent('  ').convert(evidence)}\n',
  );
}

void _writeNewTextFile(String path, String contents) {
  final file = File(path);
  if (file.existsSync()) {
    throw FileSystemException('Refusing to overwrite existing output', path);
  }
  file.parent.createSync(recursive: true);
  file.writeAsStringSync(contents);
}

String _defaultOutputPath(
  VoiceRuntimeTarget target,
  String kind, [
  String extension = 'json',
]) {
  final timestamp = DateTime.now()
      .toUtc()
      .toIso8601String()
      .replaceAll(RegExp('[-:]'), '')
      .replaceAll('.', '-');
  return 'output/voice-validation/runtime/'
      '${target.name}-$kind-$timestamp.$extension';
}

String _defaultOperator() {
  final environment = Platform.environment;
  return environment['USERNAME'] ?? environment['USER'] ?? 'unknown-operator';
}

String _readAppVersion() {
  final pubspec = File('pubspec.yaml').readAsStringSync();
  final match = RegExp(
    r'^version:\s*(\S+)\s*$',
    multiLine: true,
  ).firstMatch(pubspec);
  return match?.group(1) ?? 'unknown';
}

String _requiredOption(Map<String, String> options, String name) {
  final value = options[name];
  if (value == null || value.trim().isEmpty) {
    throw FormatException('--$name is required.');
  }
  return value;
}

void _requireRepositoryRoot() {
  if (!File('pubspec.yaml').existsSync()) {
    throw const FormatException(
      'Run this tool from the apps/client Flutter app root.',
    );
  }
}

extension<T> on Iterable<T> {
  T? get firstOrNull {
    final iterator = this.iterator;
    return iterator.moveNext() ? iterator.current : null;
  }
}
