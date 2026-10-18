import 'dart:async';
import 'dart:io';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_media_source.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:video_player/video_player.dart';

/// Deferred player; unsupported targets use the native Open with action.
Widget buildFileVideoView(FileMediaSource source, String name) =>
    _VideoView(source: source, name: name);

class _VideoView extends StatefulWidget {
  const _VideoView({required this.source, required this.name});
  final FileMediaSource source;
  final String name;
  @override
  State<_VideoView> createState() => _VideoViewState();
}

class _VideoViewState extends State<_VideoView> with WidgetsBindingObserver {
  _VideoResource? _resource;
  bool _foreground = true;
  VideoPlayerController? get _controller => _resource?.controller;
  Object? _error;
  bool get _hasSource =>
      widget.source.uri != null || widget.source.bytes != null;
  bool get _embedded =>
      kIsWeb ||
      const {
        TargetPlatform.android,
        TargetPlatform.iOS,
        TargetPlatform.macOS,
      }.contains(defaultTargetPlatform);
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (_embedded && _hasSource) unawaited(_initialize());
  }

  Future<void> _initialize() async {
    try {
      final resource = await _VideoResource.create(widget.source, widget.name);
      if (!mounted || !_foreground) {
        await resource.dispose();
        return;
      }
      _resource = resource;
      await resource.initialize();
      if (mounted) setState(() {});
    } on Object catch (error) {
      if (mounted) setState(() => _error = error);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_resource?.dispose());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Pause immediately: a backgrounded app may not draw the frame that
    // removes this view and disposes the decoder.
    if (state == AppLifecycleState.resumed || !_foreground) return;
    _foreground = false;
    unawaited(_controller?.pause().onError((error, stack) {}));
    unawaited(_resource?.dispose());
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final controller = _controller;
    if (!_embedded || !_hasSource) {
      return Center(
        child: Text(l10n.fileMediaOpenExternally, textAlign: TextAlign.center),
      );
    }
    if (_error != null) {
      return Center(child: Text(l10n.fileMediaFailed));
    }
    if (controller == null || !controller.value.isInitialized) {
      return Center(child: Text(l10n.fileMediaLoading));
    }
    return Column(
      children: [
        Expanded(
          child: Center(
            child: AspectRatio(
              aspectRatio: controller.value.aspectRatio,
              child: VideoPlayer(controller),
            ),
          ),
        ),
        // Playback ticks rebuild only these controls.
        ValueListenableBuilder<VideoPlayerValue>(
          valueListenable: controller,
          builder: (context, value, child) => Row(
            children: [
              IconButton(
                tooltip: value.isPlaying
                    ? l10n.fileMediaPause
                    : l10n.fileMediaPlay,
                onPressed: () => unawaited(
                  value.isPlaying ? controller.pause() : controller.play(),
                ),
                icon: Icon(value.isPlaying ? Icons.pause : Icons.play_arrow),
              ),
              Expanded(
                child: VideoProgressIndicator(
                  controller,
                  allowScrubbing: true,
                  padding: const EdgeInsets.all(8),
                ),
              ),
              IconButton(
                tooltip: value.volume == 0
                    ? l10n.fileMediaUnmute
                    : l10n.fileMediaMute,
                onPressed: () =>
                    unawaited(controller.setVolume(value.volume == 0 ? 1 : 0)),
                icon: Icon(
                  value.volume == 0 ? Icons.volume_off : Icons.volume_up,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Owns native inline bytes until the decoder has released its file handle.
class _VideoResource {
  _VideoResource(this.controller, [this.directory]);

  final VideoPlayerController controller;
  final Directory? directory;
  Future<void>? _disposal;
  final _creationFailed = Completer<void>();

  // This view owns foreground pausing. Avoid the plugin's observer, which
  // video_player 2.14 retains when native player creation throws.
  static final _options = VideoPlayerOptions(allowBackgroundPlayback: true);

  static Future<_VideoResource> create(
    FileMediaSource source,
    String name,
  ) async {
    if (source.uri case final uri?) {
      return _VideoResource(
        VideoPlayerController.networkUrl(uri, videoPlayerOptions: _options),
      );
    }
    if (kIsWeb || source.bytes == null) {
      throw StateError('Video has no playable source');
    }
    final root = await getTemporaryDirectory();
    final directory = await root.createTemp('cosyncing-preview-');
    try {
      final suffix = name.split('.').last.toLowerCase();
      final extension = const {'mp4', 'm4v', 'mov', 'webm'}.contains(suffix)
          ? suffix
          : 'mp4';
      final file = File('${directory.path}/preview.$extension');
      await file.writeAsBytes(source.bytes!);
      return _VideoResource(
        VideoPlayerController.file(file, videoPlayerOptions: _options),
        directory,
      );
    } on Object {
      await directory.delete(recursive: true);
      rethrow;
    }
  }

  Future<void> initialize() async {
    try {
      await controller.initialize();
    } on Object {
      // video_player 2.14 leaves its creation completer pending if the native
      // create call throws. No decoder owns the file in that case; unblock
      // cleanup even if closing the pane already started disposal.
      // ignore: invalid_use_of_visible_for_testing_member
      if (controller.playerId == VideoPlayerController.kUninitializedPlayerId) {
        _creationFailed.complete();
      }
      await dispose();
      rethrow;
    }
  }

  Future<void> dispose() => _disposal ??= _dispose();

  Future<void> _dispose() async {
    try {
      await Future.any([controller.dispose(), _creationFailed.future]);
    } on Object {
      // Closing a pane cannot surface a native decoder teardown error.
    } finally {
      try {
        await directory?.delete(recursive: true);
      } on FileSystemException {
        // The OS may already have collected this temporary directory.
      }
    }
  }
}
