import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_hold.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Builds the camera viewport used by the production pairing scanner route.
typedef PairingScannerBuilder =
    Widget Function(BuildContext context, ValueChanged<String> onDetected);

/// Pairing payload import screen.
///
/// See `docs/architecture/client-ui.md`.
class PairingPage extends StatelessWidget {
  /// Creates the pairing page.
  const PairingPage({this.scannerBuilder = _buildMobileScanner, super.key});

  /// Camera viewport factory. The default is the production mobile scanner.
  final PairingScannerBuilder scannerBuilder;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.pairingTitle)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: PairingForm(scannerBuilder: scannerBuilder),
        ),
      ),
    );
  }
}

/// Reusable pairing form shared by the Pairing route and first-run Connection.
class PairingForm extends ConsumerStatefulWidget {
  /// Creates a pairing form.
  const PairingForm({
    this.showHeader = true,
    this.scannerBuilder = _buildMobileScanner,
    super.key,
  });

  /// Whether to show the explanatory pairing header card.
  final bool showHeader;

  /// Camera viewport factory. The default is the production mobile scanner.
  final PairingScannerBuilder scannerBuilder;

  @override
  ConsumerState<PairingForm> createState() => _PairingFormState();
}

class _PairingFormState extends ConsumerState<PairingForm>
    with WebHandoffHold<PairingForm> {
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
    unawaited(_importRawPayload(rawPayload));
  }

  Future<void> _importRawPayload(String rawPayload) async {
    await ref
        .read(pairingControllerProvider.notifier)
        .importPayload(rawPayload);
    if (!mounted) return;
    final notice = ref.read(pairingControllerProvider).notice;
    final succeeded =
        notice == PairingNotice.paired || notice == PairingNotice.devicePaired;
    if (succeeded && _payloadController.text == rawPayload) {
      // Pairing links are one-use secrets. Once accepted, retaining the
      // populated controller both leaks the payload and indefinitely blocks a
      // web-update handoff because the Connection route stays mounted.
      _payloadController.clear();
    }
  }

  Future<void> _scanPayload() async {
    final rawPayload = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(
        builder: (context) => _QrScannerPage(
          scannerBuilder: widget.scannerBuilder,
        ),
      ),
    );
    if (rawPayload == null || rawPayload.trim().isEmpty) return;
    _payloadController.text = rawPayload;
    await _importRawPayload(rawPayload);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(pairingControllerProvider);
    final canScan = _supportsCameraScan(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.showHeader) ...[
          const _PairingHeader(),
          const SizedBox(height: 16),
        ],
        TextFormField(
          controller: _payloadController,
          key: const Key('pairing-payload-field'),
          maxLines: 6,
          minLines: 4,
          enabled: !state.isBusy,
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
          ),
      ],
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
  const _QrScannerPage({required this.scannerBuilder});

  final PairingScannerBuilder scannerBuilder;

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
      body: widget.scannerBuilder(context, _completeScan),
    );
  }

  void _completeScan(String value) {
    if (_handled || value.trim().isEmpty) return;
    _handled = true;
    Navigator.of(context).pop(value);
  }
}

Widget _buildMobileScanner(
  BuildContext _,
  ValueChanged<String> onDetected,
) {
  return MobileScanner(
    key: const Key('pairing-mobile-scanner'),
    onDetect: (capture) {
      final value = capture.barcodes
          .map((barcode) => barcode.rawValue)
          .whereType<String>()
          .where((raw) => raw.trim().isNotEmpty)
          .firstOrNull;
      if (value != null) onDetected(value);
    },
  );
}

bool _supportsCameraScan(BuildContext context) {
  if (kIsWeb) return false;
  final platform = Theme.of(context).platform;
  return platform == TargetPlatform.android || platform == TargetPlatform.iOS;
}

class _PairingMessage extends StatelessWidget {
  const _PairingMessage({
    required this.text,
    required this.icon,
    required this.color,
  });

  final String text;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: color, size: 20),
        const SizedBox(width: 8),
        Expanded(
          child: SelectableText(text, style: TextStyle(color: color)),
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
