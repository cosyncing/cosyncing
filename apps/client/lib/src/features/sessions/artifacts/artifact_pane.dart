import 'dart:async';
import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_handoff.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_media_source.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_open_with.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_surface.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_view_memory.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/side_pane_scope.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Maximum text payload fetched for a delivered-file preview.
const int artifactPaneByteLimit = 2 * 1024 * 1024;

enum _PreviewFailure implements Exception { unavailable, tooLarge, binary }

// The selected record has value equality: streaming another chat message must
// not start another download of a file that is already being read.
// Open tabs may outlive the transcript window that first carried a file.
// Keep only the descriptors of explicitly opened files, scoped to this broker.
// No signed URLs or inline payloads enter persisted tab metadata.
final _openedArtifactsProvider =
    StateProvider<Map<String, SessionArtifactDescriptor>>((ref) {
      ref.watch(activeBrokerProfileProvider.select(RosterSource.of));
      return {};
    });

/// Reads a bounded, source-qualified delivered artifact.
final AutoDisposeFutureProviderFamily<FileViewerContent, ArtifactPaneKey>
artifactPaneReadProvider = FutureProvider.autoDispose
    .family<FileViewerContent, ArtifactPaneKey>((ref, pane) async {
      final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
      final opened = ref.watch(
        _openedArtifactsProvider.select((files) => files[pane.key]),
      );
      final artifact = opened == null
          ? ref.watch(
              sessionDetailControllerProvider(pane.session).select((state) {
                for (final descriptor
                    in state.forActiveSource(source).fileArtifactDescriptors) {
                  if (descriptor.actionStateKey == pane.artifactId) {
                    return (
                      url: descriptor.downloadSourceUrl,
                      mime: descriptor.mimeType,
                      size: descriptor.size,
                      previewable: descriptor.isPreviewCandidate,
                      text: descriptor.isTextPreviewCandidate,
                      kind: descriptor.mediaKind,
                    );
                  }
                }
                return null;
              }),
            )
          : (
              url: opened.downloadSourceUrl,
              mime: opened.mimeType,
              size: opened.size,
              previewable: opened.isPreviewCandidate,
              text: opened.isTextPreviewCandidate,
              kind: opened.mediaKind,
            );
      if (artifact == null || artifact.url == null || !artifact.previewable) {
        throw _PreviewFailure.unavailable;
      }
      if (artifact.kind case final kind?) {
        final limit = fileMediaByteLimit(kind);
        if ((artifact.size ?? 0) > limit) throw _PreviewFailure.tooLarge;
        final client = await ref.watch(brokerClientProvider.future);
        return FileViewerSource(
          preview: SessionFilePreview(
            path: pane.name,
            displayName: pane.name,
            mimeType: artifact.mime,
            size: artifact.size ?? 0,
            limit: limit,
            truncated: false,
            media: FileMediaPreview(
              kind: kind,
              load: () async {
                if (artifact.url!.startsWith('data:')) {
                  final inlineLimit = limit < 32 * 1024 * 1024
                      ? limit
                      : 32 * 1024 * 1024;
                  if (artifact.url!.length > inlineLimit * 3 + 1024) {
                    throw ArtifactTooLargeException(limit: inlineLimit);
                  }
                  final bytes = await compute(
                    _decodeInlineMedia,
                    artifact.url!,
                  );
                  if (bytes.length > inlineLimit) {
                    throw ArtifactTooLargeException(limit: inlineLimit);
                  }
                  return FileMediaSource(
                    bytes: bytes,
                    uri: kind == FileMediaKind.video && kIsWeb
                        ? Uri.parse(artifact.url!)
                        : null,
                  );
                }
                if (client == null) throw _PreviewFailure.unavailable;
                final ticket = await client.createMediaPreview(
                  tool: pane.session.tool,
                  sessionId: pane.session.sessionId,
                  artifactUrl: artifact.url,
                );
                return FileMediaSource(
                  uri: ticket.url,
                  release: () => unawaited(client.releaseMediaPreview(ticket)),
                );
              },
            ),
          ),
        );
      }
      if (!artifact.text) {
        return FileViewerUnsupported(
          path: pane.name,
          displayName: pane.name,
          typeLabel: artifact.mime ?? '',
          size: artifact.size ?? 0,
        );
      }
      if ((artifact.size ?? 0) > artifactPaneByteLimit) {
        throw _PreviewFailure.tooLarge;
      }
      final List<int> bytes;
      var mime = artifact.mime;
      if (artifact.url!.startsWith('data:')) {
        // Bound the encoded form before decoding; inline payloads obey the
        // memory ceiling as HTTP previews (percent encoding uses at most 3x).
        if (artifact.url!.length > artifactPaneByteLimit * 3 + 1024) {
          throw _PreviewFailure.tooLarge;
        }
        final data = UriData.parse(artifact.url!);
        bytes = data.contentAsBytes();
        mime ??= data.mimeType;
      } else {
        final client = await ref.watch(brokerClientProvider.future);
        if (client == null) throw _PreviewFailure.unavailable;
        final fetched = await client.fetchArtifactUrlBounded(
          artifact.url!,
          maxBytes: artifactPaneByteLimit,
        );
        bytes = fetched.bytes;
        mime ??= fetched.contentType;
      }
      if (bytes.length > artifactPaneByteLimit) throw _PreviewFailure.tooLarge;
      if (bytes.contains(0)) throw _PreviewFailure.binary;
      final String text;
      try {
        text = utf8.decode(bytes);
      } on FormatException {
        throw _PreviewFailure.binary;
      }
      return FileViewerSource(
        preview: SessionFilePreview(
          path: pane.name,
          displayName: pane.name,
          mimeType: mime,
          size: bytes.length,
          limit: artifactPaneByteLimit,
          truncated: false,
          text: text,
        ),
      );
    });

