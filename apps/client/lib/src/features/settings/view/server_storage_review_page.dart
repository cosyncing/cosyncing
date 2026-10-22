import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/storage/data/server_storage_session.dart';
import 'package:cosyncing_client/src/formatting/file_size.dart';
import 'package:flutter/material.dart';

/// Reviews a finite inventory. All-page selection cannot include later
/// arrivals.
class ServerStorageReviewPage extends StatefulWidget {
  /// Pins this review to a measured inventory and its service.
  const ServerStorageReviewPage({
    required this.service,
    required this.snapshot,
    this.category = 'stored-files',
    this.failedJob,
    super.key,
  });

  /// App-scoped service; an accepted job survives closing this page.
  final ServerStorageSession service;

  /// Immutable measurement identity.
  final StorageInventory snapshot;

  /// Files or expired previews, never arbitrary filesystem paths.
  final String category;

  /// Finite failed-item scope from a previous result, paged by the server.
  final String? failedJob;

  @override
  State<ServerStorageReviewPage> createState() =>
      _ServerStorageReviewPageState();
}

class _ServerStorageReviewPageState extends State<ServerStorageReviewPage> {
  final _search = TextEditingController();
  final Set<String> _selected = {};
  bool _initialLoad = true;
  List<StorageReviewItem>? _items;
  final _cursors = <String?>[null];
  String? _nextCursor;
  int _eligibleCount = 0;
  int _offset = 0;
  int _days = 0;
  int _generation = 0;
  int? _allCount;
  bool _largest = false;
  bool _busy = false;
  String? _error;
  Timer? _searchDebounce;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _generation++;
    _searchDebounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load({bool filterChanged = false}) async {
    final generation = ++_generation;
    if (filterChanged) {
      _selected.clear();
      _allCount = null;
      _offset = 0;
      _cursors
        ..clear()
        ..add(null);
    }
    setState(() {
      _items = null;
      _error = null;
    });
    try {
      final page = await (await widget.service.client()).getStorageItems(
        widget.snapshot.inventoryId,
        category: widget.category,
        olderThanDays: _days,
        search: _search.text,
        sort: _largest ? 'size' : 'date',
        cursor: _cursors[_offset ~/ 100],
        failedJob: widget.failedJob,
      );
      if (mounted && generation == _generation) {
        setState(() {
          _items = page.items;
          _nextCursor = page.nextCursor;
          _eligibleCount = page.eligibleCount;
          if (_initialLoad && widget.failedJob != null) {
            _allCount = _eligibleCount;
          }
          _initialLoad = false;
        });
      }
    } on Object catch (error) {
      if (mounted && generation == _generation) {
        setState(() => _error = error.toString());
      }
    }
  }

  Future<void> _selectAll(bool selected) async {
    if (!selected) {
      setState(() {
        _allCount = null;
        _selected.clear();
      });
      return;
    }
    setState(() => _allCount = _eligibleCount);
  }

