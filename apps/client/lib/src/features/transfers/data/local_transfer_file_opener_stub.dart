import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener_types.dart';

/// Creates an [LocalTransferFileOpener] that reports unsupported actions
/// on platforms without local process launching (for example web).
LocalTransferFileOpener createLocalTransferFileOpener() {
  return const _UnsupportedLocalTransferFileOpener();
}

final class _UnsupportedLocalTransferFileOpener
    implements LocalTransferFileOpener {
  const _UnsupportedLocalTransferFileOpener();

  @override
  Future<LocalTransferFileActionResult> openFile(String localPath) async {
    return const LocalTransferFileActionResult.unsupported(
      'Open file is not supported on this platform.',
    );
  }

  @override
  Future<LocalTransferFileActionResult> revealInFolder(String localPath) async {
    return const LocalTransferFileActionResult.unsupported(
      'Reveal in folder is not supported on this platform.',
    );
  }

  @override
  Future<LocalTransferTextPreviewResult> previewTextFile(
    String localPath, {
    int maxBytes = 64 * 1024,
  }) async {
    return const LocalTransferTextPreviewResult.unsupported(
      'Preview text is not supported on this platform.',
    );
  }
}
