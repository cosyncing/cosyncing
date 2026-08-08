import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

typedef _TransferSelectionChanged =
    void Function(String id, {required bool selected});

/// App-level view over the artifact transfer ledger.
///
/// See `docs/architecture/client-ui.md`.
class TransferManagerPage extends ConsumerStatefulWidget {
  /// Creates a [TransferManagerPage].
  const TransferManagerPage({this.showSessionsBack = false, super.key});

  /// Shows contextual navigation back to the wide Sessions workspace.
  final bool showSessionsBack;

  @override
  ConsumerState<TransferManagerPage> createState() =>
      _TransferManagerPageState();
}

class _TransferManagerPageState extends ConsumerState<TransferManagerPage> {
  _TransferLifecycleFilter _selectedFilter = _TransferLifecycleFilter.all;
  _TransferSortMode _selectedSortMode = _TransferSortMode.newest;
  final _searchController = TextEditingController();
  final _searchFocusNode = FocusNode();
  String _searchQuery = '';
  final Set<String> _selectedTransferIds = <String>{};

  void _clearSearchQuery() {
    _searchController.clear();
    setState(() {
      _searchQuery = '';
    });
  }

  void _onTransferSelectionChanged(String id, {required bool selected}) {
    setState(() {
      if (selected) {
        _selectedTransferIds.add(id);
      } else {
        _selectedTransferIds.remove(id);
      }
    });
  }

  void _clearTransferSelection() {
    setState(_selectedTransferIds.clear);
  }

  void _selectAllVisibleTransfers(
    BuildContext context,
    List<SessionArtifactTransfer> visibleTransfers,
  ) {
    if (visibleTransfers.isEmpty) {
      return;
    }
    final visibleIds = visibleTransfers.map((transfer) => transfer.id).toSet();
    setState(() {
      _selectedTransferIds.addAll(visibleIds);
    });

    if (!context.mounted) {
      return;
    }
    _showTransferManagerSnackBar(
      context,
      AppLocalizations.of(
        context,
      ).transferSelectedVisible(visibleTransfers.length),
    );
  }

  void _shortcutSelectAllVisibleTransfers(
    BuildContext context,
    List<SessionArtifactTransfer> visibleTransfers,
  ) {
    if (_searchFocusNode.hasFocus) {
      return;
    }
    _selectAllVisibleTransfers(context, visibleTransfers);
  }

  void _invertVisibleTransferSelection(
    BuildContext context,
    List<SessionArtifactTransfer> visibleTransfers,
  ) {
    if (visibleTransfers.isEmpty) {
      return;
    }
    setState(() {
      for (final transfer in visibleTransfers) {
        if (_selectedTransferIds.contains(transfer.id)) {
          _selectedTransferIds.remove(transfer.id);
        } else {
          _selectedTransferIds.add(transfer.id);
        }
      }
    });

    if (!context.mounted) {
      return;
    }
    _showTransferManagerSnackBar(
      context,
      AppLocalizations.of(
        context,
      ).transferInvertedVisible(visibleTransfers.length),
    );
  }

