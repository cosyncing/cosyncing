import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionArtifactFileService save dialog localization', () {
    test('selected app locale wins when the platform locale differs', () async {
      final acceptedGroups = <XTypeGroup>[];
      final provider = FileSelectorArtifactSaveTargetProvider(
        typeLabel: artifactSaveTypeLabel(
          appLocale: const Locale('zh'),
          platformLocale: const Locale('en'),
        ),
        pathPicker:
            ({
              required suggestedName,
              required acceptedTypeGroups,
            }) async {
              acceptedGroups.addAll(acceptedTypeGroups);
              return '/tmp/$suggestedName';
            },
      );

      final path = await provider.pickSavePath(
        suggestedName: 'result.txt',
        mimeType: 'text/plain',
      );

      expect(path, '/tmp/result.txt');
      expect(acceptedGroups, hasLength(1));
      expect(acceptedGroups.single.label, '产物');
    });
  });

  group('SessionArtifactFileService filename behavior', () {
    test('sanitizeFileName strips invalid path characters', () {
      const raw = r'..\folder/../bad:na*me?.txt';
      final sanitized = DefaultSessionArtifactFileService.sanitizeFileName(raw);

      expect(sanitized, isNotEmpty);
      expect(sanitized, isNot(contains('/')));
      expect(sanitized, isNot(contains(r'\')));
      expect(sanitized, isNot(contains('..')));
      expect(sanitized, isNot(contains(':')));
      expect(sanitized, isNot(contains('*')));
      expect(sanitized, isNot(contains('?')));
      expect(sanitized, isNot(contains('"')));
      expect(sanitized, isNot(contains('<')));
      expect(sanitized, isNot(contains('>')));
      expect(sanitized, isNot(contains('|')));
    });

    test(
      'decodeDataUrl handles inline base64 and percent-encoded payloads',
      () {
        final base64Decoded = DefaultSessionArtifactFileService.decodeDataUrl(
          'data:text/plain;base64,SGVsbG8gV29ybGQ=',
        );

        final percentDecoded = DefaultSessionArtifactFileService.decodeDataUrl(
          'data:text/plain,Hello%20World%21',
        );

        expect(utf8.decode(base64Decoded.bytes), 'Hello World');
        expect(base64Decoded.contentType, 'text/plain');
        expect(utf8.decode(percentDecoded.bytes), 'Hello World!');
        expect(percentDecoded.contentType, 'text/plain');
      },
    );

    test('decodeDataUrl throws on malformed inline data strings', () {
      expect(
        () =>
            DefaultSessionArtifactFileService.decodeDataUrl('data:text/plain'),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('BrowserSessionArtifactFileService transfer bounds', () {
    test('signed artifacts use the bounded backend before retention', () async {
      final backend = _FakeBrowserBoundedDownloadBackend(
        artifactBytes: utf8.encode('bounded artifact'),
        artifactKey: 'artifact-key',
        contentHash: 'content-version',
      );
      final service = BrowserSessionArtifactFileService(backend);

      final cached = await service.cacheArtifact(
        const SessionArtifactDescriptor(
          name: 'artifact.txt',
          artifactKey: 'artifact-key',
          contentHash: 'content-version',
          fetchUrl: 'https://broker/artifact/artifact-key',
        ),
      );

      expect(cached.byteLength, utf8.encode('bounded artifact').length);
      expect(backend.boundedArtifactCalls, 1);
      expect(backend.unboundedArtifactCalls, 0);
      expect(backend.artifactLimits, [64 * 1024 * 1024]);
    });

    test(
      'advertised over-limit artifact fails before browser retention',
      () async {
        final backend = _FakeBrowserBoundedDownloadBackend(
          artifactBytes: const [1],
          artifactAdvertisedLength: 64 * 1024 * 1024 + 1,
        );
        final service = BrowserSessionArtifactFileService(backend);

        await expectLater(
          service.cacheArtifact(
            const SessionArtifactDescriptor(
              name: 'oversized.bin',
              fetchUrl: 'https://broker/artifact/oversized',
            ),
          ),
          throwsA(isA<ArtifactTooLargeException>()),
        );
        expect(backend.unboundedArtifactCalls, 0);
      },
    );

    test('workspace files use bounded authenticated ranges only', () async {
      final fileBytes = List<int>.generate(
        1024 * 1024 + 17,
        (index) => index % 251,
      );
      final backend = _FakeBrowserBoundedDownloadBackend(
        sessionBytes: fileBytes,
      );
      final service = BrowserSessionArtifactFileService(backend);

      final cached = await service.cacheSessionFile(
        tool: 'pi',
        sessionId: 'owner',
        path: 'results.bin',
        fileName: 'results.bin',
      );

      expect(cached.byteLength, fileBytes.length);
      expect(backend.fullSessionCalls, 0);
      expect(backend.unboundedRangeCalls, 0);
      expect(backend.boundedRangeCalls, 2);
      expect(
        backend.rangeLimits.every((limit) => limit <= 1024 * 1024),
        isTrue,
      );
    });

    test('workspace total wins over misleading small content-length', () async {
      final backend = _FakeBrowserBoundedDownloadBackend(
        sessionBytes: const [1, 2, 3, 4],
        sessionAdvertisedTotal: 64 * 1024 * 1024 + 1,
        rangeContentLength: 1,
      );
      final service = BrowserSessionArtifactFileService(backend);

      await expectLater(
        service.cacheSessionFile(
          tool: 'pi',
          sessionId: 'owner',
          path: 'misleading.bin',
          fileName: 'misleading.bin',
        ),
        throwsA(isA<ArtifactTooLargeException>()),
      );
      expect(backend.fullSessionCalls, 0);
      expect(backend.boundedRangeCalls, 1);
    });
  });

  group('SessionArtifactFileService cache/export behavior', () {
    test(
      'cacheArtifact writes bytes to temporary cache with atomic rename',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'g6-artifact-cache',
        );
        addTearDown(() {
          if (workDir.existsSync()) {
            workDir.deleteSync(recursive: true);
          }
        });

        final downloadedBytes = utf8.encode('artifact-bytes');
        final backend = _FakeArtifactDownloadBackend(
          bytes: downloadedBytes,
          contentType: 'text/plain',
          artifactKey: 'artifact-fixture',
          contentHash: 'version-fixture',
        );
        final cacheProvider = _FakeArtifactCacheDirectoryProvider(
          Directory('${workDir.path}/cache'),
        );
        final service = DefaultSessionArtifactFileService(
          downloadBackend: backend,
          cacheDirectoryProvider: cacheProvider,
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final cached = await service.cacheArtifact(
          const SessionArtifactDescriptor(
            name: 'fixture.txt',
            artifactKey: 'artifact-fixture',
            contentHash: 'version-fixture',
            fetchUrl: 'https://broker/sessions/unit/artifact/fixture',
            mimeType: 'text/plain',
          ),
        );

        expect(cached.byteLength, downloadedBytes.length);
        expect(cached.fileName, 'fixture.txt');
        expect(cached.contentType, 'text/plain');
        expect(File(cached.cachedFilePath).existsSync(), isTrue);
        expect(File('${cached.cachedFilePath}.part').existsSync(), isFalse);
        expect(
          backend.requestUrl,
          'https://broker/sessions/unit/artifact/fixture',
        );
      },
    );

    test(
      'cacheArtifact rejects a response for another artifact identity',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'artifact-identity-mismatch',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });
        final service = DefaultSessionArtifactFileService(
          downloadBackend: _FakeArtifactDownloadBackend(
            bytes: utf8.encode('wrong artifact'),
            artifactKey: 'artifact-other',
            contentHash: 'version-expected',
          ),
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        await expectLater(
          service.cacheArtifact(
            const SessionArtifactDescriptor(
              name: 'fixture.txt',
              artifactKey: 'artifact-expected',
              contentHash: 'version-expected',
              fetchUrl:
                  'https://broker/sessions/tool/session/artifact/expected',
            ),
          ),
          throwsA(isA<StateError>()),
        );
        expect(workDir.listSync(), isEmpty);
      },
    );

    test(
      'cacheArtifact rejects a response for another artifact version',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'artifact-version-mismatch',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });
        final service = DefaultSessionArtifactFileService(
          downloadBackend: _FakeArtifactDownloadBackend(
            bytes: utf8.encode('wrong version'),
            artifactKey: 'artifact-expected',
            contentHash: 'version-other',
          ),
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        await expectLater(
          service.cacheArtifact(
            const SessionArtifactDescriptor(
              name: 'fixture.txt',
              artifactKey: 'artifact-expected',
              contentHash: 'version-expected',
              fetchUrl:
                  'https://broker/sessions/tool/session/artifact/expected',
            ),
          ),
          throwsA(isA<StateError>()),
        );
        expect(workDir.listSync(), isEmpty);
      },
    );

    test(
      'cacheArtifact supports inline data URLs without network backend',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'g6-artifact-inline-cache',
        );
        addTearDown(() {
          if (workDir.existsSync()) {
            workDir.deleteSync(recursive: true);
          }
        });

        final cacheProvider = _FakeArtifactCacheDirectoryProvider(
          Directory('${workDir.path}/cache'),
        );
        final service = DefaultSessionArtifactFileService(
          downloadBackend: null,
          cacheDirectoryProvider: cacheProvider,
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final cached = await service.cacheArtifact(
          const SessionArtifactDescriptor(
            name: 'inline.txt',
            url: 'data:text/plain;base64,SGVsbG8gSW5saW5l',
          ),
        );

        expect(cached.byteLength, 12);
        expect(
          await File(cached.cachedFilePath).readAsString(),
          'Hello Inline',
        );
      },
    );

    test('cacheArtifact honors a pre-canceled cancellation token', () async {
      final workDir = await Directory.systemTemp.createTemp(
        'g10c-artifact-cache-cancel',
      );
      addTearDown(() {
        if (workDir.existsSync()) {
          workDir.deleteSync(recursive: true);
        }
      });

      final backend = _FakeArtifactDownloadBackend(
        bytes: utf8.encode('artifact-bytes'),
        contentType: 'text/plain',
      );
      final service = DefaultSessionArtifactFileService(
        downloadBackend: backend,
        cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
        saveTargetProvider: _FakeArtifactSaveTargetProvider(),
      );
      final token = SessionArtifactCancellationToken()
        ..cancel('Canceled by test');

      await expectLater(
        service.cacheArtifact(
          const SessionArtifactDescriptor(
            name: 'fixture.txt',
            fetchUrl: 'https://broker/sessions/unit/artifact/fixture',
            mimeType: 'text/plain',
          ),
          cancellationToken: token,
        ),
        throwsA(isA<SessionArtifactCanceledException>()),
      );
      expect(backend.requestUrl, isNull);
    });

    test('exportCachedArtifact persists selected destination path', () async {
      final workDir = await Directory.systemTemp.createTemp(
        'g6-artifact-export',
      );
      addTearDown(() {
        if (workDir.existsSync()) {
          workDir.deleteSync(recursive: true);
        }
      });

      final source = File('${workDir.path}/source.bin');
      await source.writeAsBytes(utf8.encode('exported'));
      final destination = '${workDir.path}/exported.bin';
      final saveProvider = _FakeArtifactSaveTargetProvider(destination);

      final service = DefaultSessionArtifactFileService(
        downloadBackend: null,
        cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
        saveTargetProvider: saveProvider,
      );

      final saved = await service.exportCachedArtifact(
        SessionArtifactCachedFile(
          cachedFilePath: '${workDir.path}/source.bin',
          fileName: 'source.bin',
          byteLength: 8,
        ),
      );

      expect(saved, destination);
      expect(await File(destination).readAsString(), 'exported');
      expect(saveProvider.lastSuggestion, 'source.bin');
    });

    test(
      'exportCachedArtifact returns null when user cancels save dialog',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'g6-artifact-export-cancel',
        );
        addTearDown(() {
          if (workDir.existsSync()) {
            workDir.deleteSync(recursive: true);
          }
        });

        final source = File('${workDir.path}/source.bin');
        await source.writeAsBytes([1, 2, 3]);

        final service = DefaultSessionArtifactFileService(
          downloadBackend: null,
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final saved = await service.exportCachedArtifact(
          SessionArtifactCachedFile(
            cachedFilePath: '${workDir.path}/source.bin',
            fileName: 'source.bin',
            byteLength: 3,
          ),
        );

        expect(saved, isNull);
      },
    );

    test('resumable session files commit bounded ranges in order', () async {
      final workDir = await Directory.systemTemp.createTemp(
        'session-file-ranges',
      );
      addTearDown(() {
        if (workDir.existsSync()) workDir.deleteSync(recursive: true);
      });
      final bytes = List<int>.generate(512 * 1024 + 17, (index) => index % 251);
      final backend = _FakeResumableDownloadBackend(bytes);
      final checkpoints = <SessionFileDownloadCheckpoint>[];
      final service = DefaultSessionArtifactFileService(
        downloadBackend: backend,
        cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
        saveTargetProvider: _FakeArtifactSaveTargetProvider(),
      );

      final cached = await service.cacheSessionFileResumable(
        tool: 'codex',
        sessionId: 'session-1',
        path: 'output/result.bin',
        fileName: 'result.bin',
        onCheckpoint: (checkpoint) async => checkpoints.add(checkpoint),
      );

      expect(backend.rangeStarts, [0, 512 * 1024]);
      expect(backend.ifRanges, [null, '"v1"']);
      expect(checkpoints.map((value) => value.bytesTransferred), [
        512 * 1024,
        bytes.length,
      ]);
      expect(checkpoints.last.etag, '"v1"');
      expect(await File(cached.cachedFilePath).readAsBytes(), bytes);
      expect(File('${cached.cachedFilePath}.part').existsSync(), isFalse);
    });

    test(
      'resumable session files continue from a flushed checkpoint',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'session-file-restart',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });
        final bytes = List<int>.generate(4096, (index) => index % 199);
        final partial = File('${workDir.path}/restart.bin.part');
        await partial.writeAsBytes(bytes.take(321).toList(), flush: true);
        final backend = _FakeResumableDownloadBackend(bytes);
        final service = DefaultSessionArtifactFileService(
          downloadBackend: backend,
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final cached = await service.cacheSessionFileResumable(
          tool: 'codex',
          sessionId: 'session-1',
          path: 'restart.bin',
          fileName: 'restart.bin',
          checkpoint: SessionFileDownloadCheckpoint(
            partialFilePath: partial.path,
            bytesTransferred: 321,
            totalBytes: bytes.length,
            etag: '"v1"',
          ),
        );

        expect(backend.rangeStarts.single, 321);
        expect(backend.ifRanges.single, '"v1"');
        expect(await File(cached.cachedFilePath).readAsBytes(), bytes);
      },
    );

    test('empty session files complete from the broker 416 boundary', () async {
      final workDir = await Directory.systemTemp.createTemp(
        'session-file-empty',
      );
      addTearDown(() {
        if (workDir.existsSync()) workDir.deleteSync(recursive: true);
      });
      final backend = _FakeResumableDownloadBackend(const []);
      final service = DefaultSessionArtifactFileService(
        downloadBackend: backend,
        cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
        saveTargetProvider: _FakeArtifactSaveTargetProvider(),
      );

      final cached = await service.cacheSessionFileResumable(
        tool: 'codex',
        sessionId: 'session-1',
        path: 'empty.txt',
        fileName: 'empty.txt',
      );

      expect(cached.byteLength, 0);
      expect(await File(cached.cachedFilePath).readAsBytes(), isEmpty);
      expect(backend.rangeStarts, [0]);
    });

    test(
      'validator-less 206 falls back to a full download without corruption',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'session-file-no-validator',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });
        final bytes = List<int>.generate(
          512 * 1024 + 128,
          (index) => index % 97,
        );
        final backend = _ValidatorlessResumableDownloadBackend(bytes);
        final service = DefaultSessionArtifactFileService(
          downloadBackend: backend,
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final cached = await service.cacheSessionFileResumable(
          tool: 'codex',
          sessionId: 'session-1',
          path: 'output/result.bin',
          fileName: 'result.bin',
        );

        // One un-ranged full download completed the file; no blind chunked
        // append of a possibly-changed representation occurred.
        expect(backend.fullDownloadCount, 1);
        expect(backend.rangeStarts, [0]);
        expect(cached.byteLength, bytes.length);
        expect(await File(cached.cachedFilePath).readAsBytes(), bytes);
        // No mixed-representation partial file was left behind.
        expect(
          workDir
              .listSync()
              .where((entity) => entity.path.endsWith('.part'))
              .toList(),
          isEmpty,
        );
      },
    );

    test(
      'final name adopts an extension from the response content-type',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'session-file-content-type-ext',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });
        final bytes = List<int>.generate(2048, (index) => index % 131);
        final backend = _FakeResumableDownloadBackend(
          bytes,
          contentType: 'text/plain',
        );
        final service = DefaultSessionArtifactFileService(
          downloadBackend: backend,
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        // The caller-supplied name has no extension; the server-sniffed
        // content-type must add one, matching the single-shot path.
        final cached = await service.cacheSessionFileResumable(
          tool: 'codex',
          sessionId: 'session-1',
          path: 'notes',
          fileName: 'notes',
        );

        expect(cached.fileName, 'notes.txt');
        expect(cached.cachedFilePath, '${workDir.path}/notes.txt');
        expect(cached.contentType, 'text/plain');
        expect(await File(cached.cachedFilePath).readAsBytes(), bytes);
        expect(File('${cached.cachedFilePath}.part').existsSync(), isFalse);
      },
    );

    test(
      'an artifact download continues from each offset instead of restarting',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'artifact-range-resume',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });

        final bytes = List<int>.generate(
          512 * 1024 * 2 + 100,
          (index) => index % 251,
        );
        final backend = _FakeRangedArtifactBackend(bytes);
        final service = DefaultSessionArtifactFileService(
          downloadBackend: backend,
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final cached = await service.cacheArtifact(
          const SessionArtifactDescriptor(
            name: 'report.bin',
            artifactKey: 'artifact-ranged',
            fetchUrl: 'https://broker/sessions/unit/artifact/ranged',
            mimeType: 'application/octet-stream',
          ),
        );

        // Successive offsets and no second request at 0: an artifact download
        // that outlives its signature is resumed at the byte it reached rather
        // than restarted, which is the whole point of the range plumbing.
        expect(backend.rangeStarts, [0, 512 * 1024, 512 * 1024 * 2]);
        expect(backend.wholeFetches, 0);
        expect(backend.ifRanges, [null, '"v1"', '"v1"']);
        expect(await File(cached.cachedFilePath).readAsBytes(), bytes);
        expect(cached.byteLength, bytes.length);
        expect(File('${cached.cachedFilePath}.part').existsSync(), isFalse);
      },
    );

    test(
      'an artifact whose representation changes mid-download discards the '
      'partial',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'artifact-range-changed',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });

        final bytes = List<int>.generate(
          512 * 1024 * 2 + 100,
          (index) => index % 251,
        );
        final backend = _FakeRangedArtifactBackend(bytes, revalidateAfter: 1);
        final service = DefaultSessionArtifactFileService(
          downloadBackend: backend,
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final cached = await service.cacheArtifact(
          const SessionArtifactDescriptor(
            name: 'report.bin',
            fetchUrl: 'https://broker/sessions/unit/artifact/changed',
            mimeType: 'application/octet-stream',
          ),
        );

        // The new representation is never appended to the old one: the partial
        // is truncated and the transfer starts again from 0, exactly once.
        expect(backend.rangeStarts.first, 0);
        expect(backend.rangeStarts.where((start) => start == 0), hasLength(2));
        expect(await File(cached.cachedFilePath).readAsBytes(), bytes);
        expect(File('${cached.cachedFilePath}.part').existsSync(), isFalse);
      },
    );

    test(
      'an artifact 206 without a validator falls back to one whole fetch',
      () async {
        final workDir = await Directory.systemTemp.createTemp(
          'artifact-range-validatorless',
        );
        addTearDown(() {
          if (workDir.existsSync()) workDir.deleteSync(recursive: true);
        });

        final bytes = utf8.encode('validatorless artifact');
        final backend = _FakeRangedArtifactBackend(bytes, withValidator: false);
        final service = DefaultSessionArtifactFileService(
          downloadBackend: backend,
          cacheDirectoryProvider: _FakeArtifactCacheDirectoryProvider(workDir),
          saveTargetProvider: _FakeArtifactSaveTargetProvider(),
        );

        final cached = await service.cacheArtifact(
          const SessionArtifactDescriptor(
            name: 'plain.txt',
            fetchUrl: 'https://broker/sessions/unit/artifact/plain',
            mimeType: 'text/plain',
          ),
        );

        // A 206 carrying no validator cannot guard the next range, so resuming
        // would be unsafe: it fails closed to one un-ranged fetch.
        expect(backend.wholeFetches, 1);
        expect(await File(cached.cachedFilePath).readAsBytes(), bytes);
      },
    );
  });
}

