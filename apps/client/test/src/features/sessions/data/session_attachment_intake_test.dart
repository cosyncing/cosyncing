import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_attachment_intake.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionAttachmentIntakeMaterializer', () {
    const materializer = SessionAttachmentIntakeMaterializer();

    test('materializes screenshot bytes with a safe generated name', () async {
      final item = MemorySessionAttachmentIntakeItem(
        bytes: Uint8List.fromList([1, 2, 3, 4]),
      );

      final attachments = await materializer.materialize([item]);

      expect(attachments, hasLength(1));
      expect(attachments.single.name, 'screenshot.png');
      expect(attachments.single.mimeType, 'image/png');
      expect(attachments.single.byteLength, 4);
      expect(attachments.single.isInline, isTrue);
    });

    test('preserves multi-file order and strips source paths', () async {
      final first = _IntakeItem(
        bytes: Uint8List.fromList([1]),
        name: safeSessionAttachmentDisplayName(r'C:\copied\first.png'),
      );
      final second = _IntakeItem(
        bytes: Uint8List.fromList([2]),
        name: safeSessionAttachmentDisplayName('/copied/second.png'),
      );

      final attachments = await materializer.materialize([first, second]);

      expect(attachments.map((item) => item.name), ['first.png', 'second.png']);
      expect(first.openCount, 1);
      expect(second.openCount, 1);
    });

    test('keeps large files streamed and re-openable by range', () async {
      final bytes = Uint8List(promptAttachmentInlineFileMaxBytes + 4);
      for (var index = 0; index < bytes.length; index++) {
        bytes[index] = index % 251;
      }
      final item = _IntakeItem(bytes: bytes, name: 'large.png');

      final attachment = (await materializer.materialize([item])).single;
      final first = await attachment
          .openRead(start: 7, end: 19)
          .expand((e) => e)
          .toList();
      final retry = await attachment
          .openRead(start: 7, end: 19)
          .expand((e) => e)
          .toList();

      expect(attachment.isInline, isFalse);
      expect(first, bytes.sublist(7, 19));
      expect(retry, first);
      expect(item.openCount, 2);
    });

    test('rejects oversized input before reading payload bytes', () async {
      final item = _IntakeItem(
        name: 'too-large.bin',
        byteLength: promptAttachmentMaxFileBytes + 1,
        bytes: Uint8List(0),
      );

      await expectLater(
        materializer.materialize([item]),
        throwsA(isA<SessionAttachmentIntakeException>()),
      );
      expect(item.openCount, 0);
    });

    test('capacity overflow is atomic and leaves overflow unread', () async {
      final items = List.generate(
        promptAttachmentMaxFiles + 1,
        (index) => _IntakeItem(
          name: '$index.txt',
          byteLength: 1,
          bytes: Uint8List.fromList([index]),
        ),
      );

      await expectLater(
        materializer.materialize(items),
        throwsA(isA<SessionAttachmentIntakeException>()),
      );
      expect(items.last.openCount, 0);
    });

    test('rejects a changing inline item', () async {
      final item = _IntakeItem(
        name: 'changed.txt',
        byteLength: 2,
        bytes: Uint8List.fromList([1]),
      );

      await expectLater(
        materializer.materialize([item]),
        throwsA(isA<SessionAttachmentIntakeException>()),
      );
    });

    test('rejects inline native file growth after its bounded read', () async {
      var currentLength = 2;
      final item = CallbackSessionAttachmentIntakeItem(
        name: 'growing.txt',
        byteLength: 2,
        currentByteLength: () async => currentLength,
        openReadCallback: ({int start = 0, int? end}) async* {
          yield Uint8List.fromList([1, 2]);
          currentLength = 3;
        },
      );

      await expectLater(
        materializer.materialize([item]),
        throwsA(
          isA<SessionAttachmentIntakeException>().having(
            (error) => error.reason,
            'reason',
            'changed-during-read',
          ),
        ),
      );
    });

    test('bounds a stalled recheck instead of blocking on it', () async {
      // Models a UNC path or a slow network mount: the stat never answers.
      // A synchronous recheck would hold the UI isolate here with no timeout
      // able to interrupt it.
      final item = CallbackSessionAttachmentIntakeItem(
        name: 'stalled.txt',
        byteLength: 2,
        currentByteLength: () => Completer<int>().future,
        openReadCallback: ({int start = 0, int? end}) =>
            Stream.value(Uint8List.fromList([1, 2])),
      );

      await expectLater(
        const SessionAttachmentIntakeMaterializer(
          timeout: Duration(milliseconds: 50),
        ).materialize([item]),
        throwsA(isA<TimeoutException>()),
      );
    });

    test('rejects empty unsupported intake honestly', () async {
      await expectLater(
        materializer.materialize(const []),
        throwsA(isA<SessionAttachmentIntakeException>()),
      );
    });

    test('timeout cancels the underlying stream subscription', () async {
      var cancelled = false;
      final controller = StreamController<List<int>>(
        onCancel: () => cancelled = true,
      );
      final item = _IntakeItem(
        name: 'stalled.bin',
        byteLength: 1,
        openReadOverride: ({int start = 0, int? end}) => controller.stream,
      );

      await expectLater(
        const SessionAttachmentIntakeMaterializer(
          timeout: Duration(milliseconds: 1),
        ).materialize([item]),
        throwsA(isA<SessionAttachmentIntakeException>()),
      );
      expect(cancelled, isTrue);
      await controller.close();
    });
  });

  group('applySessionComposerTextPaste', () {
    test('preserves ordinary and rich-text fallback insertion semantics', () {
      const value = TextEditingValue(
        text: 'before after',
        selection: TextSelection(baseOffset: 7, extentOffset: 12),
      );

      final result = applySessionComposerTextPaste(value, 'rich fallback');

      expect(result.text, 'before rich fallback');
      expect(result.selection, const TextSelection.collapsed(offset: 20));
    });

    test('leaves active IME composition untouched', () {
      const value = TextEditingValue(
        text: 'compose',
        selection: TextSelection.collapsed(offset: 7),
        composing: TextRange(start: 0, end: 7),
      );

      expect(applySessionComposerTextPaste(value, 'paste'), same(value));
    });
  });

  group('mapSessionComposerOffset', () {
    test('keeps the paste point when the edit lands after it', () {
      expect(mapSessionComposerOffset('head tail', 'head tailZZ', 4), 4);
    });

    test('shifts the paste point when the edit lands before it', () {
      expect(mapSessionComposerOffset('head tail', 'ZZhead tail', 4), 6);
      expect(mapSessionComposerOffset('head tail', 'ad tail', 4), 2);
    });

    test('is identity when nothing changed', () {
      expect(mapSessionComposerOffset('same', 'same', 3), 3);
    });

    test('gives up only when the edit covers the paste point', () {
      expect(mapSessionComposerOffset('head tail', 'hZZl', 4), isNull);
    });
  });

  group('SessionAttachmentEventMemory', () {
    test('rejects duplicate delivery of the same event identity', () {
      final memory = SessionAttachmentEventMemory();
      final first = Object();
      final second = Object();

      expect(memory.admit(first), isTrue);
      expect(memory.admit(first), isFalse);
      expect(memory.contains(first), isTrue);
      expect(memory.admit(second), isTrue);
      expect(memory.length, 2);
    });

    test('stays bounded and evicts oldest first past capacity', () {
      final memory = SessionAttachmentEventMemory();
      final events = List.generate(
        sessionAttachmentEventMemoryCapacity + 8,
        (_) => Object(),
      );

      for (final event in events) {
        expect(memory.admit(event), isTrue);
      }

      expect(memory.length, sessionAttachmentEventMemoryCapacity);
      // The oldest eight were evicted; the newest capacity are still deduped.
      expect(
        events.take(8).map(memory.contains),
        everyElement(isFalse),
      );
      expect(
        events.skip(8).map(memory.contains),
        everyElement(isTrue),
      );
      expect(memory.admit(events.last), isFalse);
      expect(memory.admit(events.first), isTrue);
    });

    test('identity memory does not fold equal-but-distinct events', () {
      final memory = SessionAttachmentEventMemory(capacity: 2);

      expect(memory.admit(const _EqualEvent(1)), isTrue);
      expect(memory.admit(const _EqualEvent(2)), isTrue);
      expect(memory.length, 2);
    });
  });
}

/// Two structurally equal events that must still be admitted separately.
@immutable
final class _EqualEvent {
  const _EqualEvent(this.tag);

  final int tag;

  @override
  bool operator ==(Object other) => other is _EqualEvent;

  @override
  int get hashCode => 0;
}

final class _IntakeItem implements SessionAttachmentIntakeItem {
  _IntakeItem({
    required this.name,
    int? byteLength,
    this.bytes,
    this.openReadOverride,
  }) : _declaredLength = byteLength;

  @override
  final String name;

  final int? _declaredLength;
  final Uint8List? bytes;
  final Stream<List<int>> Function({int start, int? end})? openReadOverride;

  @override
  int get byteLength => _declaredLength ?? bytes!.length;

  @override
  String? get mimeType => null;

  int openCount = 0;

  @override
  Stream<List<int>> openRead({int start = 0, int? end}) {
    openCount += 1;
    final override = openReadOverride;
    if (override != null) return override(start: start, end: end);
    final value = bytes!;
    final safeEnd = end == null ? value.length : end.clamp(start, value.length);
    return Stream.value(Uint8List.sublistView(value, start, safeEnd));
  }
}