  void _shortcutInvertVisibleTransferSelection(
    BuildContext context,
    List<SessionArtifactTransfer> visibleTransfers,
  ) {
    if (_searchFocusNode.hasFocus) {
      return;
    }
    _invertVisibleTransferSelection(context, visibleTransfers);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final transfers = ref.watch(sessionArtifactTransferControllerProvider);
    // The EXACT broker scope key (`RosterSource.storageKey`), not the bare
    // profile id: rows remain listed for cleanup regardless of owner, but
    // retry/resume actions send network traffic and are only offered for
    // rows this exact broker stamped. The worker enforces the same boundary.
    final activeBrokerProfileId = ref.watch(
      activeBrokerProfileProvider.select(
        (profile) => RosterSource.of(profile)?.storageKey,
      ),
    );
    final hasActiveBrokerClient = ref
        .watch(brokerClientProvider)
        .maybeWhen(data: (client) => client != null, orElse: () => false);
    final trimmedSearchQuery = _searchQuery.trim();
    final searchedTransfers = trimmedSearchQuery.isEmpty
        ? transfers
        : transfers
              .where(
                (transfer) => _matchesSearchQuery(transfer, trimmedSearchQuery),
              )
              .toList();
    final hasTerminalTransfers = transfers.any(_isTerminalTransfer);
    final filterCounts = _countTransfersByFilter(searchedTransfers);
    final filteredTransfers = _sortTransfers(
      searchedTransfers
          .where((transfer) => _matchesFilter(transfer.status, _selectedFilter))
          .toList(),
      _selectedSortMode,
    );
    final visibleSelectedTransfers = filteredTransfers
        .where((transfer) => _selectedTransferIds.contains(transfer.id))
        .toList();
    final visibleRetryableSelectedTransfers = visibleSelectedTransfers
        .where(
          (transfer) =>
              _isRetryableTransfer(transfer) &&
              _isOwnedByActiveProfile(transfer, activeBrokerProfileId),
        )
        .toList();
    final visibleCancelableSelectedTransfers = visibleSelectedTransfers
        .where(_isCancelableTransfer)
        .toList();
    final hasVisibleSelectedTransfers = visibleSelectedTransfers.isNotEmpty;

    return CallbackShortcuts(
      // See `docs/architecture/client-ui.md` and
      // `docs/architecture/client-ui.md`.
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyA, control: true): () =>
            _shortcutSelectAllVisibleTransfers(context, filteredTransfers),
        const SingleActivator(LogicalKeyboardKey.keyA, meta: true): () =>
            _shortcutSelectAllVisibleTransfers(context, filteredTransfers),
        const SingleActivator(LogicalKeyboardKey.keyI, control: true): () =>
            _shortcutInvertVisibleTransferSelection(context, filteredTransfers),
        const SingleActivator(LogicalKeyboardKey.keyI, meta: true): () =>
            _shortcutInvertVisibleTransferSelection(context, filteredTransfers),
        const SingleActivator(LogicalKeyboardKey.escape): () {
          if (_searchQuery.trim().isNotEmpty) {
            _clearSearchQuery();
            return;
          }
          _clearTransferSelection();
        },
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          appBar: AppBar(
            leading: widget.showSessionsBack
                ? IconButton(
                    key: const Key('transfers-back-to-sessions'),
                    tooltip: l10n.backToSessions,
                    onPressed: () => context.go(sessionsRoute),
                    icon: const Icon(Icons.arrow_back),
                  )
                : null,
            title: Text(l10n.transfersTitle),
            actions: [
              if (hasTerminalTransfers)
                IconButton(
                  key: const ValueKey(
                    'transfer-manager-clear-terminal-transfers',
                  ),
                  tooltip: l10n.transferClearFinishedTooltip,
                  onPressed: () => ref
                      .read(sessionArtifactTransferControllerProvider.notifier)
                      .clearTerminalTransfers(),
                  icon: const Icon(Icons.delete_sweep_outlined),
                ),
            ],
          ),
          body: SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                  child: Column(
                    children: [
                      _TransferSearchField(
                        controller: _searchController,
                        focusNode: _searchFocusNode,
                        query: _searchQuery,
                        onQueryChanged: (query) {
                          setState(() {
                            _searchQuery = query;
                          });
                        },
                        onClearSearch: _clearSearchQuery,
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          // See `docs/architecture/client-ui.md`.
                          _TransferFilters(
                            countsByFilter: filterCounts,
                            selectedFilter: _selectedFilter,
                            onFilterChanged: (filter) {
                              setState(() {
                                _selectedFilter = filter;
                              });
                            },
                          ),
                          _TransferSortControl(
                            selectedSortMode: _selectedSortMode,
                            onSortModeChanged: (sortMode) {
                              setState(() {
                                _selectedSortMode = sortMode;
                              });
                            },
                          ),
                          if (filteredTransfers.isNotEmpty) ...[
                            TextButton(
                              key: const ValueKey(
                                'transfer-manager-select-all-visible',
                              ),
                              onPressed: () => _selectAllVisibleTransfers(
                                context,
                                filteredTransfers,
                              ),
                              child: Text(l10n.transferSelectAllVisible),
                            ),
                            TextButton(
                              key: const ValueKey(
                                'transfer-manager-invert-visible-selection',
                              ),
                              onPressed: () => _invertVisibleTransferSelection(
                                context,
                                filteredTransfers,
                              ),
                              child: Text(l10n.transferInvertVisibleSelection),
                            ),
                          ],
                        ],
                      ),
                      // See `docs/architecture/client-ui.md`.
                      if (hasVisibleSelectedTransfers)
                        _TransferSelectionBar(
                          key: const ValueKey(
                            'transfer-manager-selection-summary',
                          ),
                          visibleSelectedCount: visibleSelectedTransfers.length,
                          onRetrySelectedTransfers: () =>
                              _retrySelectedTransfers(
                                context,
                                visibleSelectedTransfers:
                                    visibleRetryableSelectedTransfers,
                                hasActiveBrokerClient: hasActiveBrokerClient,
                              ),
                          onCancelSelectedTransfers: () =>
                              _cancelSelectedTransfers(
                                context,
                                visibleSelectedTransfers:
                                    visibleCancelableSelectedTransfers,
                              ),
                          visibleRetryableSelectedCount:
                              visibleRetryableSelectedTransfers.length,
                          visibleCancelableSelectedCount:
                              visibleCancelableSelectedTransfers.length,
                          onClearSelection: _clearTransferSelection,
                          onCopySelectedPaths: () =>
                              _copySelectedTransferLocalPaths(
                                context,
                                visibleSelectedTransfers,
                              ),
                        ),
                    ],
                  ),
                ),
                Expanded(
                  child: filteredTransfers.isEmpty
                      ? Center(
                          child: SelectionArea(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  _emptyMessageForFilter(
                                    l10n,
                                    _selectedFilter,
                                    trimmedSearchQuery,
                                  ),
                                  style: Theme.of(
                                    context,
                                  ).textTheme.titleMedium,
                                ),
                                // Only the unfiltered, unsearched case explains
                                // transfers; filtered variants refine the list.
                                if (_selectedFilter ==
                                        _TransferLifecycleFilter.all &&
                                    trimmedSearchQuery.isEmpty) ...[
                                  const SizedBox(height: 8),
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 32,
                                    ),
                                    child: Text(
                                      l10n.transfersEmptyBody,
                                      textAlign: TextAlign.center,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodyMedium
                                          ?.copyWith(
                                            color: Theme.of(
                                              context,
                                            ).colorScheme.onSurfaceVariant,
                                          ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        )
                      : _TransferGroupList(
                          transfers: filteredTransfers,
                          activeBrokerProfileId: activeBrokerProfileId,
                          hasActiveBrokerClient: hasActiveBrokerClient,
                          selectedTransferIds: _selectedTransferIds,
                          onSelectionChanged: _onTransferSelectionChanged,
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocusNode.dispose();
    super.dispose();
  }

  void _retrySelectedTransfers(
    BuildContext context, {
    required List<SessionArtifactTransfer> visibleSelectedTransfers,
    required bool hasActiveBrokerClient,
  }) {
    final transferIds = visibleSelectedTransfers
        .map((transfer) => transfer.id)
        .toList();
    if (transferIds.isEmpty) {
      if (!context.mounted) {
        return;
      }
      _showTransferManagerSnackBar(
        context,
        AppLocalizations.of(context).transferNoSelectedRetryable,
      );
      return;
    }

    final worker = ref.read(sessionArtifactTransferWorkerProvider);
    for (final transferId in transferIds) {
      unawaited(
        worker.retryTransfer(
          transferId,
          hasActiveBrokerClient: hasActiveBrokerClient,
        ),
      );
    }

    if (!context.mounted) {
      return;
    }
    _showTransferManagerSnackBar(
      context,
      AppLocalizations.of(context).transferRetryingCount(transferIds.length),
    );
  }

  void _cancelSelectedTransfers(
    BuildContext context, {
    required List<SessionArtifactTransfer> visibleSelectedTransfers,
  }) {
    final transferIds = visibleSelectedTransfers
        .map((transfer) => transfer.id)
        .toList();
    if (transferIds.isEmpty) {
      if (!context.mounted) {
        return;
      }
      _showTransferManagerSnackBar(
        context,
        AppLocalizations.of(context).transferNoSelectedCancelable,
      );
      return;
    }

    final worker = ref.read(sessionArtifactTransferWorkerProvider);
    for (final transferId in transferIds) {
      worker.cancelTransfer(transferId);
    }

    if (!context.mounted) {
      return;
    }
    _showTransferManagerSnackBar(
      context,
      AppLocalizations.of(context).transferCancelingCount(transferIds.length),
    );
  }
}

class _TransferSelectionBar extends StatelessWidget {
  const _TransferSelectionBar({
    required this.visibleSelectedCount,
    required this.onRetrySelectedTransfers,
    required this.onCancelSelectedTransfers,
    required this.visibleRetryableSelectedCount,
    required this.visibleCancelableSelectedCount,
    required this.onClearSelection,
    required this.onCopySelectedPaths,
    super.key,
  });

  final int visibleSelectedCount;
  final VoidCallback onRetrySelectedTransfers;
  final VoidCallback onCancelSelectedTransfers;
  final int visibleRetryableSelectedCount;
  final int visibleCancelableSelectedCount;
  final VoidCallback onClearSelection;
  final Future<void> Function() onCopySelectedPaths;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          SelectableText(
            l10n.transferSelectedVisible(visibleSelectedCount),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          TextButton(
            key: const ValueKey('transfer-manager-selection-clear'),
            onPressed: onClearSelection,
            child: Text(l10n.clear),
          ),
          ElevatedButton(
            key: const ValueKey('transfer-manager-retry-selected'),
            onPressed: onRetrySelectedTransfers,
            child: Text(
              l10n.transferRetrySelected(visibleRetryableSelectedCount),
            ),
          ),
          ElevatedButton(
            key: const ValueKey('transfer-manager-cancel-selected'),
            onPressed: onCancelSelectedTransfers,
            child: Text(
              l10n.transferCancelSelected(visibleCancelableSelectedCount),
            ),
          ),
          ElevatedButton(
            key: const ValueKey('transfer-manager-copy-selected-paths'),
            onPressed: onCopySelectedPaths,
            child: Text(l10n.transferCopySelectedPaths),
          ),
        ],
      ),
    );
  }
}

