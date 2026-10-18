import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_media_source.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_pdf_view.dart'
    deferred as pdf;
import 'package:cosyncing_client/src/features/sessions/artifacts/file_video_view.dart'
    deferred as video;
import 'package:flutter/material.dart';

/// Loads a decoder only while this particular pane is visible and foregrounded.
class FileMediaView extends StatefulWidget {
  /// Creates a lazy media view.
  const FileMediaView({required this.preview, required this.name, super.key});

  /// Host-owned resource loader.
  final FileMediaPreview preview;

  /// Accessible file name.
  final String name;

  @override
  State<FileMediaView> createState() => _FileMediaViewState();
}

class _FileMediaViewState extends State<FileMediaView>
    with WidgetsBindingObserver {
  FileMediaSource? _source;
  Object? _error;
  int _generation = 0;
  bool _active = false;
  bool _foreground = true;

  @override
  void initState() {
    super.initState();
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncActivity();
  }

  @override
  void didUpdateWidget(covariant FileMediaView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.preview, widget.preview)) {
      _stop();
      _syncActivity();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (mounted) setState(_syncActivity);
  }

  void _syncActivity() {
    final visible =
        _foreground &&
        TickerMode.valuesOf(context).enabled &&
        (ModalRoute.isCurrentOf(context) ?? true);
    if (visible == _active) return;
    if (!visible) {
      _stop();
      return;
    }
    _active = true;
    _error = null;
    final generation = ++_generation;
    unawaited(_load(generation));
  }

  Future<void> _load(int generation) async {
    FileMediaSource? source;
    try {
      source = await widget.preview.load();
      if (!mounted || generation != _generation) {
        source.release?.call();
        return;
      }
      switch (widget.preview.kind) {
        case FileMediaKind.pdf:
          await pdf.loadLibrary();
        case FileMediaKind.video:
          await video.loadLibrary();
        case FileMediaKind.image:
          break;
      }
      if (!mounted || generation != _generation) {
        source.release?.call();
        return;
      }
      setState(() => _source = source);
    } on Object catch (error) {
      source?.release?.call();
      if (mounted && generation == _generation) setState(() => _error = error);
    }
  }

  void _stop() {
    _active = false;
    _generation++;
    _source?.release?.call();
    _source = null;
    _error = null;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    if (!_active) return const SizedBox.shrink();
    if (_error != null) {
      final tooLarge =
          _error is ArtifactTooLargeException ||
          (_error is BrokerException &&
              ((_error! as BrokerException).statusCode == 413 ||
                  (_error! as BrokerException).error?.code ==
                      'FS_DOWNLOAD_TOO_LARGE'));
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              tooLarge ? l10n.artifactPreviewTooLarge : l10n.fileMediaFailed,
              textAlign: TextAlign.center,
            ),
            TextButton(
              onPressed: () => setState(() {
                _stop();
                _syncActivity();
              }),
              child: Text(l10n.fileViewerTryAgain),
            ),
          ],
        ),
      );
    }
    final source = _source;
    if (source == null) return Center(child: Text(l10n.fileMediaLoading));
    return RepaintBoundary(
      // A pause/resume can finish before the next frame. Each acquisition must
      // still replace the old image provider/decoder that was already released.
      key: ValueKey(_generation),
      child: switch (widget.preview.kind) {
        FileMediaKind.image => _ImageView(source: source, name: widget.name),
        FileMediaKind.pdf => pdf.buildFilePdfView(source, widget.name),
        FileMediaKind.video => video.buildFileVideoView(source, widget.name),
      },
    );
  }
}

class _ImageView extends StatefulWidget {
  const _ImageView({required this.source, required this.name});
  final FileMediaSource source;
  final String name;
  @override
  State<_ImageView> createState() => _ImageViewState();
}

class _ImageViewState extends State<_ImageView> {
  final _transform = TransformationController();
  late final ImageProvider<Object> _image = ResizeImage(
    widget.source.bytes == null
        ? NetworkImage(widget.source.uri.toString())
        : MemoryImage(widget.source.bytes!),
    width: 2048,
    height: 2048,
    policy: ResizeImagePolicy.fit,
  );
  @override
  void dispose() {
    _transform.dispose();
    unawaited(_image.evict());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Column(
      children: [
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: () => _transform.value = Matrix4.identity(),
            child: Text(l10n.fileMediaFit),
          ),
        ),
        Expanded(
          child: InteractiveViewer(
            transformationController: _transform,
            minScale: 0.25,
            maxScale: 8,
            child: Center(
              child: Image(
                image: _image,
                fit: BoxFit.contain,
                semanticLabel: widget.name,
                errorBuilder: (context, error, stack) =>
                    Text(l10n.fileMediaFailed),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
