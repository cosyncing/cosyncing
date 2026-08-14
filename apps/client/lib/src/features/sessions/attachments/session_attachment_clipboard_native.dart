import 'dart:io';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_types.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_intake.dart';
import 'package:pasteboard/pasteboard.dart';

/// Creates the native desktop clipboard adapter.
SessionAttachmentClipboard createSessionAttachmentClipboard() =>
    const _NativeSessionAttachmentClipboard();

final class _NativeSessionAttachmentClipboard
    implements SessionAttachmentClipboard {
  const _NativeSessionAttachmentClipboard();

  @override
  bool get usesWebPasteEvents => false;

  @override
  bool get usesWebDropEvents => false;

  @override
  void addWebPasteListener(SessionAttachmentWebPasteListener listener) {}

  @override
  void removeWebPasteListener(SessionAttachmentWebPasteListener listener) {}

  @override
  void addWebDropListener(SessionAttachmentWebDropListener listener) {}

  @override
  void removeWebDropListener(SessionAttachmentWebDropListener listener) {}

  @override
  Future<SessionAttachmentClipboardRead> readNative({
    bool Function()? isActive,
  }) async {
    void requireActive() {
      if (isActive != null && !isActive()) {
        throw const SessionAttachmentIntakeException('cancelled');
      }
    }

    // The bound travels into the platform: native code stops after this many
    // paths, so a clipboard holding thousands of them is never enumerated,
    // marshalled, or allocated in this isolate. A1 needs only one entry past
    // the limit to prove overflow, so ask for exactly that many.
    final paths = await Pasteboard.files(
      limit: sessionAttachmentMaxSnapshotFiles + 1,
    ).timeout(sessionAttachmentIntakeTimeout);
    requireActive();
    if (paths.length > sessionAttachmentMaxSnapshotFiles) {
      throw const SessionAttachmentIntakeException('selection-size');
    }
    if (paths.isNotEmpty) {
      final items = <SessionAttachmentIntakeItem>[];
      for (final path in paths) {
        // The synchronous variants block the UI isolate for the whole
        // enumeration and cannot be bounded by a timeout; the list is already
        // capped above, so the async round trips are the cheaper hazard.
        // ignore: avoid_slow_async_io
        final type = await FileSystemEntity.type(
          path,
        ).timeout(sessionAttachmentIntakeTimeout);
        if (type != FileSystemEntityType.file) {
          throw const SessionAttachmentIntakeException('not-regular-file');
        }
        requireActive();
        final file = File(path);
        final length = await file.length().timeout(
          sessionAttachmentIntakeTimeout,
        );
        if (length > promptAttachmentMaxFileBytes) {
          throw const SessionAttachmentIntakeException('file-size');
        }
        requireActive();
        items.add(
          CallbackSessionAttachmentIntakeItem(
            name: path,
            byteLength: length,
            currentByteLength: file.length,
            openReadCallback: ({int start = 0, int? end}) =>
                file.openRead(start, end),
          ),
        );
      }
      return SessionAttachmentClipboardFiles(List.unmodifiable(items));
    }

    // Both bounds travel into the platform. The file limit is what A1 will
    // accept and is applied to the encoded bytes; the decoded ceiling is what
    // the plugin may allocate on the way there, refused before any encode.
    // They are separate on purpose, because a PNG's size does not follow from
    // its pixel count; see [sessionAttachmentMaxDecodedImageBytes]. The
    // toolkit's own decode is not ours to prevent either way.
    final Uint8List? image;
    try {
      image = await Pasteboard.boundedImage(
        maxBytes: promptAttachmentMaxFileBytes,
        maxDecodedBytes: sessionAttachmentMaxDecodedImageBytes,
      ).timeout(sessionAttachmentIntakeTimeout);
    } on PasteboardLimitExceeded {
      throw const SessionAttachmentIntakeException('file-size');
    }
    requireActive();
    if (image != null) {
      if (image.length > promptAttachmentMaxFileBytes) {
        throw const SessionAttachmentIntakeException('file-size');
      }
      return SessionAttachmentClipboardFiles([
        MemorySessionAttachmentIntakeItem(bytes: image),
      ]);
    }
    final text = await Pasteboard.text.timeout(sessionAttachmentIntakeTimeout);
    return SessionAttachmentClipboardText(text);
  }

  @override
  Future<String?> readNativeText() =>
      Pasteboard.text.timeout(sessionAttachmentIntakeTimeout);
}
