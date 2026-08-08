import 'dart:async';
import 'dart:collection';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/attention/view/attention_event_copy.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Bounded foreground coalescing window owned by the app root.
const Duration foregroundAttentionCoalesceWindow = Duration(milliseconds: 300);

/// Maximum lifetime of one informational foreground aggregate.
const Duration foregroundAttentionInformationalLifetime = Duration(seconds: 8);

/// Maximum recent event identities retained for runtime replay suppression.
///
/// Durable presentation revisions remain the primary reconnect fence. This
/// bounded LRU closes short in-process delivery races without growing for the
/// lifetime of the app.
const int foregroundAttentionDedupeCapacity = 4096;

/// One app-root foreground notification aggregate.
class ForegroundAttentionHost extends ConsumerStatefulWidget {
  /// Creates the root aggregate around [child].
  const ForegroundAttentionHost({
    required this.child,
    required this.onOpen,
    this.onOpenEntry,
    this.coalesceWindow = foregroundAttentionCoalesceWindow,
    this.informationalLifetime = foregroundAttentionInformationalLifetime,
    this.now = DateTime.now,
    super.key,
  });

  /// Routed application content.
  final Widget child;

  /// Opens the durable inbox without mutating its events.
  final VoidCallback onOpen;

  /// Opens one exact event, or receives null for a multi-event aggregate.
  final ValueChanged<AttentionInboxEntry?>? onOpenEntry;

  /// First-arrival-anchored coalescing window.
  final Duration coalesceWindow;

  /// First-presentation-anchored informational lifetime.
  final Duration informationalLifetime;

  /// Clock override for deterministic widget tests.
  final DateTime Function() now;

  @override
  ConsumerState<ForegroundAttentionHost> createState() =>
      _ForegroundAttentionHostState();
}

class _ForegroundAttentionHostState
    extends ConsumerState<ForegroundAttentionHost> {
  final LinkedHashMap<String, int> _presentedRevisions =
      LinkedHashMap<String, int>();
  _ForegroundAttentionAggregate _pending = _ForegroundAttentionAggregate.empty;
  _ForegroundAttentionAggregate _visible = _ForegroundAttentionAggregate.empty;
  Timer? _coalesceTimer;
  Timer? _autoHideTimer;
  DateTime? _firstPresentedAt;

  @override
  void dispose() {
    _coalesceTimer?.cancel();
    _autoHideTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AttentionInboxEntry?>(
      foregroundAttentionEventProvider,
      (_, entry) {
        if (entry != null) _accept(entry);
      },
    );

    return Stack(
      fit: StackFit.expand,
      children: [
        widget.child,
        if (_visible.isNotEmpty)
          Align(
            alignment: Alignment.topCenter,
            child: SafeArea(
              minimum: const EdgeInsets.all(12),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 560),
                child: _ForegroundAttentionBanner(
                  aggregate: _visible,
                  onOpen: _open,
                  onClose: _close,
                ),
              ),
            ),
          ),
      ],
    );
  }

  void _accept(AttentionInboxEntry entry) {
    final key = _eventIdentity(entry);
    final revision = entry.event.presentationRevision;
    final priorRevision = _presentedRevisions.remove(key);
    if (priorRevision != null && priorRevision >= revision) {
      _presentedRevisions[key] = priorRevision;
      return;
    }
    _presentedRevisions[key] = revision;
    while (_presentedRevisions.length > foregroundAttentionDedupeCapacity) {
      _presentedRevisions.remove(_presentedRevisions.keys.first);
    }
    _pending = _pending.add(entry);
    _coalesceTimer ??= Timer(widget.coalesceWindow, _publishPending);
  }

  void _publishPending() {
    _coalesceTimer = null;
    if (!mounted || _pending.isEmpty) return;
    final pending = _pending;
    _pending = _ForegroundAttentionAggregate.empty;
    final firstPresentation = _visible.isEmpty;
    setState(() {
      if (firstPresentation) {
        _firstPresentedAt = widget.now();
      }
      _visible = _visible.merge(pending);
    });
    _scheduleAutoHide();
  }

  void _scheduleAutoHide() {
    _autoHideTimer?.cancel();
    _autoHideTimer = null;
    if (_visible.needsInput > 0) return;
    final firstPresentedAt = _firstPresentedAt;
    if (firstPresentedAt == null) return;
    final elapsed = widget.now().difference(firstPresentedAt);
    final remaining = widget.informationalLifetime - elapsed;
    if (remaining <= Duration.zero) {
      _hideCurrent();
      return;
    }
    _autoHideTimer = Timer(remaining, _hideCurrent);
  }

  void _open() {
    final target = _visible.singleEntry;
    _hideCurrent();
    final openEntry = widget.onOpenEntry;
    if (openEntry == null) {
      widget.onOpen();
    } else {
      openEntry(target);
    }
  }

  void _close() {
    _hideCurrent();
  }

  void _hideCurrent() {
    _autoHideTimer?.cancel();
    _autoHideTimer = null;
    if (!mounted || _visible.isEmpty) return;
    setState(() {
      _visible = _ForegroundAttentionAggregate.empty;
      _firstPresentedAt = null;
    });
  }

  static String _eventIdentity(AttentionInboxEntry entry) {
    return '${entry.profile.id}\u0000${entry.event.id}';
  }
}

