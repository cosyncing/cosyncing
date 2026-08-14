import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('audited Session primary surfaces do not render raw exceptions', () {
    const auditedFiles = <String, List<String>>{
      'lib/src/features/sessions/detail/session_detail_controller.dart': [
        'clientError?.toString()',
        'error: e.toString()',
        r'Transcript could not be saved: $error',
        r'receipt could not be sent: $error',
      ],
      'lib/src/features/sessions/requests/session_detail_request_coordinator.dart':
          [
            'state = state.copyWith(error: e.toString())',
          ],
      'lib/src/features/sessions/transcript/session_detail_messaging_coordinator.dart':
          [
            'state = state.copyWith(error: e.toString())',
            'state = state.copyWith(error: error.toString())',
            'historyPageError: error.toString()',
          ],
      'lib/src/features/sessions/artifacts/session_detail_artifact_coordinator.dart':
          [
            'attachmentUploadMessage: e.toString()',
            '.markFailed(transferId, e.toString())',
          ],
      'lib/src/features/sessions/detail/'
          'session_detail_session_action_coordinator.dart': [
        'error.error?.error ?? error.message',
        'message: error.toString()',
      ],
      'lib/src/features/sessions/artifacts/session_file_browser.dart': [
        'message: e.toString()',
        'exception.error?.error ?? exception.message',
      ],
      'lib/src/features/sessions/artifacts/session_artifact_transfer_worker.dart':
          [
            r'${error.runtimeType}',
            r'${e.runtimeType}',
            '_ => error.message',
          ],
      'lib/src/features/sessions/artifacts/'
          'session_file_background_download.dart': [
        r'${e.runtimeType}',
      ],
      'lib/src/features/sessions/requests/session_command_args_codec.dart': [
        'SessionCommandArgsParseResult.failure(error.toString())',
      ],
      'lib/src/features/sessions/detail/'
          'session_detail_transfers_artifacts.dart': [
        r'Open file failed: ${result.message}',
        r'Reveal in folder failed: ${result.message}',
        r'Preview text failed: ${result.message}',
      ],
      'lib/src/features/sessions/detail/session_detail_page.dart': [
        'message: result.message',
        'SnackBar(content: Text(result.message))',
      ],
      'lib/src/features/sessions/artifacts/session_artifact_preview_result.dart':
          [
            r"message: 'Open in browser failed: $uri. $error'",
          ],
      'lib/src/features/transfers/view/transfer_manager_page.dart': [
        '_showTransferManagerSnackBar(context, result.message)',
      ],
    };

    for (final entry in auditedFiles.entries) {
      final source = File(entry.key).readAsStringSync();
      for (final forbidden in entry.value) {
        expect(
          source,
          isNot(contains(forbidden)),
          reason: '${entry.key} must not contain `$forbidden`',
        );
      }
    }
  });
}