enum _TransferLifecycleFilter { all, active, finished, failed }

enum _TransferSortMode { newest, oldest, file, status }

String _transferSortLabel(AppLocalizations l10n, _TransferSortMode mode) =>
    switch (mode) {
      _TransferSortMode.newest => l10n.transferSortNewest,
      _TransferSortMode.oldest => l10n.transferSortOldest,
      _TransferSortMode.file => l10n.transferSortFile,
      _TransferSortMode.status => l10n.transferSortStatus,
    };

extension _TransferSortModeX on _TransferSortMode {
  String get optionKey => switch (this) {
    _TransferSortMode.newest => 'newest',
    _TransferSortMode.oldest => 'oldest',
    _TransferSortMode.file => 'file',
    _TransferSortMode.status => 'status',
  };
}

class _TransferSortControl extends StatelessWidget {
  const _TransferSortControl({
    required this.selectedSortMode,
    required this.onSortModeChanged,
  });

  final _TransferSortMode selectedSortMode;
  final ValueChanged<_TransferSortMode> onSortModeChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return DropdownButton<_TransferSortMode>(
      // See `docs/architecture/client-ui.md`.
      key: const ValueKey('transfer-manager-sort-control'),
      value: selectedSortMode,
      isDense: true,
      onChanged: (value) {
        if (value == null) {
          return;
        }
        onSortModeChanged(value);
      },
      items: [
        for (final mode in _TransferSortMode.values)
          DropdownMenuItem(
            value: mode,
            key: ValueKey('transfer-manager-sort-${mode.optionKey}'),
            child: Text(_transferSortLabel(l10n, mode)),
          ),
      ],
    );
  }
}

class _TransferSearchField extends StatelessWidget {
  const _TransferSearchField({
    required this.controller,
    required this.focusNode,
    required this.query,
    required this.onQueryChanged,
    required this.onClearSearch,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final String query;
  final void Function(String query) onQueryChanged;
  final VoidCallback onClearSearch;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return TextField(
      // See docs/architecture/client-ui.md
      key: const ValueKey('transfer-manager-search-field'),
      controller: controller,
      focusNode: focusNode,
      onChanged: onQueryChanged,
      decoration: InputDecoration(
        hintText: l10n.transferSearchLabel,
        labelText: l10n.transferSearchLabel,
        prefixIcon: const Icon(Icons.search),
        border: const OutlineInputBorder(),
        suffixIcon: query.trim().isEmpty
            ? null
            : IconButton(
                key: const ValueKey('transfer-manager-search-clear'),
                tooltip: l10n.clearSearch,
                icon: const Icon(Icons.clear),
                onPressed: onClearSearch,
              ),
      ),
    );
  }
}

class _TransferFilters extends StatelessWidget {
  const _TransferFilters({
    required this.countsByFilter,
    required this.selectedFilter,
    required this.onFilterChanged,
  });

  final Map<_TransferLifecycleFilter, int> countsByFilter;
  final _TransferLifecycleFilter selectedFilter;
  final void Function(_TransferLifecycleFilter filter) onFilterChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final filter in _TransferLifecycleFilter.values)
          ChoiceChip(
            key: ValueKey('transfer-filter-${filter.name}'),
            label: Text(
              '${_transferFilterLabel(l10n, filter)} '
              '(${countsByFilter[filter] ?? 0})',
            ),
            selected: filter == selectedFilter,
            onSelected: (_) => onFilterChanged(filter),
          ),
      ],
    );
  }
}

String _transferFilterLabel(
  AppLocalizations l10n,
  _TransferLifecycleFilter filter,
) => switch (filter) {
  _TransferLifecycleFilter.all => l10n.transferFilterAll,
  _TransferLifecycleFilter.active => l10n.transferFilterActive,
  _TransferLifecycleFilter.finished => l10n.transferFilterFinished,
  _TransferLifecycleFilter.failed => l10n.transferFilterFailed,
};

class _TransferGroupList extends ConsumerWidget {
  const _TransferGroupList({
    required this.transfers,
    required this.activeBrokerProfileId,
    required this.hasActiveBrokerClient,
    required this.selectedTransferIds,
    required this.onSelectionChanged,
  });