/// A backend that serves signed artifacts as ranges, the way the broker does.
///
/// [revalidateAfter] flips the ETag once after that many ranged responses, to
/// model the artifact being replaced mid-transfer. [withValidator] false serves
/// 206 responses carrying no ETag and no Last-Modified at all.
class _FakeRangedArtifactBackend
    implements ArtifactDownloadBackend, ResumableSignedArtifactDownloadBackend {
  _FakeRangedArtifactBackend(
    List<int> bytes, {
    this.revalidateAfter,
    this.withValidator = true,
  }) : bytes = List<int>.unmodifiable(bytes);

  final List<int> bytes;
  final int? revalidateAfter;
  final bool withValidator;
  final List<int> rangeStarts = [];
  final List<String?> ifRanges = [];
  int wholeFetches = 0;
  var _served = 0;
  var _revalidated = false;

  String get _etag => _revalidated ? '"v2"' : '"v1"';

  @override
  Future<ArtifactDownload> fetchArtifactUrl(String url) async {
    wholeFetches++;
    return ArtifactDownload(
      bytes: bytes,
      contentLength: bytes.length,
      contentType: 'application/octet-stream',
    );
  }

  @override
  Future<ArtifactDownload> fetchSessionFile(
    String tool,
    String sessionId,
    String path,
  ) async => throw UnimplementedError();

  @override
  Future<ArtifactDownload> fetchArtifactUrlRange(
    String url, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  }) async {
    rangeStarts.add(rangeStart);
    ifRanges.add(ifRange);
    if (revalidateAfter != null &&
        !_revalidated &&
        _served == revalidateAfter) {
      _revalidated = true;
    }
    _served++;
    if (rangeStart >= bytes.length) {
      return ArtifactDownload(
        bytes: const [],
        statusCode: 416,
        acceptRanges: 'bytes',
        contentRange: 'bytes */${bytes.length}',
        etag: withValidator ? _etag : null,
      );
    }
    final end = rangeEnd.clamp(rangeStart, bytes.length - 1);
    final chunk = bytes.sublist(rangeStart, end + 1);
    return ArtifactDownload(
      bytes: chunk,
      statusCode: 206,
      contentLength: chunk.length,
      contentType: 'application/octet-stream',
      acceptRanges: 'bytes',
      contentRange: 'bytes $rangeStart-$end/${bytes.length}',
      etag: withValidator ? _etag : null,
    );
  }
}

