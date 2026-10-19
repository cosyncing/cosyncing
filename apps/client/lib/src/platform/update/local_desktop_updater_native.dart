import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/platform/update/local_desktop_updater_contract.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

/// Discovers the helper from the running executable and installer receipt.
LocalDesktopUpdater createLocalDesktopUpdater() => _NativeDesktopUpdater();

class _NativeDesktopUpdater implements LocalDesktopUpdater {
  String get _home =>
      Platform.environment['COSYNCING_DESKTOP_UPDATE_HOME'] ??
      Platform.environment['COSYNCING_HOME'] ??
      p.join(
        Platform.environment[Platform.isWindows ? 'USERPROFILE' : 'HOME'] ?? '',
        '.cosyncing',
      );

  Future<Map<String, String>> _receipt() async {
    if (!Platform.isLinux && !Platform.isMacOS && !Platform.isWindows) {
      throw const DesktopUpdaterUnavailable('desktop-update-unsupported');
    }
    final receipt = File(p.join(_home, 'bootstrap-receipt'));
    if (!receipt.existsSync() || receipt.lengthSync() > 16384) {
      throw const DesktopUpdaterUnavailable('desktop-update-setup-required');
    }
    final values = <String, String>{};
    for (final line in (await receipt.readAsString()).split(RegExp(r'\r?\n'))) {
      if (line.isEmpty) continue;
      final separator = line.indexOf('=');
      if (separator < 1 || values.containsKey(line.substring(0, separator))) {
        throw const DesktopUpdaterUnavailable('desktop-update-receipt-invalid');
      }
      values[line.substring(0, separator)] = line.substring(separator + 1);
    }
    final application = values['application'] ?? '';
    final runtime = values['runtime'] ?? '';
    if (values['schemaVersion'] != '2' ||
        values['product'] != 'cosyncing' ||
        values['distribution'] != 'bootstrap-js' ||
        !p.isAbsolute(runtime) ||
        !p.equals(application, p.join(_home, 'bin', 'cosyncing')) ||
        !File(runtime).existsSync()) {
      throw const DesktopUpdaterUnavailable('desktop-update-setup-required');
    }
    final file = File(application);
    if (FileSystemEntity.typeSync(application, followLinks: false) !=
        FileSystemEntityType.file) {
      throw const DesktopUpdaterUnavailable('desktop-update-runner-untrusted');
    }
    final digest = await sha256StreamDigest(file.openRead());
    if (digest.digest != 'sha256:${values['sha256']}') {
      throw const DesktopUpdaterUnavailable('desktop-update-runner-untrusted');
    }
    return values;
  }

  Future<Map<String, dynamic>> _run(List<String> arguments) async {
    if (Platform.isMacOS) return _bridge(arguments);
    final receipt = await _receipt();
    final process = await Process.start(
      receipt['runtime']!,
      [receipt['application']!, 'client-update', ...arguments],
      environment: {'COSYNCING_HOME': _home},
    );
    final output = <int>[];
    final errors = process.stderr.drain<void>();
    final stdout = () async {
      await for (final chunk in process.stdout) {
        if (output.length + chunk.length > 256 * 1024) {
          process.kill();
          throw const DesktopUpdaterUnavailable(
            'desktop-update-output-invalid',
          );
        }
        output.addAll(chunk);
      }
    }();
    try {
      final completed = await Future.wait<Object?>([
        process.exitCode,
        stdout,
        errors,
      ], eagerError: true).timeout(const Duration(minutes: 11));
      final code = completed.first;
      final json = jsonDecode(utf8.decode(output)) as Map<String, dynamic>;
      if (code != 0 || json['ok'] != true) {
        throw DesktopUpdaterUnavailable(
          json['detailCode'] as String? ?? 'desktop-update-failed',
        );
      }
      return json;
    } on TimeoutException {
      process.kill();
      throw const DesktopUpdaterUnavailable('desktop-update-helper-timeout');
    }
  }

  Future<Map<String, dynamic>> _bridge(List<String> arguments) async {
    final container = Platform.environment['HOME'] ?? '';
    final endpoint = File(
      p.join(container, '.cosyncing', 'desktop-updater.json'),
    );
    if (!endpoint.existsSync() || endpoint.lengthSync() > 16384) {
      throw const DesktopUpdaterUnavailable('desktop-update-setup-required');
    }
    final address =
        jsonDecode(await endpoint.readAsString()) as Map<String, dynamic>;
    final port = address['port'];
    final token = address['token'];
    if (address['schemaVersion'] != 1 ||
        port is! int ||
        port < 1 ||
        port > 65535 ||
        token is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(token)) {
      throw const DesktopUpdaterUnavailable('desktop-update-endpoint-invalid');
    }
    final body = <String, dynamic>{'action': arguments.first};
    var index = 1;
    if (index < arguments.length && !arguments[index].startsWith('--')) {
      body['id'] = arguments[index++];
    }
    const names = {
      '--pid': 'pid',
      '--executable': 'executable',
      '--release': 'releaseId',
      '--version': 'version',
    };
    while (index < arguments.length) {
      final key = names[arguments[index++]]!;
      final value = arguments[index++];
      body[key] = key == 'pid' ? int.parse(value) : value;
    }
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    try {
      final request = await client.postUrl(
        Uri.http('127.0.0.1:$port', '/update'),
      );
      request.headers
        ..contentType = ContentType.json
        ..set('x-cosyncing-desktop-update', token);
      request.write(jsonEncode(body));
      final response = await request.close().timeout(
        const Duration(minutes: 11),
      );
      final output = <int>[];
      await for (final chunk in response.timeout(const Duration(seconds: 20))) {
        if (output.length + chunk.length > 256 * 1024) {
          throw const DesktopUpdaterUnavailable(
            'desktop-update-output-invalid',
          );
        }
        output.addAll(chunk);
      }
      final result = jsonDecode(utf8.decode(output)) as Map<String, dynamic>;
      if (response.statusCode != 200 ||
          result['ok'] != true ||
          result['installationId'] != null &&
              result['installationId'] != address['installationId']) {
        throw DesktopUpdaterUnavailable(
          result['detailCode'] as String? ??
              'desktop-update-helper-unavailable',
        );
      }
      return result;
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<Map<String, dynamic>> inspect() => _run([
    'inspect',
    '--pid',
    '$pid',
    '--executable',
    Platform.resolvedExecutable,
    '--version',
    cosyncingClientVersion,
  ]);
  @override
  Future<Map<String, dynamic>> prepare(String id, String release) => _run([
    'prepare',
    id,
    '--pid',
    '$pid',
    '--executable',
    Platform.resolvedExecutable,
    '--release',
    release,
  ]);
  @override
  Future<Map<String, dynamic>> arm(String id) => _run(['apply', id]);
  @override
  Future<Map<String, dynamic>> status(String id) => _run(['status', id]);
  @override
  Future<void> cancel(String id) async {
    await _run(['cancel', id]);
  }

  @override
  Future<void> acknowledgeStartup(String version) async {
    final id = Platform.isMacOS
        ? await const MethodChannel(
            'com.cosyncing.client/window',
          ).invokeMethod<String>('updateOperation')
        : Platform.environment['COSYNCING_DESKTOP_UPDATE_ID'];
    if (id == null) return;
    await _run(['ack', id, '--pid', '$pid', '--version', version]);
  }
}
