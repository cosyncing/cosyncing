import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener_types.dart';

/// Creates an [LocalTransferFileOpener] for desktop/mobile environments.
LocalTransferFileOpener createLocalTransferFileOpener() {
  return const _LocalTransferFileOpener();
}

final class _LocalTransferFileOpener implements LocalTransferFileOpener {
  const _LocalTransferFileOpener();

  @override
  Future<LocalTransferFileActionResult> openFile(String localPath) async {
    if (Platform.isMacOS) {
      return _runCommand(
        executable: 'open',
        arguments: [localPath],
        actionLabel: 'Open file',
      );
    }
    if (Platform.isLinux) {
      return _runCommand(
        executable: 'xdg-open',
        arguments: [localPath],
        actionLabel: 'Open file',
      );
    }
    if (Platform.isWindows) {
      return _runCommand(
        executable: 'rundll32',
        arguments: ['url.dll,FileProtocolHandler', localPath],
        actionLabel: 'Open file',
      );
    }

    return const LocalTransferFileActionResult.unsupported(
      'Open file is not supported on this platform.',
    );
  }

  @override
  Future<LocalTransferFileActionResult> revealInFolder(
    String localPath,
  ) async {
    if (Platform.isMacOS) {
      return _runCommand(
        executable: 'open',
        arguments: ['-R', localPath],
        actionLabel: 'Reveal in folder',
      );
    }
    if (Platform.isLinux) {
      final parentPath = File(localPath).parent.path;
      return _runCommand(
        executable: 'xdg-open',
        arguments: [parentPath],
        actionLabel: 'Reveal in folder',
      );
    }
    if (Platform.isWindows) {
      return _runCommand(
        executable: 'explorer',
        arguments: ['/select,$localPath'],
        actionLabel: 'Reveal in folder',
      );
    }

    return const LocalTransferFileActionResult.unsupported(
      'Reveal in folder is not supported on this platform.',
    );
  }

  @override
  Future<LocalTransferTextPreviewResult> previewTextFile(
    String localPath, {
    int maxBytes = 64 * 1024,
  }) async {
    try {
      final file = File(localPath);
      final exists = file.existsSync();
      if (!exists) {
        return const LocalTransferTextPreviewResult.failed(
          'File does not exist.',
        );
      }

      final sampledBytes = <int>[];
      await for (final chunk in file.openRead(0, maxBytes + 1)) {
        final remaining = maxBytes + 1 - sampledBytes.length;
        if (remaining <= 0) {
          break;
        }
        sampledBytes.addAll(chunk.take(remaining));
        if (sampledBytes.length > maxBytes) {
          break;
        }
      }

      final isTruncated = sampledBytes.length > maxBytes;
      final boundedBytes = isTruncated
          ? sampledBytes.sublist(0, maxBytes)
          : sampledBytes;
      if (sampledBytes.any((byte) => byte == 0)) {
        return const LocalTransferTextPreviewResult.binary(
          'File appears to contain binary data and cannot be previewed '
          'as text.',
        );
      }

      return LocalTransferTextPreviewResult.success(
        utf8.decode(boundedBytes, allowMalformed: true),
        isTruncated: isTruncated,
      );
    } on Object catch (error) {
      return LocalTransferTextPreviewResult.failed(
        'Failed to read local file for text preview: $error',
      );
    }
  }

  Future<LocalTransferFileActionResult> _runCommand({
    required String executable,
    required List<String> arguments,
    required String actionLabel,
  }) async {
    try {
      final result = await Process.run(executable, arguments);
      if (result.exitCode == 0) {
        return const LocalTransferFileActionResult.success();
      }
      final stderr = result.stderr.toString().trim();
      final stdout = result.stdout.toString().trim();
      final details = <String>[];
      if (stderr.isNotEmpty) {
        details.add('stderr: $stderr');
      }
      if (stdout.isNotEmpty) {
        details.add('stdout: $stdout');
      }
      final detailsLabel = details.isEmpty ? '' : ' (${details.join(', ')})';
      return LocalTransferFileActionResult.failed(
        '$actionLabel failed with exit code ${result.exitCode}$detailsLabel',
      );
    } on Object catch (error) {
      return LocalTransferFileActionResult.failed(
        'Could not run $actionLabel command: $error',
      );
    }
  }
}
