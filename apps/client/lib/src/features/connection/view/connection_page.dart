import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/connection/model/connection_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_hold.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Broker connection screen.
///
/// Provides a URL/host/port form for entering a broker endpoint,
/// validates the input, runs a health probe, and displays the
/// connection state (idle, validating, success, failure).
///
/// References:
/// - `docs/architecture/monorepo.md`
/// - `docs/protocol/contract-sync.md`
class ConnectionPage extends ConsumerStatefulWidget {
  /// Creates the [ConnectionPage].
  const ConnectionPage({this.showSessionsBack = false, super.key});

  /// Shows contextual navigation back to the wide Sessions workspace.
  final bool showSessionsBack;

  @override
  ConsumerState<ConnectionPage> createState() => _ConnectionPageState();
}

class _ConnectionPageState extends ConsumerState<ConnectionPage>
    with WebHandoffHold<ConnectionPage> {
  final _urlController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  // A half-typed broker endpoint lives only here until Connect is pressed, so
  // a web-update handoff must defer rather than clear the field (N3b).
  @override
  List<TextEditingController> get webHandoffControllers => [_urlController];

  @override
  void dispose() {
    _urlController.dispose();
    super.dispose();
  }

  void _onConnect() {
    if (_formKey.currentState?.validate() ?? false) {
      ref
          .read(connectionControllerProvider.notifier)
          .connect(_urlController.text);
    }
  }

  void _onReset() {
    _urlController.clear();
    unawaited(ref.read(connectionControllerProvider.notifier).reset());
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final connState = ref.watch(connectionControllerProvider);

    return Scaffold(
      appBar: AppBar(
        leading: widget.showSessionsBack
            ? IconButton(
                key: const Key('connection-back-to-sessions'),
                tooltip: l10n.backToSessions,
                onPressed: () => context.go(sessionsRoute),
                icon: const Icon(Icons.arrow_back),
              )
            : null,
        title: Text(l10n.connectionTitle),
      ),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const _ManagedRuntimeOwnershipNotice(),
          const SizedBox(height: 24),
          _BrokerUrlForm(
            formKey: _formKey,
            urlController: _urlController,
            isEnabled: connState.status != ConnectionStatus.validating,
          ),
          const SizedBox(height: 24),
          _ConnectButton(
            isLoading: connState.status == ConnectionStatus.validating,
            onPressed: _onConnect,
          ),
          const SizedBox(height: 32),
          _ConnectionStatusCard(state: connState),
          if (connState.status != ConnectionStatus.idle) ...[
            const SizedBox(height: 16),
            TextButton(onPressed: _onReset, child: Text(l10n.connectionReset)),
          ],
        ],
      ),
    );
  }
}

/// Setup-time ownership disclosure for broker-managed agent runtimes.
///
/// Governed by `docs/architecture/client-ui.md`.
class _ManagedRuntimeOwnershipNotice extends StatelessWidget {
  const _ManagedRuntimeOwnershipNotice();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: tokens.surface2,
        border: Border.all(color: tokens.separator),
        borderRadius: BorderRadius.circular(tokens.radiusLg),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.admin_panel_settings_outlined, color: tokens.accent),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SelectableText(
                    l10n.connectionManagedRuntimeTitle,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 8),
                  SelectableText(
                    l10n.connectionManagedRuntimeBody,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: tokens.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Broker URL input form field.
class _BrokerUrlForm extends StatelessWidget {
  const _BrokerUrlForm({
    required this.formKey,
    required this.urlController,
    required this.isEnabled,
  });

  final GlobalKey<FormState> formKey;
  final TextEditingController urlController;
  final bool isEnabled;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Form(
      key: formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.connectionBrokerUrlLabel,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          TextFormField(
            controller: urlController,
            enabled: isEnabled,
            decoration: const InputDecoration(
              hintText: 'http://127.0.0.1:7734',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.link),
            ),
            keyboardType: TextInputType.url,
            autocorrect: false,
            validator: (value) {
              if (value == null || value.trim().isEmpty) {
                return l10n.connectionBrokerUrlRequired;
              }
              return null;
            },
          ),
          const SizedBox(height: 8),
          SelectableText(
            l10n.connectionBrokerUrlHint,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

/// Connect button with loading state.
class _ConnectButton extends StatelessWidget {
  const _ConnectButton({required this.isLoading, required this.onPressed});

  final bool isLoading;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return FilledButton.icon(
      onPressed: isLoading ? null : onPressed,
      icon: isLoading
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.wifi_find),
      label: Text(
        isLoading ? l10n.connectionConnecting : l10n.connectionConnect,
      ),
    );
  }
}

/// Card displaying the current connection state.
class _ConnectionStatusCard extends StatelessWidget {
  const _ConnectionStatusCard({required this.state});

  final ConnectionStateModel state;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final detail = state.technicalDetail;
    final status = switch (state) {
      ConnectionStateModel(status: ConnectionStatus.idle) => _StatusRow(
        icon: Icons.circle_outlined,
        color: tokens.statusIdle,
        title: l10n.connectionIdleTitle,
        subtitle: l10n.connectionIdleBody,
      ),
      ConnectionStateModel(status: ConnectionStatus.validating) => _StatusRow(
        icon: Icons.sync,
        color: tokens.statusNeedsInput,
        title: l10n.connectionCheckingTitle,
        subtitle: l10n.connectionCheckingBody,
      ),
      ConnectionStateModel(
        status: ConnectionStatus.success,
        :final machine,
        :final brokerUrl,
      ) =>
        _StatusRow(
          icon: Icons.check_circle,
          color: tokens.statusWorking,
          title: l10n.connectionConnectedTitle,
          subtitle: machine != null
              ? l10n.connectionConnectedMachine(machine)
              : l10n.connectionConnectedAt(brokerUrl?.toString() ?? '—'),
        ),
      ConnectionStateModel(
        status: ConnectionStatus.failure,
        :final failureKind,
      ) =>
        _StatusRow(
          icon: Icons.error,
          color: tokens.statusError,
          title: l10n.connectionFailedTitle,
          subtitle: switch (failureKind) {
            ConnectionFailureKind.invalidAddress => l10n.connectionInvalidUrl,
            ConnectionFailureKind.brokerUnhealthy =>
              l10n.connectionBrokerUnhealthy,
            ConnectionFailureKind.unreachable ||
            null => l10n.connectionBrokerUnreachable,
          },
        ),
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SelectionArea(child: status),
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
        ),
      ),
    );
  }
}

/// A status row with icon, title, and subtitle.
class _StatusRow extends StatelessWidget {
  const _StatusRow({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
  });

  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: color, size: 32),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 4),
              Text(
                subtitle,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
