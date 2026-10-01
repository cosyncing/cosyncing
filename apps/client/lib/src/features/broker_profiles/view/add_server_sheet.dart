import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Asks how to add a server — connect directly, or pair this device — and
/// opens that flow. Shared by Settings → Servers and the sidebar's server
/// switcher so both offer the same two ways in.
Future<void> showAddServerChoices(BuildContext context) async {
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
  if (!context.mounted || choice == null) return;
  await context.push(
    choice == _AddServerChoice.direct ? connectionRoute : pairingRoute,
  );
}

enum _AddServerChoice { direct, pair }
