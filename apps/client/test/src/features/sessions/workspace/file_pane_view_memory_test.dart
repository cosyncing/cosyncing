import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_view_memory.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('FilePaneViewMemory', () {
    test('a pane with no history has nothing to resume', () {
      expect(FilePaneViewMemory().read('codex/a#x.dart'), isNull);
    });

    test('remembers a face and an offset per pane', () {
      final memory = FilePaneViewMemory()
        ..write('codex/a#x.dart', (mode: FileViewMode.rendered, offset: 120))
        ..write('codex/a#y.dart', (mode: FileViewMode.source, offset: 0));

      expect(memory.read('codex/a#x.dart')?.mode, FileViewMode.rendered);
      expect(memory.read('codex/a#x.dart')?.offset, 120);
      // Two files open at once are two independent reads.
      expect(memory.read('codex/a#y.dart')?.offset, 0);
    });

    test('closing a file forgets where you were in it', () {
      final memory = FilePaneViewMemory()
        ..write('codex/a#x.dart', (mode: FileViewMode.source, offset: 900))
        ..forget('codex/a#x.dart');

      // Reopening it later is a new read, not a resumed one.
      expect(memory.read('codex/a#x.dart'), isNull);
    });
  });
}
