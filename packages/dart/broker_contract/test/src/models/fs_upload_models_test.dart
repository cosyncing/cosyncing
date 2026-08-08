import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('FsReadResult', () {
    test('fromJson parses a utf8 read with W14 mimeType', () {
      final result = FsReadResult.fromJson({
        'ok': true,
        'path': 'src/main.dart',
        'size': 12,
        'limit': 1024,
        'truncated': false,
        'encoding': 'utf8',
        'data': 'hello world',
        'mimeType': 'text/plain',
      });
      expect(result.path, 'src/main.dart');
      expect(result.size, 12);
      expect(result.limit, 1024);
      expect(result.truncated, isFalse);
      expect(result.encoding, 'utf8');
      expect(result.data, 'hello world');
      expect(result.mimeType, 'text/plain');
    });

    test('fromJson treats mimeType as optional (absent -> null)', () {
      final result = FsReadResult.fromJson({
        'ok': true,
        'path': 'bin/data',
        'size': 4096,
        'limit': 1024,
        'truncated': true,
        'encoding': 'base64',
        'data': 'AAECAw==',
      });
      expect(result.truncated, isTrue);
      expect(result.encoding, 'base64');
      expect(result.mimeType, isNull);
    });

    test('fromJson ignores the broker ok wrapper and unknown fields', () {
      final result = FsReadResult.fromJson({
        'ok': true,
        'path': 'a',
        'futureField': 42,
      });
      expect(result.path, 'a');
      expect(result.size, 0);
      expect(result.encoding, 'utf8');
    });

    test('toJson round-trips and omits ok and null mimeType', () {
      final original = FsReadResult.fromJson({
        'ok': true,
        'path': 'a',
        'size': 1,
        'limit': 2,
        'truncated': true,
        'encoding': 'base64',
        'data': 'AA==',
      });
      expect(original.toJson(), isNot(contains('ok')));
      expect(original.toJson(), isNot(contains('mimeType')));
      final restored = FsReadResult.fromJson(original.toJson());
      expect(restored.path, 'a');
      expect(restored.size, 1);
      expect(restored.truncated, isTrue);
      expect(restored.encoding, 'base64');
      expect(restored.data, 'AA==');
      expect(restored.mimeType, isNull);
    });
  });

  group('FsDirectoryResult', () {
    test('fromJson parses stat and entries', () {
      final result = FsDirectoryResult.fromJson({
        'ok': true,
        'path': 'src',
        'stat': {
          'path': 'src',
          'type': 'directory',
          'size': 0,
          'mtimeMs': 1719900000000.0,
          'isDirectory': true,
          'isRegularFile': false,
          'isSymbolicLink': false,
        },
        'entries': [
          {
            'name': 'main.dart',
            'path': 'src/main.dart',
            'type': 'file',
            'size': 12,
            'mtimeMs': 1719900000000.0,
          },
          {
            'name': 'subdir',
            'path': 'src/subdir',
            'type': 'directory',
            'size': 0,
            'mtimeMs': 1719900000000.0,
          },
        ],
      });
      expect(result.stat.isDirectory, isTrue);
      expect(result.stat.isRegularFile, isFalse);
      expect(result.entries, hasLength(2));
      expect(result.entries.first.name, 'main.dart');
      expect(result.entries.first.type, 'file');
      expect(result.entries.last.name, 'subdir');
      expect(result.entries.last.type, 'directory');
    });

    test('fromJson tolerates unknown fields and missing entries', () {
      final result = FsDirectoryResult.fromJson({
        'ok': true,
        'path': 'x',
        'stat': {'path': 'x', 'futureField': true},
      });
      expect(result.entries, isEmpty);
      expect(result.stat.path, 'x');
      expect(result.stat.type, 'other');
    });

    test('toJson omits the broker ok wrapper', () {
      final result = FsDirectoryResult.fromJson({
        'ok': true,
        'path': 'x',
        'stat': {
          'path': 'x',
          'type': 'directory',
          'size': 0,
          'mtimeMs': 0,
          'isDirectory': true,
          'isRegularFile': false,
          'isSymbolicLink': false,
        },
        'entries': <Map<String, dynamic>>[],
      });
      expect(result.toJson(), isNot(contains('ok')));
    });
  });

  group('UploadInitResult', () {
    test('fromJson parses init result', () {
      final result = UploadInitResult.fromJson({
        'ok': true,
        'uploadId': '11111111-2222-3333-4444-555555555555',
        'offset': 0,
        'size': 1024,
        'expiresAt': 1719900000000,
        'future': 'ignored',
      });
      expect(result.uploadId, '11111111-2222-3333-4444-555555555555');
      expect(result.offset, 0);
      expect(result.size, 1024);
      expect(result.expiresAt, 1719900000000);
    });

    test('toJson omits the broker ok wrapper', () {
      final result = UploadInitResult.fromJson({
        'ok': true,
        'uploadId': 'u',
        'offset': 0,
        'size': 0,
        'expiresAt': 0,
      });
      expect(result.toJson(), isNot(contains('ok')));
    });
  });

  group('UploadStatus', () {
    test('fromJson parses status with required mimeType', () {
      final result = UploadStatus.fromJson({
        'ok': true,
        'uploadId': 'u-1',
        'offset': 512,
        'size': 1024,
        'name': 'file.bin',
        'mimeType': 'application/octet-stream',
      });
      expect(result.offset, 512);
      expect(result.name, 'file.bin');
      expect(result.mimeType, 'application/octet-stream');
    });

    test('fromJson defaults a missing required mimeType to empty string', () {
      final result = UploadStatus.fromJson({
        'ok': true,
        'uploadId': 'u-1',
      });
      expect(result.mimeType, '');
      expect(result.name, '');
    });
  });

  group('UploadPatchResult', () {
    test('fromJson parses progress', () {
      final result = UploadPatchResult.fromJson({
        'ok': true,
        'uploadId': 'u-1',
        'offset': 1024,
        'size': 1024,
        'progress': 1.0,
      });
      expect(result.offset, 1024);
      expect(result.progress, 1.0);
    });

    test('fromJson tolerates unknown progress shape', () {
      final result = UploadPatchResult.fromJson({
        'ok': true,
        'uploadId': 'u-1',
      });
      expect(result.progress, 0);
    });
  });

  group('UploadCompleteResult', () {
    test('fromJson parses complete result', () {
      final result = UploadCompleteResult.fromJson({
        'ok': true,
        'uploadId': 'upload-1',
        'stagedRef': 'stg1.opaque',
        'name': 'file.bin',
        'mimeType': 'application/octet-stream',
        'size': 1024,
        'expiresAt': 1783590000000,
        'future': 'ignored',
      });
      expect(result.uploadId, 'upload-1');
      expect(result.stagedRef, 'stg1.opaque');
      expect(result.name, 'file.bin');
      expect(result.mimeType, 'application/octet-stream');
      expect(result.size, 1024);
      expect(result.expiresAt, 1783590000000);
    });

    test('toJson round-trips and omits ok', () {
      final original = UploadCompleteResult.fromJson({
        'ok': true,
        'uploadId': 'u',
        'stagedRef': 'r',
        'name': 'n',
        'mimeType': 'm',
        'size': 7,
        'expiresAt': 9,
      });
      expect(original.toJson(), isNot(contains('ok')));
      final restored = UploadCompleteResult.fromJson(original.toJson());
      expect(restored.uploadId, 'u');
      expect(restored.stagedRef, 'r');
      expect(restored.name, 'n');
      expect(restored.mimeType, 'm');
      expect(restored.size, 7);
      expect(restored.expiresAt, 9);
    });
  });
}
