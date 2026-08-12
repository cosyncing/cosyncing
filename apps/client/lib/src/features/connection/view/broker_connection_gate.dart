import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/broker_credential_notice_text.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_hold.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInput;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Connection-state gate for the active broker.
///
/// Renders nothing while connected. Otherwise it explains the blocking
/// condition and offers only the recovery actions that apply:
///
/// * [BrokerGateStatus.unselected] — offers a single route to add a server.
/// * [BrokerGateStatus.unreachable] — reports the broker as offline and
///   deliberately offers **no** credential entry. Asking for a token when the
///   broker is merely down teaches users to re-paste a working secret.
/// * [BrokerGateStatus.unauthorized] — names whether no credential is stored
///   or a stored one was refused, then routes to pairing (preferred, because
///   peer credentials are per-device and revocable) with raw-token entry
///   available as a dev/bootstrap escape hatch.
///
/// This is the first screen a new user sees, so every string here is
/// user-facing product copy: plain language, no status codes, no exception or
/// Dart type names. Raw diagnostics stay reachable for support behind the
/// collapsed "Technical details" disclosure in [_GateCard] — never in the
/// primary reading path.
///
/// See `docs/architecture/client-ui.md`.
class BrokerConnectionGate extends ConsumerWidget {
  /// Creates the [BrokerConnectionGate].
  const BrokerConnectionGate({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = ref.watch(brokerGateControllerProvider);
    final l10n = AppLocalizations.of(context);

    return gate.when(
      loading: () => _GateCard(
        key: const Key('broker-gate-checking'),
        icon: Icons.sync,
        title: l10n.brokerGateCheckingTitle,
        body: l10n.brokerGateCheckingBody,
        // A probe in flight is not a failure; keep the icon neutral.
        isFailure: false,
        children: const [],
      ),
      error: (error, _) => _GateCard(
        key: const Key('broker-gate-error'),
        icon: Icons.error_outline,
        title: l10n.brokerGateErrorTitle,
        body: l10n.brokerGateErrorBody,
        detail: '$error',
        children: [
          _RetryButton(
            onPressed: () => unawaited(
              ref.read(brokerGateControllerProvider.notifier).refresh(),
            ),
          ),
        ],
      ),
      data: (state) => switch (state.status) {
        BrokerGateStatus.connected => const SizedBox.shrink(
          key: Key('broker-gate-connected'),
        ),
        BrokerGateStatus.unselected => const _UnselectedCard(),
        BrokerGateStatus.unreachable => _UnreachableCard(state: state),
        BrokerGateStatus.unauthorized => _UnauthorizedCard(state: state),
      },
    );
  }
}

/// First-run presentation when no saved server is selected.
class _UnselectedCard extends StatelessWidget {
  const _UnselectedCard();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return _GateCard(
      key: const Key('broker-gate-unselected'),
      icon: Icons.dns_outlined,
      title: l10n.brokerGateUnselectedTitle,
      body: l10n.brokerGateUnselectedBody,
      isFailure: false,
      children: [
        FilledButton.icon(
          key: const Key('broker-gate-connect-server'),
          onPressed: () => context.push(connectionRoute),
          icon: const Icon(Icons.link),
          label: Text(l10n.brokerGateConnectServer),
        ),
      ],
    );
  }
}

/// Broker-offline presentation. Never offers credential entry.
class _UnreachableCard extends ConsumerWidget {
  const _UnreachableCard({required this.state});