class _ForegroundAttentionBanner extends StatelessWidget {
  const _ForegroundAttentionBanner({
    required this.aggregate,
    required this.onOpen,
    required this.onClose,
  });

  final _ForegroundAttentionAggregate aggregate;
  final VoidCallback onOpen;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final copy = _ForegroundAttentionCopy.fromAggregate(aggregate, l10n);
    final compact = WindowSizeClass.of(context) != WindowSizeClass.expanded;
    final iconColor = aggregate.needsInput > 0
        ? tokens.statusNeedsInput
        : aggregate.failed > 0
        ? tokens.statusError
        : tokens.accent;
    final text = _BannerText(copy: copy, iconColor: iconColor);
    final actions = _BannerActions(onOpen: onOpen, onClose: onClose);

    return Semantics(
      container: true,
      liveRegion: true,
      child: Material(
        key: const Key('foreground-attention-banner'),
        color: tokens.surface,
        elevation: 4,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(tokens.radiusMd),
          side: BorderSide(color: tokens.separator),
        ),
        clipBehavior: Clip.antiAlias,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: compact
              ? Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    text,
                    const SizedBox(height: 8),
                    Align(alignment: Alignment.centerRight, child: actions),
                  ],
                )
              : Row(
                  children: [
                    Expanded(child: text),
                    const SizedBox(width: 12),
                    actions,
                  ],
                ),
        ),
      ),
    );
  }
}

class _BannerText extends StatelessWidget {
  const _BannerText({required this.copy, required this.iconColor});

