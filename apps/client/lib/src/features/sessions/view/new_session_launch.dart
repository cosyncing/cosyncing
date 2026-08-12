import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/controller/new_session_launch_controller.dart';
import 'package:flutter/material.dart';

/// Visible phase of the immediate-session handoff.
enum NewSessionLaunchPhase {
  /// Waiting for the broker to create the session.
  creating,

  /// Preparing the app's Session Detail destination.
  opening,

  /// Handing the created identity to the live Session Detail connection.
  connecting,

  /// One boundary failed and can be retried or abandoned.
  failed,
}

/// Full-page immediate-session launch flow.
///
/// [onCreate], [onOpen], and [onConnect] are intentionally separate futures.
/// Each boundary starts immediately when its phase begins, while one rendered
/// frame is also awaited so even a synchronously-completing implementation
/// cannot skip the phase visually. This is a paint boundary, not an artificial
/// minimum spinner duration.
class NewSessionLaunchPage extends StatefulWidget {
  /// Creates the launch flow and starts it on the first mount.
  const NewSessionLaunchPage({
    required this.request,
    required this.onCreate,
    required this.onOpen,
    required this.onConnect,
    required this.onComplete,
    required this.onBack,
    super.key,
  });

  /// Accepted request from the New Session sheet.
  final NewSessionLaunchRequest request;

  /// Creates the broker session.
  final Future<SessionInfo> Function(NewSessionLaunchRequest request) onCreate;

  /// Opens or prepares the Session Detail destination.
  final Future<void> Function(SessionInfo session) onOpen;

  /// Starts or prepares the live connection handoff.
  final Future<NewSessionConnectionHandoff> Function(SessionInfo session)
  onConnect;

  /// Called after every boundary succeeds.
  final ValueChanged<SessionInfo> onComplete;

  /// Leaves the failed flow without exposing diagnostics.
  final VoidCallback onBack;

  @override
  State<NewSessionLaunchPage> createState() => _NewSessionLaunchPageState();
}

class _NewSessionLaunchPageState extends State<NewSessionLaunchPage> {
  NewSessionLaunchPhase _phase = NewSessionLaunchPhase.creating;
  FailureKind? _failureKind;
  SessionInfo? _session;
  bool _openingComplete = false;
  bool _connectingComplete = false;
  bool _running = false;
  NewSessionConnectionHandoff? _connectionHandoff;

  @override
  void initState() {
    super.initState();
    unawaited(_run());
  }