  final BrokerGateState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final target = state.brokerUrl;
    final name = state.profileDisplayName ?? target?.host ?? '';
    return _GateCard(
      key: const Key('broker-gate-unreachable'),
      icon: Icons.cloud_off,
      title: l10n.brokerGateUnreachableTitle(name),
      body: l10n.brokerGateUnreachableBodyAt(target?.toString() ?? ''),
      detail: state.detail,
      children: [
        _RetryButton(
          onPressed: () => unawaited(
            ref.read(brokerGateControllerProvider.notifier).refresh(),
          ),
        ),
        OutlinedButton.icon(
          key: const Key('broker-gate-switch-server'),
          onPressed: () => context.push(brokerProfilesRoute),
          icon: const Icon(Icons.swap_horiz),
          label: Text(l10n.brokerGateSwitchServer),
        ),
        OutlinedButton.icon(
          key: const Key('broker-gate-add-server'),
          onPressed: () => context.push(connectionRoute),
          icon: const Icon(Icons.add_link),
          label: Text(l10n.brokerGateAddServer),
        ),
      ],
    );
  }
}

/// Rejected-request presentation, split by whether a credential was actually
/// sent. The two cases need different copy and a different call to action, so
/// they stay deliberately distinct.
class _UnauthorizedCard extends ConsumerStatefulWidget {
  const _UnauthorizedCard({required this.state});

  final BrokerGateState state;

  @override
  ConsumerState<_UnauthorizedCard> createState() => _UnauthorizedCardState();
}

class _UnauthorizedCardState extends ConsumerState<_UnauthorizedCard>
    with WebHandoffHold<_UnauthorizedCard> {
  final _tokenController = TextEditingController();

  // A typed-but-unsaved broker token is unrecoverable: it is pasted from
  // somewhere else, never persisted until save, and a web-update handoff that
  // discarded it would send the user back to look it up again (N3b).
  @override
  List<TextEditingController> get webHandoffControllers => [_tokenController];

  @override
  void dispose() {
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _saveToken() async {
    await ref
        .read(brokerCredentialsControllerProvider.notifier)
        .saveToken(_tokenController.text);

    // Tells the platform the credential flow finished so the browser/OS can
    // offer to save it. On web this is best-effort; see the class docs on
    // BrokerConnectionGate and docs/architecture/client-ui.md.
    TextInput.finishAutofillContext();

    if (!mounted) return;
    _tokenController.clear();
    await ref.read(brokerGateControllerProvider.notifier).refresh();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final rejected = widget.state.hasRejectedCredential;
    final credentialState = ref.watch(brokerCredentialsControllerProvider);
    final host =
        widget.state.brokerUrl?.host ?? l10n.brokerGateBrokerFieldLabel;

    // A credential refused right after the user typed one is a different
    // situation from a stored credential that stopped working, even though the
    // broker answers 401 to both. Telling a first-run user their device "is no
    // longer signed in" claims access they never had, and points them at
    // revocation as the cause when the real cause is usually a mistyped or
    // truncated token.
    final justEnteredToken = credentialState.savedTokenThisSession;
    final tokenJustRefused = rejected && justEnteredToken;

    final credentialMessage = brokerCredentialNoticeText(l10n, credentialState);
    // Raw diagnostics from both the probe and the last credential action, kept
    // together in the one disclosure rather than in the reading path.
    final credentialDetail = credentialState.hasError
        ? credentialState.detail
        : null;
    final details = <String>[
      if (widget.state.detail != null) widget.state.detail!,
      if (credentialDetail != null) credentialDetail,
    ];

    return _GateCard(
      key: Key(
        rejected
            ? 'broker-gate-credential-rejected'
            : 'broker-gate-credential-missing',
      ),
      icon: rejected ? Icons.gpp_bad_outlined : Icons.key_off_outlined,
      title: switch ((rejected, tokenJustRefused)) {
        (true, true) => l10n.brokerGateTokenRejectedTitle,
        (true, false) => l10n.brokerGateRejectedTitle,
        (false, _) => l10n.brokerGateMissingTitle,
      },
      body: switch ((rejected, tokenJustRefused)) {
        (true, true) => l10n.brokerGateTokenRejectedBody,
        (true, false) => l10n.brokerGateRejectedBody,
        (false, _) => l10n.brokerGateMissingBody,
      },
      // A first-run device that simply has no credential yet is an expected
      // setup step, not an error, so it gets no alarm-red icon.
      isFailure: rejected,
      // The raw 401 diagnostic says nothing a user can act on here — the card
      // body already explains the situation and the fix. Support still gets it
      // via the collapsed disclosure.
      detail: details.isEmpty ? null : details.join('\n\n'),
      // Both ways in are shown at once. Hiding token entry behind a toggle made
      // the field undiscoverable, leaving a first-run user with only a QR code
      // and no idea a token was an option.
      content: [
        const _TokenHelp(),
        const SizedBox(height: 16),
        _TokenEntryForm(
          controller: _tokenController,
          host: host,
          isBusy: credentialState.isBusy,
          onSubmit: () => unawaited(_saveToken()),
        ),
        if (credentialState.hasError && credentialMessage != null) ...[
          const SizedBox(height: 8),
          Text(
            credentialMessage,
            key: const Key('broker-gate-token-error'),
            style: TextStyle(color: context.tokens.statusError),
          ),
        ],
      ],
      children: [
        FilledButton.icon(
          key: const Key('broker-gate-pair-device'),
          onPressed: () => context.push(pairingRoute),
          icon: const Icon(Icons.qr_code_2),
          label: Text(
            rejected
                ? l10n.brokerGatePairDeviceAgain
                : l10n.brokerGatePairDevice,
          ),
        ),
        _RetryButton(
          onPressed: () => unawaited(
            ref.read(brokerGateControllerProvider.notifier).refresh(),
          ),
        ),
      ],
    );
  }
}

/// Where the broker token actually lives.
///
/// A first-run user has no way to guess this, and the screen is useless without
/// it. The path and the command are literal shell strings, so they are never
/// localized and render monospaced and selectable for copying.
class _TokenHelp extends StatelessWidget {
  const _TokenHelp();

  /// Command that prints the owner token on the broker host.
  static const String tokenCommand = 'cat ~/.cosyncing/secrets/broker-token';

  /// Command that pairs a device instead of using the owner token.
  static const String pairCommand = 'cosy pair';

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final labelStyle = theme.textTheme.bodySmall?.copyWith(
      color: tokens.textSecondary,
    );

    return Container(
      key: const Key('broker-gate-token-help'),
      width: double.infinity,
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusMd),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.brokerGateTokenHelpTitle,
            style: theme.textTheme.labelLarge,
          ),
          const SizedBox(height: 8),
          Text(l10n.brokerGateTokenHelpGuidance, style: labelStyle),
          const SizedBox(height: 8),
          CopyableCodeLine(
            text: tokenCommand,
            copyTooltip: l10n.copyCommand,
            copiedMessage: l10n.copyCommandCopied,
          ),
          const SizedBox(height: 8),
          CopyableCodeLine(
            text: pairCommand,
            copyTooltip: l10n.copyCommand,
            copiedMessage: l10n.copyCommandCopied,
          ),
        ],
      ),
    );
  }
}

