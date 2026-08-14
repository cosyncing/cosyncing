import 'dart:js_interop';
import 'dart:typed_data';

import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_clipboard_types.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_intake.dart';
import 'package:web/web.dart' as web;

/// Creates the browser clipboard-event adapter.
SessionAttachmentClipboard createSessionAttachmentClipboard() =>
    _WebSessionAttachmentClipboard();

final class _WebSessionAttachmentClipboard
    implements SessionAttachmentClipboard {
  final Map<SessionAttachmentWebPasteListener, JSFunction> _listeners = {};
  final Map<SessionAttachmentWebDropListener, Map<String, JSFunction>>
  _dropListeners = {};

  @override
  bool get usesWebPasteEvents => true;

  @override
  bool get usesWebDropEvents => true;

  @override
  void addWebPasteListener(SessionAttachmentWebPasteListener listener) {
    if (_listeners.containsKey(listener)) return;
    final callback = ((web.Event rawEvent) {
      if (!rawEvent.isA<web.ClipboardEvent>()) return;
      listener(_WebSessionAttachmentPasteEvent(rawEvent as web.ClipboardEvent));
    }).toJS;
    _listeners[listener] = callback;
    web.document.addEventListener('paste', callback);
  }

  @override
  void removeWebPasteListener(SessionAttachmentWebPasteListener listener) {
    final callback = _listeners.remove(listener);
    if (callback != null) web.document.removeEventListener('paste', callback);
  }

  @override
  void addWebDropListener(SessionAttachmentWebDropListener listener) {
    if (_dropListeners.containsKey(listener)) return;
    final callbacks = <String, JSFunction>{};
    for (final phase in SessionAttachmentWebDragPhase.values) {
      final name = phase.name == 'over' ? 'dragover' : 'drag${phase.name}';
      final eventName = phase == SessionAttachmentWebDragPhase.drop
          ? 'drop'
          : name;
      final callback = ((web.Event rawEvent) {
        if (!rawEvent.isA<web.DragEvent>()) return;
        listener(
          _WebSessionAttachmentDropEvent(rawEvent as web.DragEvent, phase),
        );
      }).toJS;
      callbacks[eventName] = callback;
      web.document.addEventListener(eventName, callback);
    }
    _dropListeners[listener] = callbacks;
  }

  @override
  void removeWebDropListener(SessionAttachmentWebDropListener listener) {
    final callbacks = _dropListeners.remove(listener);
    callbacks?.forEach((eventName, callback) {
      web.document.removeEventListener(eventName, callback);
    });
  }

  @override
  Future<SessionAttachmentClipboardRead> readNative({
    bool Function()? isActive,
  }) => throw UnsupportedError('Browser paste uses ClipboardEvent snapshots.');

  @override
  Future<String?> readNativeText() =>
      throw UnsupportedError('Browser paste uses ClipboardEvent snapshots.');
}

final class _WebSessionAttachmentDropEvent
    implements SessionAttachmentWebDropEvent {
  _WebSessionAttachmentDropEvent(this._event, this.phase);

  final web.DragEvent _event;

  web.DataTransferItemList? get _items => _event.dataTransfer?.items;

  @override
  Object get identity => _event;

  @override
  final SessionAttachmentWebDragPhase phase;

  @override
  double get clientX => _event.clientX.toDouble();

  @override
  double get clientY => _event.clientY.toDouble();

  @override
  bool get hasFiles {
    final items = _items;
    if (items != null) {
      for (var index = 0; index < items.length; index += 1) {
        if (items[index].kind == 'file') return true;
      }
    }
    return (_event.dataTransfer?.files.length ?? 0) > 0;
  }

  @override
  bool get hasDirectory {
    final items = _items;
    if (items == null) return false;
    for (var index = 0; index < items.length; index += 1) {
      final item = items[index];
      if (item.kind == 'file' &&
          (item.webkitGetAsEntry()?.isDirectory ?? false)) {
        return true;
      }
    }
    return false;
  }

  @override
  void acceptOperation() {
    _event.preventDefault();
    if (_event.dataTransfer case final transfer?) transfer.dropEffect = 'copy';
  }

  @override
  void reject() {
    _event
      ..preventDefault()
      ..stopPropagation();
    if (_event.dataTransfer case final transfer?) transfer.dropEffect = 'none';
  }

  @override
  List<SessionAttachmentIntakeItem> claimFiles() {
    _event
      ..preventDefault()
      ..stopPropagation();
    if (_event.dataTransfer case final transfer?) transfer.dropEffect = 'copy';
    final files = _event.dataTransfer?.files;
    if (files == null) return const [];
    final count = files.length > sessionAttachmentMaxSnapshotFiles
        ? sessionAttachmentMaxSnapshotFiles
        : files.length;
    return List.generate(count, (index) {
      return _WebFileSessionAttachmentIntakeItem(files.item(index)!);
    }, growable: false);
  }
}

final class _WebSessionAttachmentPasteEvent
    implements SessionAttachmentWebPasteEvent {
  _WebSessionAttachmentPasteEvent(this._event);

  final web.ClipboardEvent _event;

  @override
  Object get identity => _event;

  @override
  bool get hasFiles => (_event.clipboardData?.files.length ?? 0) > 0;

  @override
  List<SessionAttachmentIntakeItem> claimFiles() {
    final files = _event.clipboardData?.files;
    if (files == null || files.length == 0) return const [];
    _event.preventDefault();
    final count = files.length > sessionAttachmentMaxSnapshotFiles
        ? sessionAttachmentMaxSnapshotFiles
        : files.length;
    return List.generate(count, (index) {
      final file = files.item(index)!;
      return _WebFileSessionAttachmentIntakeItem(file);
    }, growable: false);
  }

  @override
  void rejectFiles() => _event.preventDefault();
}

final class _WebFileSessionAttachmentIntakeItem
    implements SessionAttachmentIntakeItem {
  _WebFileSessionAttachmentIntakeItem(this._file)
    : name = safeSessionAttachmentDisplayName(
        _file.name,
        mimeType: _file.type,
      );

  final web.File _file;

  @override
  final String name;

  @override
  int get byteLength => _file.size;

  @override
  String? get mimeType => _file.type.isEmpty ? null : _file.type;

  @override
  Stream<List<int>> openRead({int start = 0, int? end}) async* {
    final safeEnd = end == null ? byteLength : end.clamp(start, byteLength);
    if (start < 0 || start > safeEnd) {
      throw const SessionAttachmentIntakeException('invalid-range');
    }
    final blob = _file.slice(start, safeEnd, _file.type);
    final buffer = await blob.arrayBuffer().toDart;
    yield Uint8List.view(buffer.toDart);
  }
}
