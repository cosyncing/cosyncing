import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_hold.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Pairing payload import screen.
///
/// See `docs/architecture/client-ui.md`.
class PairingPage extends ConsumerStatefulWidget {
  /// Creates the pairing page.
  const PairingPage({super.key});

  @override
  ConsumerState<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends ConsumerState<PairingPage>
    with WebHandoffHold<PairingPage> {
  final _payloadController = TextEditingController();

  // A pairing payload is pasted or scanned once and held nowhere else until it
  // is imported; losing it to a web-update handoff means scanning again (N3b).
  @override
  List<TextEditingController> get webHandoffControllers => [_payloadController];

  @override
  void dispose() {
    _payloadController.dispose();
    super.dispose();
  }

  void _importPayload() {
    final rawPayload = _payloadController.text;
    _importRawPayload(rawPayload);
  }

  void _importRawPayload(String rawPayload) {
    unawaited(
      ref.read(pairingControllerProvider.notifier).importPayload(rawPayload),
    );
  }

  Future<void> _scanPayload() async {
    final rawPayload = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(builder: (context) => const _QrScannerPage()),
    );
    if (rawPayload == null || rawPayload.trim().isEmpty) return;
    _payloadController.text = rawPayload;
    _importRawPayload(rawPayload);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(pairingControllerProvider);
    final canScan = _supportsCameraScan();

    return Scaffold(
      appBar: AppBar(title: Text(l10n.pairingTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const _PairingHeader(),
            const SizedBox(height: 16),
            TextFormField(
              controller: _payloadController,
              key: const Key('pairing-payload-field'),
              maxLines: 6,
              minLines: 4,
              decoration: InputDecoration(
                labelText: l10n.pairingFieldLabel,
                border: const OutlineInputBorder(),
                hintText: l10n.pairingFieldHint,
                alignLabelWithHint: true,
              ),
              keyboardType: TextInputType.text,
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    key: const Key('pairing-import-button'),
                    onPressed: state.isBusy ? null : _importPayload,
                    icon: state.isBusy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.link),
                    label: Text(
                      state.isBusy ? l10n.pairingImporting : l10n.pairingImport,
                    ),
                  ),
                ),
                if (canScan) ...[
                  const SizedBox(width: 8),
                  Tooltip(
                    message: l10n.pairingScanQr,
                    child: IconButton.filledTonal(
                      key: const Key('pairing-scan-button'),
                      onPressed: state.isBusy ? null : _scanPayload,
                      icon: const Icon(Icons.qr_code_scanner),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 16),
            if (state.notice != null)
              _PairingMessage(
                text: _pairingNoticeText(l10n, state.notice!),
                icon: state.hasError ? Icons.error : Icons.check_circle,
                color: state.hasError
                    ? context.tokens.statusError
                    : context.tokens.statusWorking,
                technicalDetail: state.technicalDetail,
              ),
          ],
        ),
      ),
    );
  }
}

class _PairingHeader extends StatelessWidget {
  const _PairingHeader();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return SelectionArea(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                l10n.pairingHeaderTitle,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                l10n.pairingHeaderBody,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _QrScannerPage extends StatefulWidget {
  const _QrScannerPage();

  @override
  State<_QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<_QrScannerPage> {
  var _handled = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.pairingScanQr)),
      body: MobileScanner(
        key: const Key('pairing-mobile-scanner'),
        onDetect: (capture) {
          if (_handled) return;
          final value = capture.barcodes
              .map((barcode) => barcode.rawValue)
              .whereType<String>()
              .where((raw) => raw.trim().isNotEmpty)
              .firstOrNull;
          if (value == null) return;
          _handled = true;
          Navigator.of(context).pop(value);
        },
      ),
    );
  }
}

bool _supportsCameraScan() {
  if (kIsWeb) return false;
  return defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;
}

class _PairingMessage extends StatelessWidget {
  const _PairingMessage({
    required this.text,
    required this.icon,
    required this.color,
    this.technicalDetail,
  });

  final String text;
  final IconData icon;
  final Color color;
  final String? technicalDetail;

  @override
  Widget build(BuildContext context) {
    final detail = technicalDetail;
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(icon, color: color, size: 20),
            const SizedBox(width: 8),
            Expanded(
              child: SelectableText(text, style: TextStyle(color: color)),
            ),
          ],
        ),
        if (detail != null && detail.trim().isNotEmpty)
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text(l10n.brokerGateTechnicalDetails),
            children: [
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: SelectableText(detail),
              ),
            ],
          ),
      ],
    );
  }
}

String _pairingNoticeText(AppLocalizations l10n, PairingNotice notice) {
  return switch (notice) {
    PairingNotice.emptyInput => l10n.pairingEmptyError,
    PairingNotice.invalidInput => l10n.pairingInvalidError,
    PairingNotice.invalidQr => l10n.pairingQrInvalidError,
    PairingNotice.oldQr => l10n.pairingQrOldError,
    PairingNotice.tokenSaveFailed => l10n.pairingSaveTokenError,
    PairingNotice.profileSaveFailed => l10n.pairingSaveProfileError,
    PairingNotice.profileActivationFailed => l10n.pairingActivateProfileError,
    PairingNotice.paired => l10n.pairingSuccess,
    PairingNotice.devicePaired => l10n.pairingDeviceSuccess,
    PairingNotice.deviceActivationFailed => l10n.pairingDeviceActivateError,
    PairingNotice.unlockFailed => l10n.pairingUnlockError,
    PairingNotice.rejected => l10n.pairingRejectedError,
    PairingNotice.notFound => l10n.pairingNotFoundError,
    PairingNotice.expired => l10n.pairingExpiredError,
    PairingNotice.alreadyUsed => l10n.pairingUsedError,
    PairingNotice.rateLimited => l10n.pairingRateLimitedError,
    PairingNotice.failed => l10n.pairingGenericError,
  };
}