/// Raw broker-token entry: the dev/bootstrap path, not the preferred one.
///
/// Wrapped in an [AutofillGroup] with a username-ish broker identity field so
/// a password manager has something to associate the secret with. Flutter web
/// autofill is only partially supported — see `docs/architecture/client-ui.md`.
class _TokenEntryForm extends StatelessWidget {
  const _TokenEntryForm({
    required this.controller,
    required this.host,
    required this.isBusy,
    required this.onSubmit,
  });

  final TextEditingController controller;
  final String host;
  final bool isBusy;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return AutofillGroup(
      key: const Key('broker-gate-autofill-group'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextFormField(
            key: const Key('broker-gate-identity-field'),
            initialValue: host,
            readOnly: true,
            autofillHints: const [AutofillHints.username],
            decoration: InputDecoration(
              border: const OutlineInputBorder(),
              labelText: l10n.brokerGateBrokerFieldLabel,
            ),
          ),
          const SizedBox(height: 12),
          TextFormField(
            key: const Key('broker-gate-token-field'),
            controller: controller,
            obscureText: true,
            autofillHints: const [AutofillHints.password],
            decoration: InputDecoration(
              border: const OutlineInputBorder(),
              labelText: l10n.brokerGateTokenFieldLabel,
            ),
            keyboardType: TextInputType.visiblePassword,
            textInputAction: TextInputAction.done,
            onFieldSubmitted: (_) => onSubmit(),
          ),
          const SizedBox(height: 12),
          FilledButton.tonalIcon(
            key: const Key('broker-gate-save-token'),
            onPressed: isBusy ? null : onSubmit,
            icon: isBusy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save),
            label: Text(
              isBusy ? l10n.brokerGateSavingToken : l10n.brokerGateSaveToken,
            ),
          ),
          const SizedBox(height: 8),
          // A footnote, not a gate: pairing and token entry are co-equal ways
          // in, so this states the tradeoff without deterring the token path.
          Text(
            l10n.brokerGateTokenNotice,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _RetryButton extends StatelessWidget {
  const _RetryButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      key: const Key('broker-gate-retry'),
      onPressed: onPressed,
      icon: const Icon(Icons.refresh),
      label: Text(AppLocalizations.of(context).brokerGateRetry),
    );
  }
}

/// Shared card chrome for every gate state.
///
/// Wraps its content in a [SelectionArea] so users can select and copy the
/// explanation, the broker address, and the raw diagnostics — the things people
/// need when asking someone else for help. Buttons and text fields keep their
/// own gesture handling inside a [SelectionArea]; only static [Text] becomes
/// selectable.
class _GateCard extends StatelessWidget {
  const _GateCard({
    required this.icon,
    required this.title,
    required this.body,
    required this.children,
    this.content = const [],
    this.detail,
    this.isFailure = true,
    super.key,
  });