  final List<SessionArtifactTransfer> transfers;
  final String? activeBrokerProfileId;
  final bool hasActiveBrokerClient;
  final Set<String> selectedTransferIds;
  final _TransferSelectionChanged onSelectionChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final groups = _groupTransfers(transfers);

    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: groups.length,
      separatorBuilder: (context, index) => const SizedBox(height: 16),
      itemBuilder: (context, index) {
        final entry = groups.entries.elementAt(index);
        return _TransferSessionGroup(
          sessionKey: entry.key,
          transfers: entry.value,
          activeBrokerProfileId: activeBrokerProfileId,
          hasActiveBrokerClient: hasActiveBrokerClient,
          selectedTransferIds: selectedTransferIds,
          onSelectionChanged: onSelectionChanged,
          onRetryTransfer: (id) async {
            await ref
                .read(sessionArtifactTransferWorkerProvider)
                .retryTransfer(
                  id,
                  hasActiveBrokerClient: hasActiveBrokerClient,
                );
          },
          onCancelTransfer: (id) {
            ref.read(sessionArtifactTransferWorkerProvider).cancelTransfer(id);
          },
          onSelectFileToResumeUpload: (id) async {
            final result = await ref
                .read(sessionArtifactTransferWorkerProvider)
                .selectFileToResumeUpload(transferId: id);
            if (!context.mounted) {
              return;
            }
            final l10n = AppLocalizations.of(context);
            _showTransferManagerSnackBar(context, switch (result.outcome) {
              SessionArtifactTransferWorkerOutcome.canceled =>
                l10n.transferResumeCanceled,
              SessionArtifactTransferWorkerOutcome.failed =>
                l10n.transferResumeFailed,
              _ => l10n.transferResumeStarted,
            });
          },
        );
      },
    );
  }
}

class _TransferSessionGroup extends StatelessWidget {
  const _TransferSessionGroup({
    required this.sessionKey,
    required this.transfers,
    required this.activeBrokerProfileId,
    required this.hasActiveBrokerClient,
    required this.onRetryTransfer,
    required this.onCancelTransfer,
    required this.onSelectFileToResumeUpload,
    required this.selectedTransferIds,
    required this.onSelectionChanged,
  });

  final SessionDetailKey sessionKey;
  final List<SessionArtifactTransfer> transfers;
  final String? activeBrokerProfileId;
  final bool hasActiveBrokerClient;
  final Future<void> Function(String id) onRetryTransfer;
  final void Function(String id) onCancelTransfer;
  final Future<void> Function(String id) onSelectFileToResumeUpload;
  final Set<String> selectedTransferIds;
  final _TransferSelectionChanged onSelectionChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          '${sessionKey.tool} / ${sessionKey.sessionId}',
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        DecoratedBox(
          decoration: BoxDecoration(
            border: Border.all(color: theme.colorScheme.outlineVariant),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            children: [
              for (var index = 0; index < transfers.length; index++) ...[
                if (index > 0) const Divider(height: 1),
                _TransferRow(
                  transfer: transfers[index],
                  isOwningBrokerProfile: _isOwnedByActiveProfile(
                    transfers[index],
                    activeBrokerProfileId,
                  ),
                  hasActiveBrokerClient: hasActiveBrokerClient,
                  isSelected: selectedTransferIds.contains(transfers[index].id),
                  onSelectionChanged: onSelectionChanged,
                  onRetryTransfer: onRetryTransfer,
                  onCancelTransfer: onCancelTransfer,
                  onSelectFileToResumeUpload: onSelectFileToResumeUpload,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _TransferRow extends ConsumerWidget {
  const _TransferRow({
    required this.transfer,
    required this.isOwningBrokerProfile,
    required this.hasActiveBrokerClient,
    required this.isSelected,
    required this.onSelectionChanged,
    required this.onRetryTransfer,
    required this.onCancelTransfer,
    required this.onSelectFileToResumeUpload,
  });

  final SessionArtifactTransfer transfer;
  final bool isOwningBrokerProfile;
  final bool hasActiveBrokerClient;
  final bool isSelected;
  final _TransferSelectionChanged onSelectionChanged;
  final Future<void> Function(String id) onRetryTransfer;
  final void Function(String id) onCancelTransfer;
  final Future<void> Function(String id) onSelectFileToResumeUpload;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final localTransferFileOpener = ref.read(localTransferFileOpenerProvider);
    final canRetry = isOwningBrokerProfile && _isRetryableTransfer(transfer);
    final canCancel = _isCancelableTransfer(transfer);
    final isFailed = transfer.status == SessionArtifactTransferStatus.failed;
    final localPath = _transferLocalPath(transfer);
    final localPathLabel = _transferLocalPathLabel(l10n, transfer, localPath);
    final progressLabel = _transferProgressLabel(l10n, transfer);
    final primaryDetail = _transferDetailLabel(l10n, transfer);
    final detailLabel = progressLabel.isEmpty
        ? '${_transferStatusLabel(l10n, transfer.status)} - $primaryDetail'
        : '${_transferStatusLabel(l10n, transfer.status)} - $primaryDetail - '
              '$progressLabel';

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 48,
            child: Checkbox(
              key: ValueKey('transfer-manager-select-${transfer.id}'),
              value: isSelected,
              onChanged: (value) {
                if (value == null) {
                  return;
                }
                onSelectionChanged(transfer.id, selected: value);
              },
            ),
          ),
          _TransferStatusIcon(status: transfer.status),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${_transferDirectionLabel(l10n, transfer.direction)}: '
                  '${transfer.fileName}',
                  style: theme.textTheme.bodyMedium,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  detailLabel,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: isFailed
                        ? theme.colorScheme.error
                        : theme.colorScheme.onSurfaceVariant,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (localPathLabel != null) ...[
                  const SizedBox(height: 4),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Text(
                          localPathLabel,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 6),
                      IconButton(
                        key: ValueKey('transfer-manager-copy-${transfer.id}'),
                        tooltip: l10n.copyPath,
                        icon: const Icon(Icons.content_copy, size: 18),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(
                          minWidth: 48,
                          minHeight: 48,
                        ),
                        onPressed: () =>
                            _copyTransferLocalPath(context, localPath),
                      ),
                      IconButton(
                        key: ValueKey('transfer-manager-open-${transfer.id}'),
                        tooltip: l10n.openFile,
                        icon: const Icon(Icons.open_in_new, size: 18),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(
                          minWidth: 48,
                          minHeight: 48,
                        ),
                        onPressed: () => _openTransferLocalPath(
                          context,
                          localTransferFileOpener,
                          localPath!,
                        ),
                      ),
                      IconButton(
                        key: ValueKey('transfer-manager-reveal-${transfer.id}'),
                        tooltip: l10n.revealInFolder,
                        icon: const Icon(Icons.folder_open_outlined, size: 18),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(
                          minWidth: 48,
                          minHeight: 48,
                        ),
                        // See docs/architecture/client-ui.md
                        onPressed: () => _revealTransferLocalPath(
                          context,
                          localTransferFileOpener,
                          localPath!,
                        ),
                      ),
                      IconButton(
                        key: ValueKey(
                          'transfer-manager-preview-${transfer.id}',
                        ),
                        tooltip: l10n.previewText,
                        icon: const Icon(Icons.text_snippet_outlined, size: 18),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(
                          minWidth: 48,
                          minHeight: 48,
                        ),
                        onPressed: () => _previewTransferLocalText(
                          context,
                          localTransferFileOpener,
                          localPath!,
                          transfer,
                        ),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 2),
                if (transfer.canSelectFileToResumeUpload &&
                    isOwningBrokerProfile) ...[
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      const SizedBox(width: 8),
                      Semantics(
                        label: l10n.transferResumeSelectFile,
                        enabled: hasActiveBrokerClient,
                        hint: hasActiveBrokerClient
                            ? l10n.transferResumeSelectHint
                            : l10n.transferResumeConnectHint,
                        button: true,
                        child: Tooltip(
                          message: hasActiveBrokerClient
                              ? l10n.transferResumeSelectFile
                              : l10n.transferResumeConnectHint,
                          child: TextButton(
                            key: ValueKey(
                              'transfer-manager-select-file-to-resume-'
                              '${transfer.id}',
                            ),
                            onPressed: hasActiveBrokerClient
                                ? () => onSelectFileToResumeUpload(transfer.id)
                                : null,
                            child: Text(l10n.transferResumeSelectFile),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                ],
                IconButton(
                  key: ValueKey('transfer-manager-open-session-${transfer.id}'),
                  tooltip: l10n.openSession,
                  icon: const Icon(Icons.terminal_outlined, size: 18),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    minHeight: 48,
                  ),
                  onPressed: isOwningBrokerProfile
                      ? () => _openTransferSession(context, transfer)
                      : null,
                ),
                IconButton(
                  key: ValueKey('transfer-manager-details-${transfer.id}'),
                  tooltip: l10n.transferDetails,
                  icon: const Icon(Icons.info_outline, size: 18),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 48,
                    minHeight: 48,
                  ),
                  onPressed: () => _showTransferDetails(
                    context,
                    transfer,
                    localTransferFileOpener,
                    isOwningBrokerProfile: isOwningBrokerProfile,
                  ),
                ),
              ],
            ),
          ),
          if (canRetry) ...[
            const SizedBox(width: 8),
            TextButton(
              key: ValueKey('transfer-manager-retry-${transfer.id}'),
              onPressed: () => onRetryTransfer(transfer.id),
              child: Text(l10n.retry),
            ),
          ],
          if (canCancel) ...[
            const SizedBox(width: 8),
            TextButton(
              key: ValueKey('transfer-manager-cancel-${transfer.id}'),
              onPressed: () => onCancelTransfer(transfer.id),
              child: Text(l10n.cancel),
            ),
          ],
        ],
      ),
    );
  }
}

