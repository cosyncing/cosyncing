import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('brokerRoutes', () {
    test('has the expected route count', () {
      expect(brokerRoutes, hasLength(53));
    });

    test('contains the fs and upload routes', () {
      expect(
        brokerRoutes,
        containsAll(<String>[
          '/api/sessions/{id}/{id}/fs',
          '/api/sessions/{id}/{id}/fs/read',
          '/api/sessions/{id}/{id}/fs/download',
          '/api/sessions/{id}/{id}/uploads',
          '/api/sessions/{id}/{id}/uploads/{id}',
          '/api/sessions/{id}/{id}/uploads/{id}/complete',
        ]),
      );
    });

    test('has no duplicate routes', () {
      expect(brokerRoutes.toSet().length, brokerRoutes.length);
    });

    test('contains new attention and runtime routes', () {
      expect(
        brokerRoutes,
        containsAll(<String>[
          '/api/agent-runtime-updates',
          '/api/agent-runtime-update-policy',
          '/api/agent-runtime-updates/{id}/restart',
          '/api/attention-events',
          '/api/attention-events/dismiss-batch',
          '/api/attention-events/{id}/ack',
          '/api/attention-events/{id}/dismiss',
          '/api/broker/health',
          '/api/broker/update',
          '/api/broker/restart-all',
          '/api/schedules',
          '/api/schedules/{id}',
          '/api/schedules/{id}/actions',
          '/api/machines/resolve',
          '/api/session-roster-deltas',
          '/api/tokdash/quota',
          '/api/tokdash/quota-preference',
        ]),
      );
    });
  });

  group('brokerErrorCodes', () {
    test('has 99 entries', () {
      expect(brokerErrorCodes, hasLength(99));
    });

    test('includes temporary session creation unavailability', () {
      expect(
        brokerErrorCodes,
        contains('SESSION_CREATE_TEMPORARILY_UNAVAILABLE'),
      );
    });

    test('includes the drive arbitration codes', () {
      expect(
        brokerErrorCodes,
        containsAll(<String>[
          'DRIVE_OWNERSHIP_CONFLICT',
          'DRIVE_OWNERSHIP_UNKNOWN',
          'DRIVE_NATIVE_SESSION_UNRESUMABLE',
          'DRIVE_RESTORE_FAILED',
        ]),
      );
    });

    test('dropped the legacy duplicate code and kept typed ack failures', () {
      expect(brokerErrorCodes, isNot(contains('DUPLICATE_CLIENT_MESSAGE_ID')));
      expect(
        brokerErrorCodes,
        containsAll(<String>['ACK_INVALID', 'ACK_CONFLICT']),
      );
    });

    test('includes the replacement ack-protocol and upload codes', () {
      expect(
        brokerErrorCodes,
        containsAll(<String>[
          'BAD_CLIENT_MESSAGE_ID',
          'ACK_UNKNOWN_TARGET',
          'CLIENT_MESSAGE_FAILED',
          'UPLOAD_NOT_FOUND',
          'UPLOAD_EXPIRED',
          'UPLOAD_OFFSET_MISMATCH',
          'UPLOAD_SIZE_MISMATCH',
          'UPLOAD_TOO_LARGE',
          'UPLOAD_SCOPE_MISMATCH',
          'UPLOAD_CAPACITY',
          'ATTACHMENT_DELIVERY_FAILED',
          'ATTACHMENT_INVALID',
          'ATTACHMENT_LIMIT_EXCEEDED',
          'ATTACHMENT_UNSUPPORTED',
          'STAGED_ATTACHMENT_EXPIRED',
          'STAGED_ATTACHMENT_NOT_FOUND',
          'STAGED_ATTACHMENT_SCOPE_MISMATCH',
          'FS_DOWNLOAD_TOO_LARGE',
          'FS_REMOTE_DISABLED',
          'HISTORY_PAGE_RESOURCE_LIMIT',
          'HISTORY_PAGE_SOURCE_UNVERSIONED',
          'PAIRING_NOT_FOUND',
          'PAIRING_RATE_LIMITED',
          'MODEL_CATALOG_UNAVAILABLE',
          'MODEL_SELECTION_UNSUPPORTED',
        ]),
      );
    });

    test('has no duplicate codes', () {
      expect(brokerErrorCodes.toSet().length, brokerErrorCodes.length);
    });
  });

  group('brokerWireFrameKinds', () {
    test('has 14 entries', () {
      expect(brokerWireFrameKinds, hasLength(14));
    });

    test('includes ack and nack', () {
      expect(brokerWireFrameKinds, containsAll(<String>['ack', 'nack']));
    });

    test('includes the structured attach-conflict arbitration frame', () {
      expect(brokerWireFrameKinds, contains('attach-conflict'));
    });

    test('includes draft', () {
      expect(brokerWireFrameKinds, contains('draft'));
    });

    test('includes broker identity hello', () {
      expect(brokerWireFrameKinds, contains('hello'));
    });

    test('includes backward history pages', () {
      expect(brokerWireFrameKinds, contains('history-page'));
    });
  });

  group('brokerClientMessageKinds', () {
    test('has 13 entries', () {
      expect(brokerClientMessageKinds, hasLength(13));
    });

    test('includes ack and nack', () {
      expect(
        brokerClientMessageKinds,
        containsAll(<String>['ack', 'nack']),
      );
    });
  });

  group('brokerIntegrationRoutes', () {
    test('mirrors ten non-client integration routes without duplicates', () {
      expect(brokerIntegrationRoutes, hasLength(10));
      expect(
        brokerIntegrationRoutes.toSet().length,
        brokerIntegrationRoutes.length,
      );
      expect(brokerIntegrationRoutes, contains('/pi/bridge/events'));
    });
  });
}
