// The device edges attachments come through (F04c): the file picker, the
// system clipboard and the desktop drop target. The app's real intake,
// staging, outbox and send code runs on what these hand it.
import 'dart:async';
import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_intake.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_picker.dart';
import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';

/// A small text file as the picker returns it.
SessionAttachment textFile(String name, String text) {
  final bytes = Uint8List.fromList(text.codeUnits);
  return SessionAttachment(
    name: name,
    data: base64Encode(bytes),
    byteLength: bytes.length,
    mimeType: 'text/plain',
  );
}

/// The file picker.
final class FakeAttachmentPicker implements SessionAttachmentPicker {
  /// Files the next pick returns (empty: the user cancelled).
  List<SessionAttachment> next = const [];

  /// Throws on the next pick (the picker itself failed).
  bool failNext = false;

  /// `allowMultiple` of every pick.
  final List<bool> picks = [];

  @override
  Future<List<SessionAttachment>> pickAttachments({
    bool allowMultiple = true,
  }) async {
    picks.add(allowMultiple);
    if (failNext) {
      failNext = false;
      throw StateError('picker failed (injected)');
    }
    return next;
  }

  /// The provider override that hands this picker to the App.
  Override get providerOverride =>
      sessionAttachmentPickerProvider.overrideWithValue(this);
}

/// The system clipboard (native).
final class FakeAttachmentClipboard implements SessionAttachmentClipboard {
  /// Reads answered in order, one per paste chord.
  final List<Future<SessionAttachmentClipboardRead>> reads = [];

  /// Paste chords that reached the clipboard.
  int readCount = 0;

  /// Queues a clipboard that holds [text].
  void holdsText(String text) =>
      reads.add(Future.value(SessionAttachmentClipboardText(text)));

  /// Queues a clipboard that holds files, answered when the returned
  /// completer completes.
  Completer<SessionAttachmentClipboardRead> holdsFilesLater() {
    final completer = Completer<SessionAttachmentClipboardRead>();
    reads.add(completer.future);
    return completer;
  }

  /// Queues a clipboard that holds [names] as small files.
  void holdsFiles(List<String> names) => reads.add(
    Future.value(
      SessionAttachmentClipboardFiles([
        for (final name in names)
          MemorySessionAttachmentIntakeItem(
            bytes: Uint8List.fromList(name.codeUnits),
            name: name,
          ),
      ]),
    ),
  );

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
  }) {
    final index = readCount++;
    if (index >= reads.length) {
      return Future.value(const SessionAttachmentClipboardText(null));
    }
    return reads[index];
  }

  @override
  Future<String?> readNativeText() async => null;

  /// The provider override that hands this clipboard to the App.
  Override get providerOverride =>
      sessionAttachmentClipboardProvider.overrideWithValue(this);
}

/// A file dropped from the desktop.
DropItemFile droppedFile(String name, List<int> bytes, {String? path}) =>
    DropItemFile.fromData(
      Uint8List.fromList(bytes),
      name: name,
      path: path ?? '/drop/$name',
      mimeType: 'image/png',
    );

/// Desktop drop on the composer, the way the `desktop_drop` plugin reports it.
extension AttachmentDriver on AppDriver {
  DropTarget get _dropTarget => tester.widget<DropTarget>(
    find.byKey(const Key('session-detail-attachment-drop-region')),
  );

  /// Whether the composer has a desktop drop surface at all.
  bool get hasDropSurface => find
      .byKey(const Key('session-detail-attachment-drop-region'))
      .evaluate()
      .isNotEmpty;

  /// Whether the "drop files here" overlay is showing.
  bool get dropOverlayShowing => find
      .byKey(const Key('session-detail-attachment-drop-overlay'))
      .evaluate()
      .isNotEmpty;

  /// A drag enters the composer.
  Future<void> dragEnter() async {
    _dropTarget.onDragEntered?.call(
      DropEventDetails(localPosition: Offset.zero, globalPosition: Offset.zero),
    );
    await settle();
  }

  /// A drag leaves the composer.
  Future<void> dragExit() async {
    _dropTarget.onDragExited?.call(
      DropEventDetails(localPosition: Offset.zero, globalPosition: Offset.zero),
    );
    await settle();
  }

  /// [items] are dropped on the composer; [times] > 1 delivers the very same
  /// drop event again (the plugin reporting it twice).
  Future<void> drop(List<DropItem> items, {int times = 1}) async {
    final details = DropDoneDetails(
      files: items,
      localPosition: Offset.zero,
      globalPosition: Offset.zero,
    );
    for (var i = 0; i < times; i++) {
      _dropTarget.onDragDone?.call(details);
      await settle();
    }
  }

  /// Presses the paste chord (Ctrl+V) in the focused composer.
  Future<void> pasteChord() async {
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await settle();
  }

  /// Opens the composer's menu and presses Attach.
  Future<void> pressAttach() async {
    await tapKey('session-detail-composer-menu');
    await tapKey('session-detail-attach-button');
  }

  /// Whether the Attach menu entry can be pressed.
  Future<bool> attachEnabled() async {
    await tapKey('session-detail-composer-menu');
    final enabled = tester
        .widget<PopupMenuItem<String>>(
          find.byKey(const Key('session-detail-attach-button')),
        )
        .enabled;
    await dismissMenu();
    return enabled;
  }

  /// Closes an open popup menu.
  Future<void> dismissMenu() async {
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await settle();
  }
}
