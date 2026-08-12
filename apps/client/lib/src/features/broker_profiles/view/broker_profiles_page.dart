import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Broker profile management surface.
///
/// Allows users to list, activate, edit, and delete saved broker profiles.
/// See `docs/architecture/client-ui.md`.
class BrokerProfilesPage extends ConsumerStatefulWidget {
  /// Creates the broker profile management page.
  const BrokerProfilesPage({this.embedded = false, super.key});

  /// Renders only the saved-server content for the outer Servers page.
  final bool embedded;

  @override
  ConsumerState<BrokerProfilesPage> createState() => _BrokerProfilesPageState();
}

class _BrokerProfilesPageState extends ConsumerState<BrokerProfilesPage> {
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final profileList = ref.watch(brokerProfileListProvider);
    final activeProfile = ref.watch(activeBrokerProfileProvider);

    final content = Padding(
      padding: widget.embedded ? EdgeInsets.zero : const EdgeInsets.all(16),
      child: profileList.when(
        data: (profiles) => profiles.isEmpty
            ? _EmptyProfileState(
                onOpenConnection: () {
                  context.push(connectionRoute);
                },
              )
            : _ProfileListSection(
                profiles: profiles,
                activeProfileId: activeProfile?.id,
                shrinkWrap: widget.embedded,
                onActivate: (profile) {
                  unawaited(_activateProfile(profile));
                },
                onEdit: (profile) {
                  unawaited(_openEditDialog(profile));
                },
                onDelete: (profile) {
                  unawaited(_confirmDelete(profile));
                },
              ),
        error: (error, _) => _ErrorState(
          message: localizedFailureMessage(
            l10n,
            error,
            lead: l10n.brokerProfilesLoadFailed,
          ),
        ),
        loading: () => const Center(child: CircularProgressIndicator()),
      ),
    );
    if (widget.embedded) return content;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.brokerProfilesTitle)),
      body: SafeArea(child: content),
    );
  }

  Future<void> _activateProfile(BrokerProfile profile) async {
    final l10n = AppLocalizations.of(context);
    try {
      await ref
          .read(brokerProfileManagerControllerProvider)
          .setActiveProfile(profile.id, expectedProfile: profile);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(l10n.brokerProfileActivated(profile.displayName)),
          ),
        );
      }
    } on BrokerProfileManagerException {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(l10n.brokerProfileActivateFailed),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
  }

  Future<void> _confirmDelete(BrokerProfile profile) async {
    final l10n = AppLocalizations.of(context);
    final deleteMessage = profile.credentialKey == null
        ? l10n.brokerProfileDeleteWithoutToken(profile.displayName)
        : l10n.brokerProfileDeleteWithToken(profile.displayName);
    final shouldDelete = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: Text(l10n.brokerProfileDeleteTitle),
          content: SelectableText(deleteMessage),
          actions: [
            TextButton(
              key: const Key('broker-profile-delete-cancel'),
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(l10n.cancel),
            ),
            FilledButton(
              key: const Key('broker-profile-delete-confirm'),
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(l10n.brokerProfileDeleteAction),
            ),
          ],
        );
      },
    );

    if (shouldDelete != true) {
      return;
    }

    try {
      await ref
          .read(brokerProfileManagerControllerProvider)
          .deleteProfile(profile.id, expectedProfile: profile);
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.brokerProfileDeleted(profile.displayName))),
      );
    } on BrokerProfileManagerException {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(l10n.brokerProfileDeleteFailed),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
  }

  Future<void> _openEditDialog(BrokerProfile profile) async {
    final didSave = await showDialog<bool>(
      context: context,
      builder: (context) {
        return _EditProfileDialog(profile: profile);
      },
    );

    if (didSave != true) {
      return;
    }

    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(AppLocalizations.of(context).brokerProfileUpdated),
      ),
    );
  }
}

class _ProfileListSection extends StatelessWidget {
  const _ProfileListSection({
    required this.profiles,
    required this.activeProfileId,
    required this.shrinkWrap,
    required this.onActivate,
    required this.onEdit,
    required this.onDelete,
  });

  final List<BrokerProfile> profiles;
  final String? activeProfileId;
  final bool shrinkWrap;
  final ValueChanged<BrokerProfile> onActivate;
  final ValueChanged<BrokerProfile> onEdit;
  final ValueChanged<BrokerProfile> onDelete;

  @override
  Widget build(BuildContext context) {
    if (shrinkWrap) {
      return Column(
        children: [
          for (final profile in profiles) _buildProfileCard(context, profile),
        ],
      );
    }
    return ListView.builder(
      itemCount: profiles.length,
      itemBuilder: (context, index) =>
          _buildProfileCard(context, profiles[index]),
    );
  }

  Widget _buildProfileCard(BuildContext context, BrokerProfile profile) {
    final l10n = AppLocalizations.of(context);
    final isActive = profile.id == activeProfileId;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: ListTile(
        key: Key('broker-profile-row-${_sanitizeProfileId(profile.id)}'),
        title: SelectionArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(profile.displayName),
              const SizedBox(height: 4),
              _ProfileSubtitle(profile: profile),
            ],
          ),
        ),
        leading: Icon(
          isActive ? Icons.radio_button_checked : Icons.radio_button_unchecked,
          color: isActive
              ? Theme.of(context).colorScheme.primary
              : Theme.of(context).colorScheme.outline,
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isActive)
              Chip(
                label: Text(l10n.brokerProfileActive),
                visualDensity: VisualDensity.compact,
                side: BorderSide.none,
              )
            else
              FilledButton(
                key: Key(
                  'broker-profile-activate-'
                  '${_sanitizeProfileId(profile.id)}',
                ),
                onPressed: () => onActivate(profile),
                child: Text(l10n.brokerProfileUse),
              ),
            const SizedBox(width: 8),
            IconButton(
              key: Key(
                'broker-profile-edit-${_sanitizeProfileId(profile.id)}',
              ),
              icon: const Icon(Icons.edit_outlined),
              onPressed: () => onEdit(profile),
              tooltip: l10n.brokerProfileEditTooltip,
            ),
            IconButton(
              key: Key(
                'broker-profile-delete-${_sanitizeProfileId(profile.id)}',
              ),
              icon: const Icon(Icons.delete_outline),
              onPressed: () => onDelete(profile),
              tooltip: l10n.brokerProfileDeleteTooltip,
            ),
          ],
        ),
      ),
    );
  }
}

