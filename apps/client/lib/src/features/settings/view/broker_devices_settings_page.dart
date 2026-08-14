import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/broker_profiles/view/broker_profiles_page.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_connection_gate.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
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

  Future<void> _showAddServerChoices() async {
    final l10n = AppLocalizations.of(context);
    final choice = await showModalBottomSheet<_AddServerChoice>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              key: const Key('servers-add-direct'),
              leading: const Icon(Icons.link),
              title: Text(l10n.connectionDirectTitle),
              subtitle: Text(l10n.connectionDirectBody),
              onTap: () => Navigator.pop(context, _AddServerChoice.direct),
            ),
            ListTile(
              key: const Key('servers-add-pair'),
              leading: const Icon(Icons.qr_code_scanner),
              title: Text(l10n.connectionPairTitle),
              subtitle: Text(l10n.connectionPairBody),
              onTap: () => Navigator.pop(context, _AddServerChoice.pair),
            ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    await context.push(
      choice == _AddServerChoice.direct ? connectionRoute : pairingRoute,
    );
  }

  Future<void> _signOut() async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.settingsSignOutConfirmTitle),
        content: Text(l10n.settingsSignOutConfirmBody),
        actions: [
          const SettingsDialogCancelButton(),
          SettingsDialogConfirmButton(label: l10n.settingsSignOutAction),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await ref.read(brokerCredentialsControllerProvider.notifier).signOut();
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
              child: SelectableText(message, style: TextStyle(color: color)),
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
            SettingsSection(
              title: l10n.savedServers,
              child: const BrokerProfilesPage(embedded: true),
            ),
            const SizedBox(height: 16),
            Card(
              margin: EdgeInsets.zero,
              child: ListTile(
                key: const Key('servers-add'),
                leading: const Icon(Icons.add_circle_outline),
                title: Text(l10n.serversAddTitle),
                subtitle: Text(l10n.serversAddSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => unawaited(_showAddServerChoices()),
              ),
            ),
            const SizedBox(height: 16),
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
                      onSave: () => unawaited(_saveToken()),
                      isBusy: credentialState.isBusy,
                    ),
            ),
            const SizedBox(height: 16),
            _buildCredentialStateMessage(context, credentialState),
            const SizedBox(height: 16),
            _ServerCredentialRemoval(
              isBusy: credentialState.isBusy,
              hasCredential: activeProfile?.credentialKey != null,
              onSignOut: () => unawaited(_signOut()),
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
    required this.onSave,
    required this.isBusy,
  });

  final TextEditingController tokenController;
  final VoidCallback onSave;
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
          ],
        ),
      ],
    );
  }
}

enum _AddServerChoice { direct, pair }

class _ServerCredentialRemoval extends StatelessWidget {
  const _ServerCredentialRemoval({
    required this.isBusy,
    required this.hasCredential,
    required this.onSignOut,
  });

  final bool isBusy;
  final bool hasCredential;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final colors = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        key: const Key('servers-remove-credential'),
        leading: Icon(Icons.logout, color: colors.error),
        title: Text(
          l10n.settingsSignOutAction,
          style: TextStyle(color: colors.error),
        ),
        subtitle: Text(
          hasCredential
              ? l10n.settingsSignOutSubtitleHasCredential
              : l10n.settingsSignOutSubtitleNoCredential,
        ),
        enabled: !isBusy && hasCredential,
        onTap: isBusy || !hasCredential ? null : onSignOut,
      ),
    );
  }
}