bool _isRetryableTransfer(SessionArtifactTransfer transfer) =>
    transfer.direction != SessionArtifactTransferDirection.upload &&
    (transfer.status == SessionArtifactTransferStatus.queued ||
        transfer.status == SessionArtifactTransferStatus.failed ||
        transfer.status == SessionArtifactTransferStatus.canceled);

/// Whether the row was stamped by the exact active broker.
///
/// Both sides carry `RosterSource.storageKey`, so a row from the same profile
/// at a retired endpoint — or a legacy bare-id row — offers no retry here and
/// would be refused by the worker regardless.
bool _isOwnedByActiveProfile(
  SessionArtifactTransfer transfer,
  String? activeBrokerProfileId,
) =>
    activeBrokerProfileId != null &&
    transfer.brokerProfileId != null &&
    transfer.brokerProfileId == activeBrokerProfileId;

bool _isCancelableTransfer(SessionArtifactTransfer transfer) =>
    transfer.direction != SessionArtifactTransferDirection.upload &&
    (transfer.status == SessionArtifactTransferStatus.queued ||
        transfer.status == SessionArtifactTransferStatus.running ||
        transfer.status == SessionArtifactTransferStatus.cached);

Future<void> _showTransferDetails(
  BuildContext context,
  SessionArtifactTransfer transfer,
  LocalTransferFileOpener localTransferFileOpener, {
  required bool isOwningBrokerProfile,
}) async {
  final l10n = AppLocalizations.of(context);
  final localPath = _transferLocalPath(transfer);
  final progressLabel = _transferProgressLabel(l10n, transfer);
  final sourceUrl = _trimmedText(transfer.sourceUrl);
  final exportedPath = _trimmedText(transfer.exportedPath);
  final cachedPath = _trimmedText(transfer.cachedFilePath);
  final createdAtText = transfer.createdAt.toUtc().toIso8601String();
  final updatedAtText = transfer.updatedAt.toUtc().toIso8601String();

  await showDialog<void>(
    context: context,
    builder: (dialogContext) {
      return AlertDialog(
        title: Text(
          l10n.transferDetailsTitle(transfer.fileName),
          key: ValueKey('transfer-manager-details-title-${transfer.id}'),
        ),
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                SelectionArea(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _TransferDetailsRow(
                        label: l10n.direction,
                        value: _transferDirectionLabel(
                          l10n,
                          transfer.direction,
                        ),
                      ),
                      _TransferDetailsRow(
                        label: l10n.status,
                        value: _transferStatusLabel(l10n, transfer.status),
                      ),
                      if (progressLabel.isNotEmpty)
                        _TransferDetailsRow(
                          label: l10n.progress,
                          value: progressLabel,
                        ),
                      _TransferDetailsRow(
                        label: l10n.tool,
                        value: transfer.sessionKey.tool,
                      ),
                      _TransferDetailsRow(
                        label: l10n.sessionId,
                        value: transfer.sessionKey.sessionId,
                      ),
                      _TransferDetailsRow(
                        label: l10n.brokerProfile,
                        value:
                            transfer.brokerProfileId ??
                            l10n.legacyUnscopedTransfer,
                      ),
                      _TransferDetailsRow(
                        label: l10n.transferId,
                        value: transfer.id,
                      ),
                      _TransferDetailsRow(
                        label: l10n.actionKey,
                        value: transfer.actionKey,
                      ),
                      if (sourceUrl != null)
                        _TransferDetailsRow(
                          label: l10n.sourceUrl,
                          value: sourceUrl,
                        ),
                      if (exportedPath != null)
                        _TransferDetailsRow(
                          label: l10n.exportedPath,
                          value: exportedPath,
                        ),
                      if (cachedPath != null)
                        _TransferDetailsRow(
                          label: l10n.cachedPath,
                          value: cachedPath,
                        ),
                      _TransferDetailsRow(
                        label: l10n.created,
                        value: createdAtText,
                      ),
                      _TransferDetailsRow(
                        label: l10n.updated,
                        value: updatedAtText,
                      ),
                      if (transfer.message.trim().isNotEmpty ||
                          (transfer.error?.trim().isNotEmpty ?? false))
                        ExpansionTile(
                          tilePadding: EdgeInsets.zero,
                          title: Text(l10n.technicalDetails),
                          children: [
                            if (transfer.message.trim().isNotEmpty)
                              _TransferDetailsRow(
                                label: l10n.message,
                                value: transfer.message,
                              ),
                            if (transfer.error?.trim().isNotEmpty ?? false)
                              _TransferDetailsRow(
                                label: l10n.errorLabel,
                                value: transfer.error!,
                              ),
                          ],
                        ),
                    ],
                  ),
                ),
                IconButton(
                  key: ValueKey(
                    'transfer-manager-details-open-session-${transfer.id}',
                  ),
                  tooltip: l10n.openSession,
                  icon: const Icon(Icons.terminal_outlined),
                  onPressed: isOwningBrokerProfile
                      ? () {
                          Navigator.of(dialogContext).pop();
                          WidgetsBinding.instance.addPostFrameCallback((_) {
                            if (context.mounted) {
                              _openTransferSession(context, transfer);
                            }
                          });
                        }
                      : null,
                  padding: const EdgeInsets.all(8),
                ),
                if (localPath != null) ...[
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      IconButton(
                        key: ValueKey(
                          'transfer-manager-details-copy-${transfer.id}',
                        ),
                        tooltip: l10n.copyPath,
                        icon: const Icon(Icons.content_copy),
                        onPressed: () =>
                            _copyTransferLocalPath(context, localPath),
                        padding: const EdgeInsets.all(8),
                      ),
                      IconButton(
                        key: ValueKey(
                          'transfer-manager-details-open-${transfer.id}',
                        ),
                        tooltip: l10n.openFile,
                        icon: const Icon(Icons.open_in_new),
                        onPressed: () => _openTransferLocalPath(
                          context,
                          localTransferFileOpener,
                          localPath,
                        ),
                        padding: const EdgeInsets.all(8),
                      ),
                      IconButton(
                        key: ValueKey(
                          'transfer-manager-details-reveal-${transfer.id}',
                        ),
                        tooltip: l10n.revealInFolder,
                        icon: const Icon(Icons.folder_open_outlined),
                        onPressed: () => _revealTransferLocalPath(
                          context,
                          localTransferFileOpener,
                          localPath,
                        ),
                        padding: const EdgeInsets.all(8),
                      ),
                      IconButton(
                        key: ValueKey(
                          'transfer-manager-details-preview-${transfer.id}',
                        ),
                        tooltip: l10n.previewText,
                        icon: const Icon(Icons.text_snippet_outlined),
                        onPressed: () => _previewTransferLocalText(
                          context,
                          localTransferFileOpener,
                          localPath,
                          transfer,
                        ),
                        padding: const EdgeInsets.all(8),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(l10n.close),
          ),
        ],
      );
    },
  );
}

