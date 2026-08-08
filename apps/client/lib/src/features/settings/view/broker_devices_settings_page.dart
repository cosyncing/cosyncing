import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_connection_gate.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/managed_runtime_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/broker_credential_notice_text.dart';
import 'package:cosyncing_client/src/features/settings/view/broker_status_settings_section.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/web_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_hold.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Settings → Broker & devices: which broker this device talks to, and how it
/// authenticated with it.
///
/// See `docs/architecture/client-ui.md` for the broker credential controls.
class BrokerDevicesSettingsPage extends ConsumerStatefulWidget {
  /// Creates the broker and devices settings category page.
  const BrokerDevicesSettingsPage({super.key});

  @override
  ConsumerState<BrokerDevicesSettingsPage> createState() =>
      _BrokerDevicesSettingsPageState();
}

class _BrokerDevicesSettingsPageState
    extends ConsumerState<BrokerDevicesSettingsPage>
    with WebHandoffHold<BrokerDevicesSettingsPage> {
  final _tokenController = TextEditingController();

  /// N3b: an unsaved token lives only in this field. It sits on an ordinary
  /// page rather than in an editor the user opened, so it defers a web-update
  /// handoff only while it actually holds something — an empty field has
  /// nothing to lose, and blocking every update for one would be a bad trade.
  ///
  /// The mixin is what makes clearing it announce readiness; without that the
  /// tab would keep deferring on the retry cadence long after it emptied.
  @override
  List<TextEditingController> get webHandoffControllers => [_tokenController];

  @override
  void dispose() {
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _saveToken() async {
    final submitted = _tokenController.text;
    await ref
        .read(brokerCredentialsControllerProvider.notifier)
        .saveToken(submitted);
    if (!mounted) return;
    // A persisted token is no longer losable, so leaving it in the field
    // would keep deferring web-update handoffs for content that is already
    // durable. Only a confirmed save empties the field, and only while it
    // still holds exactly what was saved — anything typed during the save is
    // a newer credential nobody persisted yet.
    final notice = ref.read(brokerCredentialsControllerProvider).notice;
    if (notice == BrokerCredentialNotice.tokenSaved &&
        _tokenController.text == submitted) {
      _tokenController.clear();
    }
  }

  void _clearToken() {
    unawaited(
      ref.read(brokerCredentialsControllerProvider.notifier).clearToken(),
    );
  }

  Widget _buildCredentialStateMessage(
    BuildContext context,
    BrokerCredentialsState state,
  ) {
    final tokens = context.tokens;
    final message = brokerCredentialNoticeText(
      AppLocalizations.of(context),
      state,
    );
    if (message == null) return const SizedBox.shrink();

    final isError = state.hasError;
    final color = isError ? tokens.statusError : tokens.statusWorking;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(
              isError ? Icons.error : Icons.check_circle,
              color: color,
              size: 20,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(message, style: TextStyle(color: color)),
            ),
          ],
        ),
        // Raw diagnostics stay out of the reading path here too, matching the
        // connection gate's disclosure rather than appending the exception.
        if (isError && state.detail != null)
          SettingsTechnicalDetailsDisclosure(detail: state.detail!),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final activeProfile = ref.watch(activeBrokerProfileProvider);
    final credentialState = ref.watch(brokerCredentialsControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsCategoryBrokerTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const BrokerConnectionGate(),
            const _ClientCompatibilityFallback(),
            const BrokerStatusSettingsSection(),
            const SizedBox(height: 16),
            SettingsSection(
              title: l10n.settingsSectionBrokerCredentials,
              // No loopback branch: a broker on 127.0.0.1 still requires a
              // token once one is provisioned, so it needs the same credential
              // controls as any other host. See broker_credentials_controller.
              child: activeProfile == null
                  ? const _EmptyCredentialSection()
                  : _RemoteCredentialSection(
                      tokenController: _tokenController,
                      hasCredentialKey: activeProfile.credentialKey != null,
                      onSave: () => unawaited(_saveToken()),
                      onClear: _clearToken,
                      isBusy: credentialState.isBusy,
                    ),
            ),
            const SizedBox(height: 16),
            _buildCredentialStateMessage(context, credentialState),
            const SizedBox(height: 16),
            SettingsLinkGroup(
              tiles: [
                SettingsLinkTile(
                  icon: Icons.storage_outlined,
                  title: l10n.settingsBrokerProfilesTitle,
                  subtitle: l10n.settingsBrokerProfilesSubtitle,
                  onTap: () => context.push(brokerProfilesRoute),
                ),
                SettingsLinkTile(
                  tileKey: const Key('settings-pairing'),
                  icon: Icons.qr_code_scanner,
                  title: l10n.settingsPairingTitle,
                  subtitle: l10n.settingsPairingSubtitle,
                  onTap: () => context.push(pairingRoute),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Profile-qualified fallback when no stronger update notice owns the page.
///
/// A waiting web worker means the fix is already downloaded and the page is
/// moving this tab into it (N3b), so telling the user their client is behind
/// would be advice about a problem that is in the middle of resolving itself.
/// The desktop version pointer also wins when its release comparison says this
/// app is behind. Native clients with no decisive release comparison, and web
/// clients with no waiting build, still need a durable, non-session explanation
/// of a writable `clientBehind` overlap.
class _ClientCompatibilityFallback extends ConsumerWidget {
  const _ClientCompatibilityFallback();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(activeBrokerProfileProvider);
    final source = RosterSource.of(profile);
    if (profile == null || source == null) return const SizedBox.shrink();

    final webUpdate = ref.watch(webClientUpdateProvider).valueOrNull;
    if (webUpdate == null || webUpdate.updateReady) {
      return const SizedBox.shrink();
    }
    final hello = ref
        .watch(brokerHelloIdentityProvider(source.storageKey))
        .valueOrNull;
    final compatibility = hello?.compatibility;
    final client = compatibility?.client;
    final clientVersion = ref.watch(desktopClientVersionProvider);
    if (compatibility?.status != BrokerClientCompatibilityStatus.clientBehind ||
        (compatibility?.readOnly ?? true) ||
        hello?.clientVersion != clientVersion ||
        client == null ||
        client.revision != cosyncingClientContractRevision ||
        client.minimumBrokerRevision != cosyncingClientMinimumBrokerRevision ||
        client.surfaceHash != cosyncingClientContractSurfaceHash) {
      return const SizedBox.shrink();
    }

    final platform = Theme.of(context).platform;
    String? brokerVersion;
    if (isDesktopClientPlatform(platform, isWeb: kIsWeb)) {
      final runtime = ref.watch(managedRuntimeControllerProvider);
      final runtimeValue = runtime.valueOrNull;
      // The controller deliberately retains A while B loads. Only B's own
      // snapshot may arbitrate B's update guidance while that read is pending.
      // Once the read settles with an error, the runtime section cannot render
      // its desktop pointer. Leave the comparison unresolved so the validated,
      // source-qualified compatibility result owns the remaining guidance.
      final settledError = runtime.hasError && !runtime.isLoading;
      if (!settledError) {
        if (runtimeValue?.brokerScopeKey != source.storageKey) {
          return const SizedBox.shrink();
        }
        brokerVersion = runtimeValue?.productHealth?.version;
      }
    }
    final guidance = resolveClientUpdateGuidance(
      platform: platform,
      isWeb: kIsWeb,
      brokerVersion: brokerVersion,
      clientVersion: clientVersion,
      compatibilityFallbackAvailable: true,
    );
    if (guidance != ClientUpdateGuidance.compatibilityFallback) {
      return const SizedBox.shrink();
    }

    final l10n = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: SettingsSection(
        title: l10n.settingsCompatibilityTitle,
        child: SelectableText(
          l10n.settingsClientBehindMessage(profile.displayName),
          key: const Key('settings-client-behind-compatibility'),
        ),
      ),
    );
  }
}

class _EmptyCredentialSection extends StatelessWidget {
  const _EmptyCredentialSection();

  @override
  Widget build(BuildContext context) {
    return Text(
      AppLocalizations.of(context).settingsConnectToBrokerFirst,
      style: Theme.of(context).textTheme.bodyMedium,
    );
  }
}

class _RemoteCredentialSection extends StatelessWidget {
  const _RemoteCredentialSection({
    required this.tokenController,
    required this.hasCredentialKey,
    required this.onSave,
    required this.onClear,
    required this.isBusy,
  });

  final TextEditingController tokenController;
  final bool hasCredentialKey;
  final VoidCallback onSave;
  final VoidCallback onClear;
  final bool isBusy;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l10n.settingsRemoteCredentialDescription,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        TextFormField(
          key: const Key('settings-broker-token-field'),
          controller: tokenController,
          obscureText: true,
          decoration: InputDecoration(
            border: const OutlineInputBorder(),
            labelText: l10n.brokerGateTokenFieldLabel,
          ),
          keyboardType: TextInputType.visiblePassword,
          textInputAction: TextInputAction.done,
          onFieldSubmitted: (_) => onSave(),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            FilledButton.icon(
              key: const Key('settings-save-token'),
              onPressed: isBusy ? null : onSave,
              icon: isBusy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save),
              label: Text(
                isBusy
                    ? l10n.brokerGateSavingToken
                    : l10n.settingsSaveTokenAction,
              ),
            ),
            if (hasCredentialKey)
              OutlinedButton.icon(
                key: const Key('settings-clear-token'),
                onPressed: isBusy ? null : onClear,
                icon: const Icon(Icons.delete_outline),
                label: Text(l10n.settingsDeleteTokenAction),
              ),
          ],
        ),
      ],
    );
  }
}
