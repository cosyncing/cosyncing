import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('audited non-session primary surfaces do not render raw exceptions', () {
    const auditedFiles = <String, List<String>>{
      'lib/src/features/broker_profiles/view/broker_profiles_page.dart': [
        'error.toString()',
      ],
      'lib/src/features/attention/view/attention_page.dart': [
        'error.toString()',
        r'pending: $error',
      ],
      'lib/src/features/settings/view/notification_settings_page.dart': [
        'error.toString()',
        '.error?.toString()',
      ],
      'lib/src/features/settings/controller/'
          'session_notification_settings_controller.dart': [
        'message: error.toString()',
      ],
      'lib/src/features/schedules/controller/'
          'inline_scheduled_message_controller.dart': [
        'return error.toString()',
      ],
      'lib/src/features/transfers/view/transfer_manager_page.dart': [
        r'Open file failed: ${result.message}',
        r'Reveal in folder failed: ${result.message}',
        r'Preview text failed: ${result.message}',
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