class _ProfileSubtitle extends StatelessWidget {
  const _ProfileSubtitle({required this.profile});

  final BrokerProfile profile;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final metadata = <String>[
      l10n.brokerProfileCreated(_formatDate(profile.createdAt)),
    ];

    if (profile.lastUsedAt != null) {
      metadata.add(
        l10n.brokerProfileLastUsed(_formatDate(profile.lastUsedAt!)),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          profile.baseUri.toString(),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 4),
        Text(
          metadata.join(' · '),
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          maxLines: 2,
        ),
      ],
    );
  }
}

class _EmptyProfileState extends StatelessWidget {
  const _EmptyProfileState({required this.onOpenConnection});

  final VoidCallback onOpenConnection;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SelectionArea(
                  child: Column(
                    children: [
                      Text(
                        l10n.brokerProfileEmptyTitle,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        l10n.brokerProfileEmptyBody,
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  key: const Key('broker-profile-empty-open-connection'),
                  onPressed: onOpenConnection,
                  icon: const Icon(Icons.link),
                  label: Text(l10n.brokerProfileOpenConnection),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SelectableText(
        message,
        style: TextStyle(color: Theme.of(context).colorScheme.error),
      ),
    );
  }
}

class _EditProfileDialog extends ConsumerStatefulWidget {
  const _EditProfileDialog({required this.profile});

  final BrokerProfile profile;

  @override
  ConsumerState<_EditProfileDialog> createState() => _EditProfileDialogState();
}

class _EditProfileDialogState extends ConsumerState<_EditProfileDialog> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _displayNameController;
  late final TextEditingController _baseUriController;
  bool _isSaving = false;
  bool _hasError = false;

  /// Defers a web-update handoff for as long as this editor is open (N3b).
  ///
  /// Its fields start prefilled and live only in widget state, so "empty" is
  /// never the safe signal a conditional hold needs. Closing the dialog is.
  VoidCallback? _releaseHandoffHold;

  @override
  void initState() {
    super.initState();
    _displayNameController = TextEditingController(
      text: widget.profile.displayName,
    );
    _baseUriController = TextEditingController(
      text: widget.profile.baseUri.toString(),
    );
    _releaseHandoffHold = WebHandoffParticipants.instance.hold();
  }

  @override
  void dispose() {
    _releaseHandoffHold?.call();
    _releaseHandoffHold = null;
    _displayNameController.dispose();
    _baseUriController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!(_formKey.currentState?.validate() ?? false)) {
      return;
    }

    setState(() {
      _isSaving = true;
      _hasError = false;
    });

    try {
      await ref
          .read(brokerProfileManagerControllerProvider)
          .saveProfileEdits(
            profileId: widget.profile.id,
            displayName: _displayNameController.text,
            baseUri: _baseUriController.text,
            expectedProfile: widget.profile,
          );
      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } on FormatException {
      if (!mounted) {
        return;
      }
      setState(() {
        _hasError = true;
        _isSaving = false;
      });
    } on BrokerProfileManagerException {
      if (!mounted) {
        return;
      }
      setState(() {
        _hasError = true;
        _isSaving = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return AlertDialog(
      title: Text(l10n.brokerProfileEditTitle),
      content: Form(
        key: _formKey,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextFormField(
                controller: _displayNameController,
                key: const Key('broker-profile-edit-display-name-field'),
                decoration: InputDecoration(
                  labelText: l10n.brokerProfileDisplayName,
                  border: const OutlineInputBorder(),
                ),
                textInputAction: TextInputAction.next,
                validator: (value) => (value == null || value.trim().isEmpty)
                    ? l10n.brokerProfileDisplayNameRequired
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _baseUriController,
                key: const Key('broker-profile-edit-base-uri-field'),
                decoration: InputDecoration(
                  labelText: l10n.brokerProfileBaseUrl,
                  border: const OutlineInputBorder(),
                ),
                keyboardType: TextInputType.url,
                autocorrect: false,
                validator: (value) => (value == null || value.trim().isEmpty)
                    ? l10n.brokerProfileBaseUrlRequired
                    : null,
              ),
              if (_hasError) ...[
                const SizedBox(height: 12),
                SelectableText(
                  l10n.brokerProfileSaveFailed,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('broker-profile-edit-cancel'),
          onPressed: _isSaving ? null : () => Navigator.of(context).pop(false),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          key: const Key('broker-profile-edit-save'),
          onPressed: _isSaving ? null : _save,
          child: _isSaving
              ? const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(l10n.save),
        ),
      ],
    );
  }
}

String _formatDate(DateTime dateTime) {
  return '${dateTime.month.toString().padLeft(2, '0')}/'
      '${dateTime.day.toString().padLeft(2, '0')}/'
      '${dateTime.year}';
}

String _sanitizeProfileId(String id) {
  final slug = id
      .toLowerCase()
      .replaceAll(RegExp('[^a-z0-9]+'), '_')
      .replaceAll(RegExp(r'^_+|_+$'), '');
  return slug.isEmpty ? 'profile' : slug;
}