/// Opens the delivered bytes, without relying on workspace browsing or paths.
Future<void> openSessionArtifact(
  BuildContext context,
  WidgetRef ref,
  SessionDetailKey session,
  SessionArtifactDescriptor descriptor,
) async {
  final pane = ArtifactPaneKey(
    session: session,
    artifactId: descriptor.actionStateKey,
    name:
        descriptor.name ??
        descriptor.path?.split('/').last ??
        AppLocalizations.of(context).sessionArtifactUntitled,
  );
  final opened = ref.read(_openedArtifactsProvider.notifier);
  final descriptors = {...opened.state}..remove(pane.key);
  descriptors[pane.key] = descriptor;
  while (descriptors.length > 200) {
    descriptors.remove(descriptors.keys.first);
  }
  opened.state = descriptors;
  final scope = SidePaneScope.maybeOf(context);
  if (scope?.available ?? false) {
    scope!.expand();
    await ref.read(filePanesControllerProvider.notifier).openPane(pane);
  } else {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (context) => Scaffold(
          appBar: AppBar(title: Text(pane.name)),
          body: SafeArea(
            child: ArtifactPaneBody(
              pane: pane,
              onClose: () => Navigator.of(context).pop(),
            ),
          ),
        ),
      ),
    );
  }
}

/// Delivered file content in the same renderer used by workspace files.
class ArtifactPaneBody extends ConsumerWidget {
  /// Shows one delivered artifact.
  const ArtifactPaneBody({required this.pane, this.onClose, super.key});

  /// Artifact identity, scoped to its session.
  final ArtifactPaneKey pane;

  /// Compact route's back action; docked tabs close through their controller.
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final read = ref.watch(artifactPaneReadProvider(pane));
    final content = read.when(
      data: (content) => content,
      loading: () => FileViewerReading(path: pane.name, displayName: pane.name),
      error: (error, stack) => FileViewerGateClosed(
        path: pane.name,
        displayName: pane.name,
        explanation: switch (error) {
          _PreviewFailure.tooLarge => l10n.artifactPreviewTooLarge,
          _PreviewFailure.binary => l10n.sessionFilesPreviewTextOnly,
          _ => l10n.artifactPreviewFailed,
        },
      ),
    );
    final memory = ref.read(filePaneViewMemoryProvider);
    return FileViewerPane(
      content: content,
      onOpenWith: kIsWeb
          ? null
          : () async {
              var descriptor = ref.read(_openedArtifactsProvider)[pane.key];
              if (descriptor == null) {
                final source = RosterSource.of(
                  ref.read(activeBrokerProfileProvider),
                );
                for (final candidate
                    in ref
                        .read(sessionDetailControllerProvider(pane.session))
                        .forActiveSource(source)
                        .fileArtifactDescriptors) {
                  if (candidate.actionStateKey == pane.artifactId) {
                    descriptor = candidate;
                    break;
                  }
                }
              }
              return descriptor != null &&
                  await openArtifactWithApp(context, ref, descriptor);
            },
      sessionLabel: workspaceSessionLabel(
        session: pane.session,
        open: ref.watch(openSessionsControllerProvider).valueOrNull,
        l10n: l10n,
      ),
      toolColor: context.tokens.toolColor(pane.session.tool),
      initialView: memory.read(pane.key),
      onViewChanged: (view) => memory.write(pane.key, view),
      onRetry: () => ref.invalidate(artifactPaneReadProvider(pane)),
      onClose:
          onClose ??
          () {
            memory.forget(pane.key);
            ref.read(filePanesControllerProvider.notifier).close(pane).ignore();
          },
      onOpenExternally: content is FileViewerSource
          ? () => openWorkspaceHtmlInBrowser(
              sessionKey: '${pane.session.tool}/${pane.session.sessionId}',
              path: pane.name,
              html: content.preview.text,
              size: content.preview.size,
              truncated: false,
            )
          : null,
    );
  }
}

Uint8List _decodeInlineMedia(String value) =>
    UriData.parse(value).contentAsBytes();