void _openTransferSession(
  BuildContext context,
  SessionArtifactTransfer transfer,
) {
  // See `docs/architecture/client-ui.md`.
  final location = sessionDetailLocation(
    tool: transfer.sessionKey.tool,
    sessionId: transfer.sessionKey.sessionId,
  );
  context.go(location);
}

Future<void> _copySelectedTransferLocalPaths(
  BuildContext context,
  List<SessionArtifactTransfer> visibleSelectedTransfers,
) async {
  final localPaths = <String>[];
  for (final transfer in visibleSelectedTransfers) {
    final localPath = _transferLocalPath(transfer);
    if (localPath != null) {
      localPaths.add(localPath);
    }
  }

  if (localPaths.isEmpty) {
    if (!context.mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          AppLocalizations.of(context).transferNoSelectedLocalPaths,
        ),
      ),
    );
    return;
  }

  await Clipboard.setData(ClipboardData(text: localPaths.join('\n')));
  if (!context.mounted) {
    return;
  }

  // See `docs/architecture/client-ui.md`.
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(
        AppLocalizations.of(context).transferCopiedPaths(localPaths.length),
      ),
    ),
  );
}

void _showTransferManagerSnackBar(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

Future<void> _copyTransferLocalPath(
  BuildContext context,
  String? localPath,
) async {
  final path = localPath;
  if (path == null) {
    return;
  }
  await Clipboard.setData(ClipboardData(text: path));
  if (!context.mounted) {
    return;
  }
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(AppLocalizations.of(context).transferPathCopied)),
  );
}

Future<void> _openTransferLocalPath(
  BuildContext context,
  LocalTransferFileOpener localTransferFileOpener,
  String localPath,
) async {
  final l10n = AppLocalizations.of(context);
  final result = await localTransferFileOpener.openFile(localPath);
  if (!context.mounted) {
    return;
  }

  if (result.isSuccess) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(l10n.transferOpenedFile)));
    return;
  }

  final message = result.isUnsupported
      ? l10n.transferOpenUnsupported
      : l10n.transferOpenFailed;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

Future<void> _revealTransferLocalPath(
  BuildContext context,
  LocalTransferFileOpener localTransferFileOpener,
  String localPath,
) async {
  final l10n = AppLocalizations.of(context);
  final result = await localTransferFileOpener.revealInFolder(localPath);
  if (!context.mounted) {
    return;
  }

  if (result.isSuccess) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(l10n.transferRevealedInFolder)));
    return;
  }

  final message = result.isUnsupported
      ? l10n.transferRevealUnsupported
      : l10n.transferRevealFailed;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