  Future<void> _run() async {
    if (_running) return;
    _running = true;
    _failureKind = null;
    try {
      var session = _session;
      if (session == null) {
        _setPhase(NewSessionLaunchPhase.creating);
        final values = await Future.wait<Object?>([
          Future<SessionInfo>.sync(() => widget.onCreate(widget.request)),
          _paintCurrentPhase(),
        ]);
        session = values.first! as SessionInfo;
        if (!mounted) return;
        _session = session;
      }
      final activeSession = session;

      if (!_openingComplete) {
        _setPhase(NewSessionLaunchPhase.opening);
        await Future.wait<void>([
          Future<void>.sync(() => widget.onOpen(activeSession)),
          _paintCurrentPhase(),
        ]);
        if (!mounted) return;
        _openingComplete = true;
      }

      if (!_connectingComplete) {
        _setPhase(NewSessionLaunchPhase.connecting);
        final values = await Future.wait<Object?>([
          Future<NewSessionConnectionHandoff>.sync(
            () => widget.onConnect(activeSession),
          ),
          _paintCurrentPhase(),
        ]);
        final handoff = values.first! as NewSessionConnectionHandoff;
        if (!mounted) {
          handoff.release();
          return;
        }
        _connectionHandoff = handoff;
        _connectingComplete = true;
      }

      _running = false;
      try {
        widget.onComplete(activeSession);
      } finally {
        _releaseConnectionAfterDestinationFrame();
      }
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _running = false;
        _phase = NewSessionLaunchPhase.failed;
        _failureKind = classifyFailure(error);
      });
    }
  }

  void _setPhase(NewSessionLaunchPhase phase) {
    if (!mounted) return;
    setState(() => _phase = phase);
  }

  Future<void> _paintCurrentPhase() => WidgetsBinding.instance.endOfFrame;

  void _releaseConnectionAfterDestinationFrame() {
    final handoff = _connectionHandoff;
    if (handoff == null) return;
    _connectionHandoff = null;
    // onComplete synchronously opens the embedded detail or navigates to the
    // compact detail route. Hold the auto-disposed controller until that
    // destination has rendered once and established its own provider watch.
    WidgetsBinding.instance.addPostFrameCallback((_) => handoff.release());
  }

  @override
  void dispose() {
    // Normal completion transfers the handoff to the post-frame callback and
    // clears this field first. An unrelated route teardown has no destination
    // to claim it, so release immediately.
    _connectionHandoff?.release();
    _connectionHandoff = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final sizeClass = WindowSizeClass.of(context);
    final horizontalPadding = sizeClass == WindowSizeClass.compact
        ? 24.0
        : 32.0;
    final maxWidth = sizeClass == WindowSizeClass.compact ? 440.0 : 560.0;

    return ColoredBox(
      key: const Key('new-session-launch-page'),
      color: tokens.surface,
      child: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            padding: EdgeInsets.symmetric(
              horizontal: horizontalPadding,
              vertical: 24,
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minHeight: (constraints.maxHeight - 48).clamp(
                  0.0,
                  double.infinity,
                ),
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: maxWidth),
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 160),
                    child: _phase == NewSessionLaunchPhase.failed
                        ? _LaunchFailure(
                            failureKind: _failureKind ?? FailureKind.unknown,
                            retrying: _running,
                            onRetry: () => unawaited(_run()),
                            onBack: widget.onBack,
                          )
                        : _LaunchProgress(phase: _phase),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LaunchProgress extends StatelessWidget {
  const _LaunchProgress({required this.phase});

  final NewSessionLaunchPhase phase;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final label = switch (phase) {
      NewSessionLaunchPhase.creating => l10n.newSessionCreatingLabel,
      NewSessionLaunchPhase.opening => l10n.newSessionLaunchOpeningLabel,
      NewSessionLaunchPhase.connecting => l10n.newSessionLaunchConnectingLabel,
      NewSessionLaunchPhase.failed => throw StateError(
        'Failure has its own launch surface.',
      ),
    };
    return Column(
      key: ValueKey<NewSessionLaunchPhase>(phase),
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(
          width: 32,
          height: 32,
          child: CircularProgressIndicator(
            key: Key('new-session-launch-progress'),
            strokeWidth: 3,
          ),
        ),
        const SizedBox(height: 16),
        Text(
          label,
          key: Key('new-session-launch-${phase.name}'),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(
          l10n.newSessionLaunchProgressBody,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: context.tokens.textSecondary,
          ),
        ),
      ],
    );
  }
}

class _LaunchFailure extends StatelessWidget {
  const _LaunchFailure({
    required this.failureKind,
    required this.retrying,
    required this.onRetry,
    required this.onBack,
  });

  final FailureKind failureKind;
  final bool retrying;
  final VoidCallback onRetry;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final advice = localizedFailureAdvice(l10n, failureKind);
    return Column(
      key: const Key('new-session-launch-failed'),
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          Icons.error_outline,
          size: 40,
          color: context.tokens.statusError,
        ),
        const SizedBox(height: 16),
        SelectionArea(
          child: Column(
            children: [
              Text(
                l10n.newSessionLaunchFailedTitle,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                l10n.failureMessage(l10n.newSessionLaunchFailedLead, advice),
                key: const Key('new-session-launch-error'),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: context.tokens.textSecondary,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        OverflowBar(
          alignment: MainAxisAlignment.center,
          overflowAlignment: OverflowBarAlignment.center,
          spacing: 8,
          overflowSpacing: 8,
          children: [
            OutlinedButton(
              key: const Key('new-session-launch-back'),
              onPressed: retrying ? null : onBack,
              child: Text(l10n.newSessionLaunchBackLabel),
            ),
            FilledButton(
              key: const Key('new-session-launch-retry'),
              onPressed: retrying ? null : onRetry,
              child: Text(l10n.retry),
            ),
          ],
        ),
      ],
    );
  }
}
