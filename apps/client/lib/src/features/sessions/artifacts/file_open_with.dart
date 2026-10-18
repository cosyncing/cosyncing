import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Reuses the chunked disk cache and preserves the filename for OS handlers.
Future<bool> openWorkspaceFileWithApp(
  BuildContext context,
  WidgetRef ref,
  SessionDetailKey session,
  String path,
) async {
  final service = ref.read(sessionArtifactFileServiceProvider);
  final opener = ref.read(localTransferFileOpenerProvider);
  final file = await service.cacheSessionFile(
    tool: session.tool,
    sessionId: session.sessionId,
    path: path,
    fileName: path.split('/').last,
  );
  if (!context.mounted) return false;
  return (await opener.openFile(file.cachedFilePath)).isSuccess;
}

/// Opens delivered files through the native file handler.
Future<bool> openArtifactWithApp(
  BuildContext context,
  WidgetRef ref,
  SessionArtifactDescriptor artifact,
) async {
  final service = ref.read(sessionArtifactFileServiceProvider);
  final opener = ref.read(localTransferFileOpenerProvider);
  final file = await service.cacheArtifact(artifact);
  if (!context.mounted) return false;
  return (await opener.openFile(file.cachedFilePath)).isSuccess;
}