Future<void> _previewTransferLocalText(
  BuildContext context,
  LocalTransferFileOpener localTransferFileOpener,
  String localPath,
  SessionArtifactTransfer transfer,
) async {
  final l10n = AppLocalizations.of(context);
  final result = await localTransferFileOpener.previewTextFile(localPath);
  if (!context.mounted) {
    return;
  }

  if (result.isSuccess) {
    await _showTextPreviewDialog(context, transfer, localPath, result);
    return;
  }

  final message = switch ((
    result.isUnsupported,
    result.isBinary,
    result.isFailure,
  )) {
    (true, _, _) => l10n.transferPreviewUnsupported,
    (_, true, _) => l10n.transferPreviewBinary,
    (_, _, true) => l10n.transferPreviewFailed,
    _ => l10n.transferPreviewUnavailable,
  };
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

Future<void> _showTextPreviewDialog(
  BuildContext context,
  SessionArtifactTransfer transfer,
  String localPath,
  LocalTransferTextPreviewResult result,
) async {
  final l10n = AppLocalizations.of(context);
  await showDialog<void>(
    context: context,
    builder: (context) {
      return AlertDialog(
        title: Text(
          l10n.transferPreviewTitle(transfer.fileName),
          key: ValueKey('transfer-manager-preview-title-${transfer.id}'),
        ),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: SelectionArea(
              child: DefaultTextStyle(
                style: Theme.of(context).textTheme.bodySmall!,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '${l10n.fileNameLabel}: ${transfer.fileName}',
                      key: ValueKey(
                        'transfer-manager-preview-filename-${transfer.id}',
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '${l10n.pathLabel}: $localPath',
                      key: ValueKey(
                        'transfer-manager-preview-path-${transfer.id}',
                      ),
                    ),
                    const SizedBox(height: 8),
                    SelectableText(
                      result.content,
                      key: ValueKey(
                        'transfer-manager-preview-content-${transfer.id}',
                      ),
                      style: const TextStyle(fontFamily: 'monospace'),
                    ),
                    if (result.isTruncated) ...[
                      const SizedBox(height: 8),
                      Text(
                        l10n.transferPreviewTruncated,
                        key: ValueKey(
                          'transfer-manager-preview-truncated-${transfer.id}',
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(l10n.close),
          ),
        ],
      );
    },
  );
}

String? _trimmedText(String? value) {
  final text = value?.trim();
  if (text == null || text.isEmpty) {
    return null;
  }
  return text;
}

class _TransferDetailsRow extends StatelessWidget {
  const _TransferDetailsRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '$label:',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(value, style: theme.textTheme.bodySmall)),
        ],
      ),
    );
  }
}

String? _transferLocalPath(SessionArtifactTransfer transfer) {
  final exportedPath = transfer.exportedPath?.trim();
  if (exportedPath != null && exportedPath.isNotEmpty) {
    return exportedPath;
  }

  final cachedPath = transfer.cachedFilePath?.trim();
  if (cachedPath != null && cachedPath.isNotEmpty) {
    return cachedPath;
  }

  return null;
}

String? _transferLocalPathLabel(
  AppLocalizations l10n,
  SessionArtifactTransfer transfer,
  String? path,
) {
  final exportedPath = transfer.exportedPath?.trim();
  if (path == null) {
    return null;
  }
  if (exportedPath != null && exportedPath.isNotEmpty) {
    return l10n.transferSavedPath(path);
  }
  return l10n.transferCachedPath(path);
}

String _transferDirectionLabel(
  AppLocalizations l10n,
  SessionArtifactTransferDirection direction,
) => switch (direction) {
  SessionArtifactTransferDirection.download => l10n.transferDirectionDownload,
  SessionArtifactTransferDirection.preview => l10n.transferDirectionPreview,
  SessionArtifactTransferDirection.upload => l10n.transferDirectionUpload,
};

String _transferStatusLabel(
  AppLocalizations l10n,
  SessionArtifactTransferStatus status,
) => switch (status) {
  SessionArtifactTransferStatus.queued => l10n.transferStatusQueued,
  SessionArtifactTransferStatus.running => l10n.transferStatusRunning,
  SessionArtifactTransferStatus.cached => l10n.transferStatusCached,
  SessionArtifactTransferStatus.completed => l10n.transferStatusComplete,
  SessionArtifactTransferStatus.canceled => l10n.transferStatusCanceled,
  SessionArtifactTransferStatus.failed => l10n.transferStatusFailed,
};

String _transferProgressLabel(
  AppLocalizations l10n,
  SessionArtifactTransfer transfer,
) {
  final transferred = transfer.bytesTransferred;
  final total = transfer.totalBytes;
  if (transferred == null && total == null) {
    return '';
  }
  if (transferred != null && total != null) {
    return l10n.transferProgressBytes(transferred, total);
  }
  if (transferred != null) {
    return l10n.transferProgressTransferredBytes(transferred);
  }
  return l10n.transferProgressBytes(0, total!);
}

String _transferDetailLabel(
  AppLocalizations l10n,
  SessionArtifactTransfer transfer,
) {
  if (transfer.status == SessionArtifactTransferStatus.failed) {
    return l10n.transferFailed;
  }
  if (transfer.status == SessionArtifactTransferStatus.canceled) {
    return l10n.transferCanceledByUser;
  }
  if (transfer.status == SessionArtifactTransferStatus.queued) {
    return l10n.transferWaitingToStart;
  }
  if (transfer.status == SessionArtifactTransferStatus.running) {
    return switch (transfer.direction) {
      SessionArtifactTransferDirection.upload => l10n.transferUploading,
      SessionArtifactTransferDirection.download => l10n.transferDownloading,
      SessionArtifactTransferDirection.preview => l10n.transferPreparingPreview,
    };
  }
  if (transfer.direction == SessionArtifactTransferDirection.preview) {
    return l10n.transferPreviewCached;
  }
  final bytes = transfer.bytesTransferred ?? transfer.totalBytes;
  if (bytes != null) {
    return transfer.direction == SessionArtifactTransferDirection.upload
        ? l10n.transferUploadedBytes(bytes)
        : l10n.transferDownloadedBytes(bytes);
  }
  return _transferStatusLabel(l10n, transfer.status);
}

class _TransferStatusIcon extends StatelessWidget {
  const _TransferStatusIcon({required this.status});

  final SessionArtifactTransferStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final icon = switch (status) {
      SessionArtifactTransferStatus.queued => Icons.schedule_outlined,
      SessionArtifactTransferStatus.running => Icons.downloading_outlined,
      SessionArtifactTransferStatus.cached => Icons.inventory_2_outlined,
      SessionArtifactTransferStatus.completed => Icons.check_circle_outline,
      SessionArtifactTransferStatus.canceled => Icons.cancel_outlined,
      SessionArtifactTransferStatus.failed => Icons.error_outline,
    };
    final color = switch (status) {
      SessionArtifactTransferStatus.completed => theme.colorScheme.primary,
      SessionArtifactTransferStatus.failed => theme.colorScheme.error,
      _ => theme.colorScheme.onSurfaceVariant,
    };

