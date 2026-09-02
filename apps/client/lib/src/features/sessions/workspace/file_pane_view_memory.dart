import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Where a file pane's view state waits out a width-class crossing.
///
/// The split's second pane and the compact drill-in route are two widgets, so
/// resizing across 840dp disposes one and mounts the other. Path and anchor
/// survive in the location; mode and scroll offset have nowhere else to live,
/// and losing them mid-read is exactly the "you lost your place" failure the
/// split was built to avoid.
///
/// Deliberately mutable without notifying. Offset changes every frame of a
/// drag and no widget should rebuild for it: readers take a snapshot when they
/// mount, writers only record. Transient like `filePaneAnchorProvider` too —
/// reopening the app restores which files were open, never where you were
/// inside them.
class FilePaneViewMemory {
  final Map<String, FilePaneView> _byKey = {};

  /// The remembered view for [key], or null when the pane is newly opened.
  FilePaneView? read(String key) => _byKey[key];

  /// Records [view] for [key].
  void write(String key, FilePaneView view) => _byKey[key] = view;

  /// Drops [key], so reopening that file starts at the top of its own face.
  void forget(String key) => _byKey.remove(key);
}

/// The process-wide view memory.
final Provider<FilePaneViewMemory> filePaneViewMemoryProvider =
    Provider<FilePaneViewMemory>((ref) => FilePaneViewMemory());