  final _ForegroundAttentionCopy copy;
  final Color iconColor;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Row(
      children: [
        Icon(Icons.notifications_outlined, size: 18, color: iconColor),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                copy.title,
                key: const Key('foreground-attention-title'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(
                  context,
                ).textTheme.bodyMedium?.copyWith(color: tokens.textPrimary),
              ),
              if (copy.detail != null) ...[
                const SizedBox(height: 4),
                Text(
                  copy.detail!,
                  key: const Key('foreground-attention-detail'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: tokens.textSecondary,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _BannerActions extends StatelessWidget {
  const _BannerActions({required this.onOpen, required this.onClose});

  final VoidCallback onOpen;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final style = TextButton.styleFrom(
      foregroundColor: tokens.accent,
      minimumSize: const Size(40, 40),
      padding: const EdgeInsets.symmetric(horizontal: 8),
    );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        TextButton(
          key: const Key('foreground-attention-open'),
          style: style,
          onPressed: onOpen,
          child: Text(l10n.foregroundAttentionOpen),
        ),
        const SizedBox(width: 4),
        Semantics(
          key: const Key('foreground-attention-close'),
          label: l10n.foregroundAttentionCloseSemantics,
          button: true,
          onTap: onClose,
          excludeSemantics: true,
          child: TextButton(
            key: const Key('foreground-attention-close-button'),
            style: style,
            onPressed: onClose,
            child: Text(l10n.foregroundAttentionClose),
          ),
        ),
      ],
    );
  }
}

final class _ForegroundAttentionCopy {
  const _ForegroundAttentionCopy({required this.title, this.detail});

  factory _ForegroundAttentionCopy.fromAggregate(
    _ForegroundAttentionAggregate aggregate,
    AppLocalizations l10n,
  ) {
    final singleEntry = aggregate.singleEntry;
    if (singleEntry != null) {
      return _ForegroundAttentionCopy(
        title: _singleEventTitle(singleEntry.event, l10n),
      );
    }

    final parts = <String>[
      if (aggregate.needsInput > 0)
        l10n.foregroundAttentionNeedsInputCount(aggregate.needsInput),
      if (aggregate.finished > 0)
        l10n.foregroundAttentionFinishedCount(aggregate.finished),
      if (aggregate.failed > 0)
        l10n.foregroundAttentionFailedCount(aggregate.failed),
      if (aggregate.other > 0)
        l10n.foregroundAttentionOtherCount(aggregate.other),
    ];
    return _ForegroundAttentionCopy(
      title: l10n.foregroundAttentionAggregateTitle(aggregate.total),
      detail: parts.join(' · '),
    );
  }

  final String title;
  final String? detail;
}

final class _ForegroundAttentionAggregate {
  const _ForegroundAttentionAggregate({
    required this.total,
    required this.needsInput,
    required this.finished,
    required this.failed,
    required this.other,
    required this.singleEntry,
  });

  static const empty = _ForegroundAttentionAggregate(
    total: 0,
    needsInput: 0,
    finished: 0,
    failed: 0,
    other: 0,
    singleEntry: null,
  );

  final int total;
  final int needsInput;
  final int finished;
  final int failed;
  final int other;
  final AttentionInboxEntry? singleEntry;

  bool get isEmpty => total == 0;
  bool get isNotEmpty => total > 0;

  _ForegroundAttentionAggregate add(AttentionInboxEntry entry) {
    final event = entry.event;
    final eventNeedsInput = _needsInput(event);
    final eventFinished = event.isGoalFinished || event.isRunFinished;
    final eventFailed = event.isRunFailed;
    final eventOther = !eventNeedsInput && !eventFinished && !eventFailed;
    return _ForegroundAttentionAggregate(
      total: total + 1,
      needsInput: needsInput + (eventNeedsInput ? 1 : 0),
      finished: finished + (eventFinished ? 1 : 0),
      failed: failed + (eventFailed ? 1 : 0),
      other: other + (eventOther ? 1 : 0),
      singleEntry: total == 0 ? entry : null,
    );
  }

  _ForegroundAttentionAggregate merge(
    _ForegroundAttentionAggregate otherAggregate,
  ) {
    if (otherAggregate.isEmpty) return this;
    if (isEmpty) return otherAggregate;
    return _ForegroundAttentionAggregate(
      total: total + otherAggregate.total,
      needsInput: needsInput + otherAggregate.needsInput,
      finished: finished + otherAggregate.finished,
      failed: failed + otherAggregate.failed,
      other: other + otherAggregate.other,
      singleEntry: null,
    );
  }
}

bool _needsInput(AttentionEvent event) {
  return event.isPermissionRequired || event.isQuestionRequired;
}

String _singleEventTitle(AttentionEvent event, AppLocalizations l10n) {
  final sessionId = event.action.sessionId ?? event.sessionId;
  if (sessionId != null &&
      sessionId.trim().isNotEmpty &&
      (_needsInput(event) ||
          event.isGoalFinished ||
          event.isRunFinished ||
          event.isRunFailed ||
          event.isSyncDegraded)) {
    return attentionSessionEventTitle(event, l10n);
  }
  return switch (event.kind) {
    'runtime-update-ready' => l10n.foregroundAttentionRuntimeUpdate,
    'sync-degraded' => l10n.foregroundAttentionSyncDegraded,
    'device-paired' => l10n.foregroundAttentionDevicePaired,
    'security-alert' => l10n.foregroundAttentionSecurityAlert,
    'usage-threshold' => l10n.foregroundAttentionUsageThreshold,
    'broker-health' => l10n.foregroundAttentionBrokerHealth,
    'scheduled-send' => l10n.foregroundAttentionScheduledSend,
    'scheduled-send-failed' => l10n.foregroundAttentionScheduledSendFailed,
    _ =>
      event.title.trim().isEmpty
          ? l10n.foregroundAttentionFallbackTitle
          : event.title.trim(),
  };
}
