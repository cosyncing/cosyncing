import 'dart:convert';
import 'dart:typed_data';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('FileSelectorSessionAttachmentPicker', () {
    test('returns an empty list when selection is canceled', () async {
      final picker = FileSelectorSessionAttachmentPicker(
        source: _FakeSessionAttachmentSource(),
      );

      final result = await picker.pickAttachments();

      expect(result, isEmpty);
    });

    test(
      'returns encoded attachment data with original byte length and mime type',
      () async {
        final picker = FileSelectorSessionAttachmentPicker(
          source: _FakeSessionAttachmentSource(
            selectedFile: SessionAttachmentSelectedFile(
              name: 'notes.txt',
              path: '/tmp/ignored.txt',
              mimeType: 'text/plain',
              length: () async => 4,
              openRead: ({int start = 0, int? end}) => Stream.value(
                Uint8List.fromList([116, 101, 115, 116]).sublist(start, end),
              ),
            ),
          ),
        );

        final result = await picker.pickAttachments();

        expect(result, hasLength(1));
        expect(result.single.name, 'notes.txt');
        expect(result.single.byteLength, 4);
        expect(result.single.mimeType, 'text/plain');
        expect(
          result.single.data,
          base64Encode(Uint8List.fromList([116, 101, 115, 116])),
        );
      },
    );

    test('falls back to path filename when name is empty', () async {
      final picker = FileSelectorSessionAttachmentPicker(
        source: _FakeSessionAttachmentSource(
          selectedFile: SessionAttachmentSelectedFile(
            name: '',
            path: r'C:\work\notes\backup.bin',
            mimeType: null,
            length: () async => 2,
            openRead: ({int start = 0, int? end}) => Stream.value(
              Uint8List.fromList([0x01, 0x02]).sublist(start, end),
            ),
          ),
        ),
      );

      final result = await picker.pickAttachments();

      expect(result.single.name, 'backup.bin');
      expect(result.single.byteLength, 2);
    });

    test(
      'throws SessionAttachmentTooLargeException with selected file metadata',
      () async {
        final picker = FileSelectorSessionAttachmentPicker(
          maxBytes: 3,
          source: _FakeSessionAttachmentSource(
            selectedFile: SessionAttachmentSelectedFile(
              name: 'big.bin',
              path: '/tmp/big.bin',
              mimeType: 'application/octet-stream',
              length: () async => 4,
              openRead: ({int start = 0, int? end}) => Stream.value(
                Uint8List.fromList([1, 2, 3, 4]).sublist(start, end),
              ),
            ),
          ),
        );

        expect(
          () => picker.pickAttachments(),
          throwsA(
            isA<SessionAttachmentTooLargeException>()
                .having((e) => e.fileName, 'fileName', 'big.bin')
                .having((e) => e.byteLength, 'byteLength', 4)
                .having((e) => e.maxBytes, 'maxBytes', 3),
          ),
        );
      },
    );

    test(
      'retains a range source instead of reading or encoding large files',
      () async {
        var openCount = 0;
        final picker = FileSelectorSessionAttachmentPicker(
          source: _FakeSessionAttachmentSource(
            selectedFile: SessionAttachmentSelectedFile(
              name: 'large.bin',
              path: '/tmp/large.bin',
              mimeType: 'application/octet-stream',
              length: () async => promptAttachmentInlineFileMaxBytes + 1,
              openRead: ({int start = 0, int? end}) {
                openCount++;
                return Stream.value(Uint8List(end! - start));
              },
            ),
          ),
        );

        final result = await picker.pickAttachments();

        expect(
          openCount,
          0,
          reason: 'selection must not materialize large bytes',
        );
        expect(result.single.data, isNull);
        expect(result.single.byteSource, isNotNull);
        final chunks = await result.single.openRead(start: 4, end: 12).toList();
        expect(chunks.single, hasLength(8));
        expect(openCount, 1);
      },
    );
  });
}

final class _FakeSessionAttachmentSource
    implements SessionAttachmentFileSource {
  _FakeSessionAttachmentSource({this.selectedFile});

  final SessionAttachmentSelectedFile? selectedFile;

  @override
  Future<List<SessionAttachmentSelectedFile>> pickFiles({
    required bool allowMultiple,
  }) async => selectedFile == null ? const [] : [selectedFile!];
}