  final IconData icon;
  final String title;
  final String body;

  /// Full-width blocks (guidance, forms) rendered between the body and the
  /// action row. Kept separate from [children] because those are laid out in a
  /// [Wrap] sized to the buttons.
  final List<Widget> content;

  /// Raw, untranslated diagnostic text. Never rendered in the primary reading
  /// path — see [_TechnicalDetails].
  final String? detail;

  /// Whether this state is an actual failure. Drives only the icon colour, so
  /// expected states (probe in flight, first-run pairing) do not read as
  /// errors.
  final bool isFailure;

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final trimmedDetail = detail?.trim();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectionArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        icon,
                        color: isFailure
                            ? colors.error
                            : colors.onSurfaceVariant,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(title, style: theme.textTheme.titleMedium),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    body,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            if (content.isNotEmpty) ...[
              const SizedBox(height: 16),
              SelectionArea(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: content,
                ),
              ),
            ],
            if (children.isNotEmpty) ...[
              const SizedBox(height: 16),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: children,
              ),
            ],
            if (trimmedDetail != null && trimmedDetail.isNotEmpty) ...[
              const SizedBox(height: 8),
              _TechnicalDetails(detail: trimmedDetail),
            ],
          ],
        ),
      ),
    );
  }
}

/// Collapsed disclosure holding the raw diagnostic string.
///
/// The diagnostic is developer-facing text (transport errors, status codes)
/// and is deliberately kept out of the headline. It stays available, and
/// selectable, so a user can copy it into a support request.
class _TechnicalDetails extends StatelessWidget {
  const _TechnicalDetails({required this.detail});

  final String detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Theme(
      // Strips the default ExpansionTile divider lines so the disclosure reads
      // as a quiet footnote rather than another section of the card.
      data: theme.copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        key: const Key('broker-gate-technical-details'),
        tilePadding: EdgeInsets.zero,
        childrenPadding: EdgeInsets.zero,
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        visualDensity: VisualDensity.compact,
        title: Text(
          AppLocalizations.of(context).brokerGateTechnicalDetails,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        children: [
          SelectionArea(
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                detail,
                key: const Key('broker-gate-detail'),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                  fontFamily: 'monospace',
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