class _FakeBrowserBoundedDownloadBackend
    implements
        ArtifactDownloadBackend,
        BoundedArtifactDownloadBackend,
        ResumableArtifactDownloadBackend,
        BoundedResumableArtifactDownloadBackend {
  _FakeBrowserBoundedDownloadBackend({
    this.artifactBytes = const [],
    this.artifactKey,
    this.contentHash,
    this.artifactAdvertisedLength,
    this.sessionBytes = const [],
    this.sessionAdvertisedTotal,
    this.rangeContentLength,
  });

  final List<int> artifactBytes;
  final String? artifactKey;
  final String? contentHash;
  final int? artifactAdvertisedLength;
  final List<int> sessionBytes;
  final int? sessionAdvertisedTotal;
  final int? rangeContentLength;
  final List<int> artifactLimits = [];
  final List<int> rangeLimits = [];
  int boundedArtifactCalls = 0;
  int unboundedArtifactCalls = 0;
  int fullSessionCalls = 0;
  int boundedRangeCalls = 0;
  int unboundedRangeCalls = 0;

  @override
  Future<ArtifactDownload> fetchArtifactUrl(String url) {
    unboundedArtifactCalls += 1;
    throw StateError('unbounded artifact fetch must not be used on web');
  }

  @override
  Future<ArtifactDownload> fetchArtifactUrlBounded(
    String url, {
    required int maxBytes,
  }) async {
    boundedArtifactCalls += 1;
    artifactLimits.add(maxBytes);
    if ((artifactAdvertisedLength ?? artifactBytes.length) > maxBytes ||
        artifactBytes.length > maxBytes) {
      throw ArtifactTooLargeException(
        limit: maxBytes,
        advertised: artifactAdvertisedLength,
      );
    }
    return ArtifactDownload(
      bytes: artifactBytes,
      contentLength: artifactAdvertisedLength,
      artifactKey: artifactKey,
      contentHash: contentHash,
    );
  }

  @override
  Future<ArtifactDownload> fetchSessionFile(
    String tool,
    String sessionId,
    String path,
  ) {
    fullSessionCalls += 1;
    throw StateError('full workspace fetch must not be used on web');
  }

  @override
  Future<ArtifactDownload> fetchSessionFileRange(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  }) {
    unboundedRangeCalls += 1;
    throw StateError('unbounded range fetch must not be used on web');
  }

  @override
  Future<ArtifactDownload> fetchSessionFileRangeBounded(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    required int maxBytes,
    String? ifRange,
  }) async {
    boundedRangeCalls += 1;
    rangeLimits.add(maxBytes);
    final total = sessionAdvertisedTotal ?? sessionBytes.length;
    if (rangeStart >= sessionBytes.length) {
      return ArtifactDownload(
        bytes: const [],
        statusCode: 416,
        contentRange: 'bytes */$total',
      );
    }
    final end = rangeEnd < sessionBytes.length - 1
        ? rangeEnd
        : sessionBytes.length - 1;
    final chunk = sessionBytes.sublist(rangeStart, end + 1);
    if (chunk.length > maxBytes) {
      throw ArtifactTooLargeException(limit: maxBytes);
    }
    return ArtifactDownload(
      bytes: chunk,
      statusCode: 206,
      contentLength: rangeContentLength ?? chunk.length,
      contentType: 'application/octet-stream',
      etag: '"browser-v1"',
      acceptRanges: 'bytes',
      contentRange: 'bytes $rangeStart-$end/$total',
    );
  }
}

