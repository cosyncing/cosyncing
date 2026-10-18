import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_media_source.dart';
import 'package:flutter/material.dart';
import 'package:pdfrx/pdfrx.dart';

/// Deferred PDF renderer with a bounded raster cache and page navigation.
Widget buildFilePdfView(FileMediaSource source, String name) =>
    _PdfView(source: source, name: name);

class _PdfView extends StatefulWidget {
  const _PdfView({required this.source, required this.name});
  final FileMediaSource source;
  final String name;
  @override
  State<_PdfView> createState() => _PdfViewState();
}

class _PdfViewState extends State<_PdfView> {
  final _controller = PdfViewerController();
  int _pages = 0;
  int _page = 1;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final params = PdfViewerParams(
      backgroundColor: context.tokens.surface2,
      maxImageBytesCachedOnMemory: 32 * 1024 * 1024,
      onViewerReady: (document, controller) {
        if (mounted) setState(() => _pages = document.pages.length);
      },
      onPageChanged: (page) {
        if (mounted && page != null && page != _page) {
          setState(() => _page = page);
        }
      },
      loadingBannerBuilder: (context, downloaded, total) =>
          Center(child: Text(l10n.fileMediaLoading)),
      errorBannerBuilder: (context, error, stack, document) =>
          Center(child: Text(l10n.fileMediaFailed)),
    );
    final source = widget.source;
    return Column(
      children: [
        if (_pages > 0)
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                tooltip: l10n.filePdfPreviousPage,
                onPressed: _page <= 1
                    ? null
                    : () => unawaited(
                        _controller.goToPage(
                          pageNumber: _page - 1,
                          duration: Duration.zero,
                        ),
                      ),
                icon: const Icon(Icons.chevron_left),
              ),
              Text(l10n.filePdfPage(_page, _pages)),
              IconButton(
                tooltip: l10n.filePdfNextPage,
                onPressed: _page >= _pages
                    ? null
                    : () => unawaited(
                        _controller.goToPage(
                          pageNumber: _page + 1,
                          duration: Duration.zero,
                        ),
                      ),
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
        Expanded(
          child: source.bytes == null
              ? PdfViewer.uri(
                  source.uri!,
                  controller: _controller,
                  preferRangeAccess: true,
                  params: params,
                )
              : PdfViewer.data(
                  source.bytes!,
                  sourceName: widget.name,
                  controller: _controller,
                  params: params,
                ),
        ),
      ],
    );
  }
}