  Future<void> _remove() async {
    if (_busy) return;
    setState(() => _busy = true);
    final l10n = AppLocalizations.of(context);
    try {
      if (widget.service.uncertainAcceptance) {
        final result = await widget.service.recover();
        if (mounted && result != null) Navigator.pop(context, result);
        return;
      }
      final plan = await (await widget.service.client()).createStoragePlan({
        'mode': widget.category == 'stored-files' ? 'stored-files' : 'cache',
        'inventoryId': widget.snapshot.inventoryId,
        if (_allCount != null)
          'selectAll': true
        else
          'itemIds': _selected.toList(),
        'filter': {
          'category': widget.category,
          'olderThanDays': _days,
          'search': _search.text,
          if (widget.failedJob != null) 'failedJob': widget.failedJob,
        },
      });
      if (!mounted) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(l10n.remove),
          content: Text(
            l10n.storageServerConfirm(
              plan.itemCount,
              widget.service.profile.displayName,
              plan.affectedSessions,
              plan.reclaimableBytes == null
                  ? l10n.storageUnavailable
                  : formatFileSize(l10n, plan.reclaimableBytes!),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(l10n.cancel),
            ),
            FilledButton(
              key: const Key('storage-remove-confirm'),
              onPressed: plan.itemCount == 0
                  ? null
                  : () => Navigator.pop(context, true),
              child: Text(l10n.remove),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
      final result = await widget.service.submit(plan);
      if (mounted) Navigator.pop(context, result);
    } on Object catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final items = _items;
    final count = _allCount ?? _selected.length;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.storageReview)),
      body: SettingsPageBody(
        children: [
          Text(
            l10n.storageServerScope(widget.service.profile.displayName),
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('storage-search'),
            controller: _search,
            enabled: !_busy,
            decoration: InputDecoration(labelText: l10n.storageSearch),
            onChanged: (_) {
              _searchDebounce?.cancel();
              _searchDebounce = Timer(
                const Duration(milliseconds: 200),
                () => unawaited(_load(filterChanged: true)),
              );
            },
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 16,
            runSpacing: 8,
            children: [
              DropdownButton<int>(
                value: _days,
                items: [
                  DropdownMenuItem(value: 0, child: Text(l10n.storageAll)),
                  DropdownMenuItem(value: 7, child: Text(l10n.storageOlder7)),
                  DropdownMenuItem(value: 30, child: Text(l10n.storageOlder30)),
                ],
                onChanged: _busy
                    ? null
                    : (value) {
                        _days = value!;
                        unawaited(_load(filterChanged: true));
                      },
              ),
              DropdownButton<bool>(
                value: _largest,
                items: [
                  DropdownMenuItem(
                    value: false,
                    child: Text(l10n.storageNewest),
                  ),
                  DropdownMenuItem(
                    value: true,
                    child: Text(l10n.storageLargest),
                  ),
                ],
                onChanged: _busy
                    ? null
                    : (value) {
                        _largest = value!;
                        unawaited(_load());
                      },
              ),
            ],
          ),
          CheckboxListTile(
            key: const Key('storage-select-all'),
            contentPadding: EdgeInsets.zero,
            title: Text(
              l10n.storageSelectAll,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            value: _allCount != null,
            onChanged: _busy ? null : (value) => unawaited(_selectAll(value!)),
          ),
          Text(l10n.storageSelection(count)),
          if (_error != null)
            ContextualDetails(
              label: l10n.storageFailed,
              detail: _error,
              child: Text(l10n.storageFailed),
            ),
          if (items == null && _error == null) const LinearProgressIndicator(),
          if (items != null && items.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Text(l10n.storageEmpty),
            ),
          if (items != null)
            for (final item in items)
              ContextualDetails(
                key: ValueKey('storage-details-${item.id}'),
                label: item.label,
                detailsBuilder: item.sessionId == null && item.reason == null
                    ? null
                    : () => [
                        widget.service.profile.displayName,
                        if (item.tool != null) item.tool!,
                        if (item.sessionId != null) item.sessionId!,
                        if (item.reason != null) item.reason!,
                      ].join('\n'),
                child: CheckboxListTile(
                  key: ValueKey('storage-item-${item.id}'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    item.label,
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  subtitle: Text(
                    [
                      if (item.size == null)
                        l10n.storageUnavailable
                      else
                        formatFileSize(l10n, item.size!),
                      MaterialLocalizations.of(
                        context,
                      ).formatShortDate(item.createdAt),
                      if (!item.eligible) l10n.storageProtected,
                    ].join(' · '),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  value:
                      item.eligible &&
                      (_allCount != null || _selected.contains(item.id)),
                  onChanged: _busy || !item.eligible || _allCount != null
                      ? null
                      : (value) => setState(
                          () => value!
                              ? _selected.add(item.id)
                              : _selected.remove(item.id),
                        ),
                ),
              ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              TextButton(
                onPressed: _busy || _offset == 0
                    ? null
                    : () {
                        _offset -= 100;
                        unawaited(_load());
                      },
                child: Text(l10n.storagePrevious),
              ),
              TextButton(
                onPressed: _busy || items == null || _nextCursor == null
                    ? null
                    : () {
                        _offset += 100;
                        if (_cursors.length <= _offset ~/ 100) {
                          _cursors.add(_nextCursor);
                        }
                        unawaited(_load());
                      },
                child: Text(l10n.storageNext),
              ),
              FilledButton(
                key: const Key('storage-remove-selected'),
                onPressed: _busy || count == 0 ? null : _remove,
                child: Text(
                  widget.service.uncertainAcceptance
                      ? l10n.storageCheckingResult
                      : l10n.remove,
                ),
              ),
              if (widget.service.job != null && !widget.service.job!.finished)
                TextButton(
                  onPressed: widget.service.cancel,
                  child: Text(l10n.storageCancelRemaining),
                ),
            ],
          ),
          if (widget.service.job != null && !widget.service.job!.finished)
            Text(l10n.storageRemoving),
        ],
      ),
    );
  }
}
