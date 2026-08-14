import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_native.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_types.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_intake.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const pasteboard = MethodChannel('pasteboard');
  late Directory workspace;
  late List<String> clipboardPaths;
  late Uint8List? clipboardImage;
  late String? clipboardText;
  late List<String> statted;
  late List<MethodCall> platformCalls;

  /// Set when the platform should refuse the image as over-bound.
  late bool platformRefusesImage;

  int? argument(String method, String name) {
    for (final call in platformCalls) {
      if (call.method != method) continue;
      final args = call.arguments;
      if (args is Map && args[name] is int) return args[name] as int;
    }
    return null;
  }

  /// Counts every path the adapter actually touches on the filesystem.
  String track(String path) {
    statted.add(path);
    return path;
  }

  setUp(() {
    workspace = Directory.systemTemp.createTempSync('a1b-clipboard');
    clipboardPaths = const [];
    clipboardImage = null;
    clipboardText = null;
    statted = [];
    platformCalls = [];
    platformRefusesImage = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pasteboard, (call) async {
          platformCalls.add(call);
          final args = call.arguments;
          switch (call.method) {
            case 'files':
              // Behave like the bounded native code: never hand back more
              // entries than the caller asked for.
              final limit = args is Map ? args['limit'] as int? : null;
              return limit == null || clipboardPaths.length <= limit
                  ? clipboardPaths
                  : clipboardPaths.sublist(0, limit);
            case 'image':
              if (platformRefusesImage) {
                throw PlatformException(
                  code: 'image-too-large',
                  message: 'clipboard image exceeds the caller bound',
                );
              }
              return clipboardImage;
          }
          return null;
        });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.getData') {
            return clipboardText == null
                ? null
                : <String, dynamic>{'text': clipboardText};
          }
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      ..setMockMethodCallHandler(pasteboard, null)
      ..setMockMethodCallHandler(SystemChannels.platform, null);
    workspace.deleteSync(recursive: true);
  });

  String writeFile(String name, {int bytes = 4}) {
    final file = File('${workspace.path}/$name')
      ..writeAsBytesSync(List<int>.filled(bytes, 1));
    return file.path;
  }

  group('native clipboard intake bounds', () {
    test('sends the list bound to the platform and refuses overflow', () async {
      // The first entry is a directory: reaching per-file work would classify
      // it as not-regular-file, so a selection-size failure proves the list
      // was bounded before the adapter statted anything.
      clipboardPaths = [
        workspace.path,
        ...List.generate(
          sessionAttachmentMaxSnapshotFiles + 4,
          (index) => '${workspace.path}/missing-$index.png',
        ),
      ];

      await expectLater(
        createSessionAttachmentClipboard().readNative(),
        throwsA(
          isA<SessionAttachmentIntakeException>().having(
            (error) => error.reason,
            'reason',
            'selection-size',
          ),
        ),
      );
      // The bound travels into native code: one entry past the limit, which
      // is all A1 needs to prove overflow.
      expect(
        argument('files', 'limit'),
        sessionAttachmentMaxSnapshotFiles + 1,
      );
    });

    test('accepts exactly the bounded witness A1 needs for overflow', () async {
      clipboardPaths = List.generate(
        sessionAttachmentMaxSnapshotFiles,
        (index) => writeFile('witness-$index.png'),
      );

      final read = await createSessionAttachmentClipboard().readNative();

      expect(read, isA<SessionAttachmentClipboardFiles>());
      expect(
        (read as SessionAttachmentClipboardFiles).items,
        hasLength(sessionAttachmentMaxSnapshotFiles),
      );
      // One past the eight-file limit, so A1 still gets to reject it.
      expect(
        sessionAttachmentMaxSnapshotFiles,
        greaterThan(promptAttachmentMaxFiles),
      );
    });

    test('rejects a file past the per-file byte bound', () async {
      final oversized = File('${workspace.path}/huge.bin');
      // Sparse, so the bound is exercised without writing 64 MiB.
      oversized.openSync(mode: FileMode.write)
        ..truncateSync(promptAttachmentMaxFileBytes + 1)
        ..closeSync();
      clipboardPaths = [oversized.path];

      await expectLater(
        createSessionAttachmentClipboard().readNative(),
        throwsA(
          isA<SessionAttachmentIntakeException>().having(
            (error) => error.reason,
            'reason',
            'file-size',
          ),
        ),
      );
    });

    test('stops filesystem work once the gesture is inactive', () async {
      clipboardPaths = List.generate(
        4,
        (index) => track(writeFile('active-$index.png')),
      );
      statted = [];
      var probes = 0;

      await expectLater(
        createSessionAttachmentClipboard().readNative(
          isActive: () {
            probes += 1;
            return probes <= 1;
          },
        ),
        throwsA(
          isA<SessionAttachmentIntakeException>().having(
            (error) => error.reason,
            'reason',
            'cancelled',
          ),
        ),
      );
      // Cancelled inside the first file, long before the fourth.
      expect(probes, lessThan(4));
    });

    test('sends the image bound and honours a native refusal', () async {
      // The platform compares the decoded size against the bound and refuses
      // before encoding, so nothing oversized is ever allocated here.
      platformRefusesImage = true;

      await expectLater(
        createSessionAttachmentClipboard().readNative(),
        throwsA(
          isA<SessionAttachmentIntakeException>().having(
            (error) => error.reason,
            'reason',
            'file-size',
          ),
        ),
      );
      expect(argument('image', 'maxBytes'), promptAttachmentMaxFileBytes);
      // The allocation ceiling is a separate number from the file limit: a
      // PNG's size does not follow from its pixel count, so comparing decoded
      // pixels against the 64 MiB file budget would refuse ordinary large
      // screenshots.
      expect(
        argument('image', 'maxDecodedBytes'),
        sessionAttachmentMaxDecodedImageBytes,
      );
      expect(
        sessionAttachmentMaxDecodedImageBytes,
        greaterThan(promptAttachmentMaxFileBytes),
      );
    });

    test('still rejects an oversized image the platform let through', () async {
      clipboardImage = Uint8List(promptAttachmentMaxFileBytes + 1);

      await expectLater(
        createSessionAttachmentClipboard().readNative(),
        throwsA(
          isA<SessionAttachmentIntakeException>().having(
            (error) => error.reason,
            'reason',
            'file-size',
          ),
        ),
      );
      clipboardImage = null;
    });

    test('falls through to plain text when no files or image exist', () async {
      clipboardText = 'ordinary text';

      final read = await createSessionAttachmentClipboard().readNative();

      expect(read, isA<SessionAttachmentClipboardText>());
      expect((read as SessionAttachmentClipboardText).text, 'ordinary text');
    });

    test('reads plain text for a chord whose file probe failed', () async {
      clipboardText = 'recovered text';

      final text = await createSessionAttachmentClipboard().readNativeText();

      expect(text, 'recovered text');
    });
  });
}
