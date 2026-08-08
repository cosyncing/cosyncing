import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_descriptor.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionArtifactDescriptor', () {
    test('extracts metadata for reference artifact messages', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'model-output.zip',
          'path': '/tmp/artifacts/model-output.zip',
          'size': 1_572_864,
          'mimeType': 'application/zip',
          'artifactKey': 'artifact-key-123',
          'contentHash': 'sha256:feedface',
          'deliveryClass': 'interactive',
          'fetchUrl':
              'https://cdn.example.net/api/sessions/opencode/session-1/artifact/abc?expires=1700000000&sig=abc123',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(descriptor!.name, 'model-output.zip');
      expect(descriptor.path, '/tmp/artifacts/model-output.zip');
      expect(descriptor.size, 1_572_864);
      expect(descriptor.mimeType, 'application/zip');
      expect(descriptor.artifactKey, 'artifact-key-123');
      expect(descriptor.contentHash, 'sha256:feedface');
      expect(
        descriptor.deliveryClass,
        SessionArtifactDeliveryClass.interactive,
      );
      expect(descriptor.format, isNull);
      expect(descriptor.redactionSummary, isNull);
      expect(descriptor.expiresAt, isNull);
      expect(descriptor.fetchUrl, contains('/artifact/abc'));
      expect(descriptor.url, isNull);
      expect(descriptor.isDownloadable, isTrue);
      expect(descriptor.isInlineDataUrl, isFalse);
      expect(descriptor.isHtmlPreviewCandidate, isFalse);
      expect(descriptor.downloadActionLabel, 'Download');
      expect(descriptor.displaySize, '1572864 bytes');
    });

    test('supports inline data URL artifacts for fetch actions', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'inline.txt',
          'filePath': '/tmp/inline.txt',
          'size': 24,
          'url': 'data:text/plain;base64,SGVsbG8gV29ybGQ=',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(descriptor!.name, 'inline.txt');
      expect(descriptor.path, '/tmp/inline.txt');
      expect(descriptor.mimeType, isNull);
      expect(descriptor.inlineDataUrl, startsWith('data:text/plain'));
      expect(descriptor.url, startsWith('data:text/plain'));
      expect(descriptor.fetchUrl, isNull);
      expect(descriptor.isDownloadable, isTrue);
      expect(descriptor.isInlineDataUrl, isTrue);
      expect(descriptor.isHtmlPreviewCandidate, isFalse);
      expect(descriptor.downloadActionLabel, 'Fetch data URL');
    });

    test('extracts export artifact metadata fields', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'transcript.json',
          'deliveryClass': 'export-attachment',
          'format': 'json',
          'redactionSummary': 'redacted API keys',
          'expiresAt': 1719000000000,
          'mimeType': 'application/json',
          'fetchUrl':
              'https://cdn.example.net/api/sessions/opencode/session-1/artifact/export',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(
        descriptor!.deliveryClass,
        SessionArtifactDeliveryClass.exportAttachment,
      );
      expect(descriptor.format, 'json');
      expect(descriptor.redactionSummary, 'redacted API keys');
      expect(descriptor.expiresAt, 1719000000000);
    });

    test('export-attachment HTML artifacts are not preview candidates', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'transcript.html',
          'mimeType': 'text/html',
          'deliveryClass': 'export-attachment',
          'fetchUrl':
              'https://cdn.example.net/api/sessions/opencode/session-1/artifact/export-html',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(
        descriptor!.deliveryClass,
        SessionArtifactDeliveryClass.exportAttachment,
      );
      expect(descriptor.isDownloadable, isTrue);
      expect(descriptor.isHtmlPreviewCandidate, isFalse);
    });

    test('interactive deliveryClass preserves HTML preview behavior', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'summary.html',
          'mimeType': 'text/html',
          'deliveryClass': 'interactive',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(
        descriptor!.deliveryClass,
        SessionArtifactDeliveryClass.interactive,
      );
      expect(descriptor.isHtmlPreviewCandidate, isTrue);
    });

    test('missing deliveryClass preserves existing HTML preview behavior', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'summary.html',
          'mimeType': 'text/html',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(
        descriptor!.deliveryClass,
        SessionArtifactDeliveryClass.interactive,
      );
      expect(descriptor.isHtmlPreviewCandidate, isTrue);
    });

    test('unknown deliveryClass blocks HTML preview behavior', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'future.html',
          'mimeType': 'text/html',
          'deliveryClass': 'future-class',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(descriptor!.deliveryClass, SessionArtifactDeliveryClass.unknown);
      expect(descriptor.isHtmlPreviewCandidate, isFalse);
    });

    test('represents metadata-only artifacts without download URL', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'artifactKey': 'artifact-only-key',
          'contentHash': 'sha256:abc',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(descriptor!.artifactKey, 'artifact-only-key');
      expect(descriptor.path, isNull);
      expect(descriptor.name, isNull);
      expect(descriptor.size, isNull);
      expect(descriptor.fetchUrl, isNull);
      expect(descriptor.inlineDataUrl, isNull);
      expect(descriptor.url, isNull);
      expect(descriptor.isDownloadable, isFalse);
      expect(descriptor.isInlineDataUrl, isFalse);
      expect(descriptor.isHtmlPreviewCandidate, isFalse);
      expect(descriptor.downloadActionLabel, 'Download');
      expect(descriptor.displaySize, 'unknown');
    });

    test(
      'supports legacy direct artifact URLs without treating them as data',
      () {
        const message = AgentMessage(
          type: AgentMessageType.fileArtifact,
          raw: {
            'type': 'file-artifact',
            'name': 'legacy.pdf',
            'mimeType': 'application/pdf',
            'url': 'https://broker.example/artifacts/legacy.pdf',
          },
        );

        final descriptor = SessionArtifactDescriptor.fromMessage(message);

        expect(descriptor, isNotNull);
        expect(descriptor!.url, 'https://broker.example/artifacts/legacy.pdf');
        expect(descriptor.inlineDataUrl, isNull);
        expect(descriptor.isDownloadable, isTrue);
        expect(descriptor.isInlineDataUrl, isFalse);
        expect(descriptor.downloadActionLabel, 'Download');
      },
    );

    test('detects HTML preview candidates from MIME and filenames', () {
      const message = AgentMessage(
        type: AgentMessageType.fileArtifact,
        raw: {
          'type': 'file-artifact',
          'name': 'summary.html',
          'mediaType': 'text/html',
          'fetchUrl':
              'https://cdn.example.net/api/sessions/opencode/session-1/artifact/preview-key',
        },
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNotNull);
      expect(descriptor!.name, 'summary.html');
      expect(descriptor.mimeType, 'text/html');
      expect(descriptor.isHtmlPreviewCandidate, isTrue);
      expect(descriptor.isDownloadable, isTrue);
      expect(descriptor.fetchUrl, contains('preview-key'));
    });

    test('returns null for non-artifact messages', () {
      const message = AgentMessage(
        type: AgentMessageType.status,
        raw: {'type': 'status', 'message': 'ok'},
      );

      final descriptor = SessionArtifactDescriptor.fromMessage(message);

      expect(descriptor, isNull);
    });
  });
}