    return Icon(icon, color: color, size: 20);
  }
}

Map<SessionDetailKey, List<SessionArtifactTransfer>> _groupTransfers(
  List<SessionArtifactTransfer> transfers,
) {
  final groups = <SessionDetailKey, List<SessionArtifactTransfer>>{};
  for (final transfer in transfers) {
    groups.putIfAbsent(transfer.sessionKey, () => []).add(transfer);
  }
  return groups;
}

Map<_TransferLifecycleFilter, int> _countTransfersByFilter(
  List<SessionArtifactTransfer> transfers,
) {
  return {
    for (final filter in _TransferLifecycleFilter.values)
      filter: transfers
          .where((transfer) => _matchesFilter(transfer.status, filter))
          .length,
  };
}

bool _matchesFilter(
  SessionArtifactTransferStatus status,
  _TransferLifecycleFilter filter,
) => switch (filter) {
  _TransferLifecycleFilter.all => true,
  _TransferLifecycleFilter.active => switch (status) {
    SessionArtifactTransferStatus.queued ||
    SessionArtifactTransferStatus.running ||
    SessionArtifactTransferStatus.cached => true,
    _ => false,
  },
  _TransferLifecycleFilter.finished => switch (status) {
    SessionArtifactTransferStatus.completed ||
    SessionArtifactTransferStatus.canceled ||
    SessionArtifactTransferStatus.failed => true,
    _ => false,
  },
  _TransferLifecycleFilter.failed => switch (status) {
    SessionArtifactTransferStatus.failed => true,
    _ => false,
  },
};

String _emptyMessageForFilter(
  AppLocalizations l10n,
  _TransferLifecycleFilter filter,
  String trimmedSearchQuery,
) => trimmedSearchQuery.isEmpty
    ? switch (filter) {
        _TransferLifecycleFilter.all => l10n.transfersEmptyTitle,
        _TransferLifecycleFilter.active => l10n.transfersEmptyActive,
        _TransferLifecycleFilter.finished => l10n.transfersEmptyFinished,
        _TransferLifecycleFilter.failed => l10n.transfersEmptyFailed,
      }
    : switch (filter) {
        _TransferLifecycleFilter.all => l10n.transfersSearchEmptyAll,
        _TransferLifecycleFilter.active => l10n.transfersSearchEmptyActive,
        _TransferLifecycleFilter.finished => l10n.transfersSearchEmptyFinished,
        _TransferLifecycleFilter.failed => l10n.transfersSearchEmptyFailed,
      };

bool _matchesSearchQuery(
  SessionArtifactTransfer transfer,
  String trimmedQuery,
) {
  final normalizedQuery = trimmedQuery.toLowerCase();
  return [
    transfer.fileName,
    transfer.sessionKey.tool,
    transfer.sessionKey.sessionId,
    transfer.directionLabel,
    transfer.statusLabel,
    transfer.detailLabel,
    transfer.message,
    if (transfer.error != null) transfer.error!,
    if (transfer.exportedPath != null) transfer.exportedPath!,
    if (transfer.cachedFilePath != null) transfer.cachedFilePath!,
    if (transfer.sourceUrl != null) transfer.sourceUrl!,
    if (transfer.artifactKey != null) transfer.artifactKey!,
    if (transfer.contentHash != null) transfer.contentHash!,
    transfer.actionKey,
  ].any((value) => value.toLowerCase().contains(normalizedQuery));
}

bool _isTerminalTransfer(SessionArtifactTransfer transfer) =>
    switch (transfer.status) {
      SessionArtifactTransferStatus.completed ||
      SessionArtifactTransferStatus.canceled ||
      SessionArtifactTransferStatus.failed => true,
      _ => false,
    };

List<SessionArtifactTransfer> _sortTransfers(
  List<SessionArtifactTransfer> transfers,
  _TransferSortMode sortMode,
) {
  final sorted = List.of(transfers);
  return sorted..sort(
    (a, b) => switch (sortMode) {
      _TransferSortMode.newest => _compareNewest(a, b),
      _TransferSortMode.oldest => _compareOldest(a, b),
      _TransferSortMode.file => _compareByFileName(a, b),
      _TransferSortMode.status => _compareByStatus(a, b),
    },
  );
}

int _compareNewest(SessionArtifactTransfer a, SessionArtifactTransfer b) {
  return _compareByUpdatedThenCreatedDesc(a, b);
}

int _compareOldest(SessionArtifactTransfer a, SessionArtifactTransfer b) {
  return _compareByUpdatedThenCreatedAsc(a, b);
}

int _compareByFileName(SessionArtifactTransfer a, SessionArtifactTransfer b) {
  final fileNameCompare = a.fileName.toLowerCase().compareTo(
    b.fileName.toLowerCase(),
  );
  if (fileNameCompare != 0) {
    return fileNameCompare;
  }
  return _compareByUpdatedThenCreatedDesc(a, b);
}

int _compareByStatus(SessionArtifactTransfer a, SessionArtifactTransfer b) {
  final statusCompare = _statusSortPriority(
    a.status,
  ).compareTo(_statusSortPriority(b.status));
  if (statusCompare != 0) {
    return statusCompare;
  }
  return _compareByUpdatedThenCreatedDesc(a, b);
}

int _compareByUpdatedThenCreatedDesc(
  SessionArtifactTransfer a,
  SessionArtifactTransfer b,
) {
  final updatedCompare = b.updatedAt.compareTo(a.updatedAt);
  if (updatedCompare != 0) {
    return updatedCompare;
  }
  return b.createdAt.compareTo(a.createdAt);
}

int _compareByUpdatedThenCreatedAsc(
  SessionArtifactTransfer a,
  SessionArtifactTransfer b,
) {
  final updatedCompare = a.updatedAt.compareTo(b.updatedAt);
  if (updatedCompare != 0) {
    return updatedCompare;
  }
  return a.createdAt.compareTo(b.createdAt);
}

int _statusSortPriority(SessionArtifactTransferStatus status) =>
    switch (status) {
      SessionArtifactTransferStatus.queued ||
      SessionArtifactTransferStatus.running ||
      SessionArtifactTransferStatus.cached => 0,
      SessionArtifactTransferStatus.failed => 1,
      SessionArtifactTransferStatus.completed ||
      SessionArtifactTransferStatus.canceled => 2,
    };