class _FakeArtifactDownloadBackend implements ArtifactDownloadBackend {
  _FakeArtifactDownloadBackend({
    required List<int> bytes,
    this.contentType,
    this.artifactKey,
    this.contentHash,
  }) : _bytes = List<int>.unmodifiable(bytes);

  final List<int> _bytes;
  final String? contentType;
  final String? artifactKey;
  final String? contentHash;
  String? requestUrl;

  @override
  Future<ArtifactDownload> fetchArtifactUrl(String url) async {
    requestUrl = url;
    return ArtifactDownload(
      bytes: _bytes,
      contentType: contentType,
      artifactKey: artifactKey,
      contentHash: contentHash,
    );
  }

  @override
  Future<ArtifactDownload> fetchSessionFile(
    String tool,
    String sessionId,
    String path,
  ) async {
    requestUrl = '$tool/$sessionId/$path';
    return ArtifactDownload(
      bytes: _bytes,
      contentType: contentType,
    );
  }
}

class _FakeResumableDownloadBackend
    implements ArtifactDownloadBackend, ResumableArtifactDownloadBackend {
  _FakeResumableDownloadBackend(
    List<int> bytes, {
    this.contentType = 'application/octet-stream',
  }) : bytes = List<int>.unmodifiable(bytes);

  final List<int> bytes;
  final String? contentType;
  final List<int> rangeStarts = [];
  final List<String?> ifRanges = [];

  @override
  Future<ArtifactDownload> fetchArtifactUrl(String url) {
    throw UnimplementedError();
  }

  @override
  Future<ArtifactDownload> fetchSessionFile(
    String tool,
    String sessionId,
    String path,
  ) async => ArtifactDownload(bytes: bytes, contentLength: bytes.length);

  @override
  Future<ArtifactDownload> fetchSessionFileRange(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  }) async {
    rangeStarts.add(rangeStart);
    ifRanges.add(ifRange);
    if (rangeStart >= bytes.length) {
      return ArtifactDownload(
        bytes: const [],
        statusCode: 416,
        etag: '"v1"',
        acceptRanges: 'bytes',
        contentRange: 'bytes */${bytes.length}',
      );
    }
    final end = rangeEnd.clamp(rangeStart, bytes.length - 1);
    final chunk = bytes.sublist(rangeStart, end + 1);
    return ArtifactDownload(
      bytes: chunk,
      statusCode: 206,
      contentLength: chunk.length,
      contentType: contentType,
      etag: '"v1"',
      acceptRanges: 'bytes',
      contentRange: 'bytes $rangeStart-$end/${bytes.length}',
    );
  }
}

