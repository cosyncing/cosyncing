import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The sidebar footer's server switcher: every saved server one tap away,
/// then adding one and managing them all.
///
/// The menu is as wide as the footer row it opens from and flips above it,
/// so on a phone's drawer and a desktop sidebar alike it reads as the row
/// unfolding rather than as a dialog somewhere else. Saved servers are read
/// only while the menu is open: the footer itself stays as cheap as a label.
class WorkspaceServerSwitcher extends StatelessWidget {
  /// Creates the switcher around the footer row [builder] draws.
  const WorkspaceServerSwitcher({
    required this.activeSubtitle,
    required this.onAddServer,
    required this.onManageServers,
    required this.builder,
    super.key,
  });

  /// The footer's own status line for the server in use.
  final String? activeSubtitle;

  /// Starts adding a server.
  final VoidCallback onAddServer;

  /// Opens Settings → Servers.
  final VoidCallback onManageServers;

  /// Draws the anchor; call `toggle` to open or close the menu.
  final Widget Function(BuildContext context, VoidCallback toggle) builder;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;

    Widget action({
      required Key key,
      required StrokeGlyph glyph,
      required String label,
      required VoidCallback onPressed,
    }) => MenuItemButton(
      key: key,
      leadingIcon: StrokeIcon(glyph, color: tokens.textSecondary),
      onPressed: onPressed,
      child: Text(
        label,
        style: theme.textTheme.labelLarge?.copyWith(
          color: tokens.textSecondary,
          fontWeight: FontWeight.w400,
        ),
      ),
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        return MenuAnchor(
          style: MenuStyle(
            backgroundColor: WidgetStatePropertyAll(tokens.surface),
            surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
            elevation: const WidgetStatePropertyAll(8),
            minimumSize: WidgetStatePropertyAll(Size(width, 0)),
            maximumSize: WidgetStatePropertyAll(Size(width, 480)),
            padding: const WidgetStatePropertyAll(
              EdgeInsets.symmetric(vertical: 8),
            ),
            // A shadow alone vanishes against a dark sidebar.
            side: WidgetStatePropertyAll(
              theme.brightness == Brightness.dark
                  ? BorderSide(color: tokens.separator)
                  : BorderSide.none,
            ),
            shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(tokens.radiusLg),
              ),
            ),
          ),
          alignmentOffset: const Offset(0, 4),
          // Otherwise the panel shrinks to its widest entry and ignores the
          // footer width set above.
          crossAxisUnconstrained: false,
          menuChildren: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: Text(
                l10n.settingsCategoryBrokerTitle,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: tokens.textTertiary,
                ),
              ),
            ),
            _ServerOptions(activeSubtitle: activeSubtitle),
            const SizedBox(height: 8),
            action(
              key: const Key('workspace-server-add'),
              glyph: StrokeGlyph.plus,
              label: l10n.serversAddTitle,
              onPressed: onAddServer,
            ),
            action(
              key: const Key('workspace-server-manage'),
              glyph: StrokeGlyph.settings,
              label: l10n.workspaceServerManage,
              onPressed: onManageServers,
            ),
          ],
          builder: (context, controller, _) => builder(
            context,
            () => controller.isOpen ? controller.close() : controller.open(),
          ),
        );
      },
    );
  }
}

/// One menu entry per saved server, the one in use checked.
class _ServerOptions extends ConsumerWidget {
  const _ServerOptions({required this.activeSubtitle});

  final String? activeSubtitle;

  Future<void> _activate(
    BuildContext context,
    WidgetRef ref,
    BrokerProfile profile,
  ) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final failed = AppLocalizations.of(context).brokerProfileActivateFailed;
    try {
      await ref
          .read(brokerProfileManagerControllerProvider)
          .setActiveProfile(profile.id, expectedProfile: profile);
    } on BrokerProfileManagerException {
      messenger?.showSnackBar(SnackBar(content: Text(failed)));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final profiles =
        ref.watch(brokerProfileListProvider).valueOrNull ??
        const <BrokerProfile>[];
    final activeId = ref.watch(activeBrokerProfileProvider)?.id;
    final secondary = theme.textTheme.labelSmall?.copyWith(
      color: tokens.textTertiary,
    );

    Widget option(BrokerProfile profile) {
      final active = profile.id == activeId;
      final subtitle = active
          ? activeSubtitle ?? profile.displayAddress
          : profile.displayAddress;
      return MenuItemButton(
        key: Key('workspace-server-option-${profile.id}'),
        leadingIcon: StrokeIcon(
          StrokeGlyph.monitor,
          color: active ? tokens.textPrimary : tokens.textSecondary,
        ),
        trailingIcon: SizedBox.square(
          dimension: 16,
          child: active
              ? Icon(Icons.check, size: 16, color: tokens.textPrimary)
              : null,
        ),
        onPressed: active
            ? () {}
            : () => unawaited(_activate(context, ref, profile)),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                profile.displayName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelLarge?.copyWith(
                  color: tokens.textPrimary,
                  fontWeight: active ? FontWeight.w700 : FontWeight.w400,
                ),
              ),
              Text(
                subtitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: secondary,
              ),
            ],
          ),
        ),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [for (final profile in profiles) option(profile)],
    );
  }
}
