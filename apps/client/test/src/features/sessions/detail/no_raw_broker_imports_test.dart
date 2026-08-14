import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Feature boundary enforcement', () {
    test('detectors catch forbidden imports and JSON helpers', () {
      expect(
        _containsPackageImport("import 'package:dio/dio.dart';", 'dio'),
        isTrue,
      );
      expect(
        _containsPackageImport(
          "import 'package:web_socket_channel/web_socket_channel.dart';",
          'web_socket_channel',
        ),
        isTrue,
      );
      expect(_containsDartImport("import 'dart:io';", 'io'), isTrue);
      expect(_containsDartImport("import 'dart:convert';", 'convert'), isTrue);
      expect(_containsRawJsonApi('final data = jsonDecode(payload);'), isTrue);
      expect(
        _containsRawJsonApi('final data = JsonDecoder().convert(raw);'),
        isTrue,
      );
    });

    test('detectors ignore allowed imports', () {
      expect(
        _containsPackageImport(
          "import 'package:flutter/material.dart';",
          'dio',
        ),
        isFalse,
      );
      expect(_containsDartImport("import 'dart:async';", 'io'), isFalse);
    });

    test(
      'feature UI/provider/controller code does not import forbidden '
      'transport/raw JSON APIs',
      () async {
        final featureDirs = [
          Directory('lib/src/features/sessions'),
          Directory('lib/src/features/connection'),
          Directory('lib/src/features/settings'),
          Directory('lib/src/features/broker_profiles'),
          Directory('lib/src/features/pairing'),
          Directory('lib/src/features/transfers'),
        ];
        for (final featureDir in featureDirs) {
          if (!featureDir.existsSync()) {
            fail('${featureDir.path} not found');
          }
        }

        final violations = <String>[];

        for (final featureDir in featureDirs) {
          for (final entity in featureDir.listSync(recursive: true)) {
            if (entity is! File || !entity.path.endsWith('.dart')) {
              continue;
            }
            if (!entity.path.endsWith('_test.dart') &&
                !entity.path.endsWith('_controller.dart') &&
                !entity.path.contains('/provider/') &&
                !entity.path.contains('/view/')) {
              continue;
            }
            if (entity.path.contains('/model/')) {
              continue;
            }
            if (_isFeatureBoundaryTestFile(entity.path)) {
              continue;
            }

            final content = entity.readAsStringSync();
            final lines = content.split('\n');

            for (var i = 0; i < lines.length; i++) {
              final line = lines[i];
              final lineNum = i + 1;

              final trimmed = line.trimLeft();
              // Skip comments.
              if (trimmed.startsWith('//')) {
                continue;
              }

              if (_containsPackageImport(line, 'broker_client')) {
                if (!_isAllowedBrokerClientImport(entity.path, line)) {
                  violations.add(
                    '${entity.path}:$lineNum imports BrokerClient',
                  );
                }
                continue;
              }

              if (_containsPackageImport(line, 'dio')) {
                violations.add('${entity.path}:$lineNum imports Dio');
              }
              if (_containsDartImport(line, 'io')) {
                violations.add(
                  '${entity.path}:$lineNum imports dart:io',
                );
              }
              if (_containsPackageImport(line, 'web_socket_channel')) {
                violations.add(
                  '${entity.path}:$lineNum imports WebSocket',
                );
              }
              if (_containsDartImport(line, 'convert')) {
                violations.add(
                  '${entity.path}:$lineNum imports dart:convert',
                );
              }
              if (_containsRawJsonApi(line)) {
                violations.add(
                  '${entity.path}:$lineNum uses raw JSON API',
                );
              }
            }
          }
        }

        expect(
          violations,
          isEmpty,
          reason:
              'Feature UI/provider/controller files must not import forbidden '
              'transport/raw JSON dependencies:\n${violations.join('\n')}',
        );
      },
    );
  });
}

bool _isFeatureBoundaryTestFile(String filePath) {
  return filePath.endsWith('no_raw_broker_imports_test.dart');
}

bool _containsPackageImport(String line, String packageName) {
  return RegExp(
    "^\\s*import\\s+['\"]package:${RegExp.escape(packageName)}/",
  ).hasMatch(line);
}

bool _isAllowedBrokerClientImport(String filePath, String line) {
  return filePath ==
          'lib/src/features/connection/provider/connection_providers.dart' &&
      _containsPackageImport(line, 'broker_client');
}

bool _containsDartImport(String line, String libraryName) {
  return RegExp(
    "^\\s*import\\s+['\"]dart:${RegExp.escape(libraryName)}['\"]",
  ).hasMatch(line);
}

bool _containsRawJsonApi(String line) {
  return RegExp(
    r'\b(jsonDecode|jsonEncode|JsonDecoder|JsonEncoder)\b',
  ).hasMatch(line);
}