/// A resumable backend that serves 206 ranges with no representation validator
/// (no ETag, no Last-Modified) but answers the un-ranged full download.
class _ValidatorlessResumableDownloadBackend
    implements ArtifactDownloadBackend, ResumableArtifactDownloadBackend {
  _ValidatorlessResumableDownloadBackend(List<int> bytes)
    : bytes = List<int>.unmodifiable(bytes);

  final List<int> bytes;
  final List<int> rangeStarts = [];
  int fullDownloadCount = 0;

  @override
  Future<ArtifactDownload> fetchArtifactUrl(String url) {
    throw UnimplementedError();
  }

  @override
  Future<ArtifactDownload> fetchSessionFile(
    String tool,
    String sessionId,
    String path,
  ) async {
    fullDownloadCount += 1;
    return ArtifactDownload(
      bytes: bytes,
      contentLength: bytes.length,
    );
  }

  @override
  Future<ArtifactDownload> fetchSessionFileRange(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  }) async {
    rangeStarts.add(rangeStart);
    final end = rangeEnd.clamp(rangeStart, bytes.length - 1);
    final chunk = bytes.sublist(rangeStart, end + 1);
    return ArtifactDownload(
      bytes: chunk,
      statusCode: 206,
      contentLength: chunk.length,
      acceptRanges: 'bytes',
      contentRange: 'bytes $rangeStart-$end/${bytes.length}',
    );
  }
}

class _FakeArtifactCacheDirectoryProvider
    implements ArtifactCacheDirectoryProvider {
  _FakeArtifactCacheDirectoryProvider(this.directory);

  final Directory directory;

  @override
  Future<Directory> cacheDirectory() async {
    await directory.create(recursive: true);
    return directory;
  }
}

class _FakeArtifactSaveTargetProvider implements ArtifactSaveTargetProvider {
  _FakeArtifactSaveTargetProvider([this.selectedPath]);

  final String? selectedPath;
  String? lastSuggestion;

  @override
  Future<String?> pickSavePath({
    required String suggestedName,
    String? mimeType,
  }) async {
    lastSuggestion = suggestedName;
    return selectedPath;
  }
}
