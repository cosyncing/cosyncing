import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:math';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_presentation_coordinator.dart';
import 'package:web/web.dart' as web;

/// Coordinates this browser's app tabs through the Web Locks API.
AttentionPresentationCoordinator createPresentationCoordinator(
  BrokerAppLifecycleMonitor lifecycle,
) => web.window.navigator.hasProperty('locks'.toJS).toDart
    ? WebPresentationCoordinator(lifecycle)
    : const SingleWindowPresentationCoordinator();

/// Coordinates app tabs through Web Locks.
///
/// - Presentation for one broker source runs under an exclusive lock, so the
///   tab that waited reads what the previous one presented.
/// - A tab holds its own foreground lock while it is resumed. A background tab
///   that sees another tab's foreground lock leaves the event to that tab.
///
/// Lock names carry the app's mount path, so another app or another Cosyncing
/// mount on the same origin is never involved. A lock is released when its
/// tab closes, so a crashed tab cannot hold presentation.
final class WebPresentationCoordinator
    implements AttentionPresentationCoordinator {
  /// Starts holding the foreground lock whenever [lifecycle] is resumed.
  ///
  /// [windowToken] identifies this tab's foreground lock; tests pass one to
  /// run two coordinators in a single page.
  WebPresentationCoordinator(
    BrokerAppLifecycleMonitor lifecycle, {
    String? windowToken,
  }) : _foregroundLock =
           '$_foregroundPrefix${windowToken ?? _randomWindowToken()}' {
    _sync(lifecycle.currentState);
    _subscription = lifecycle.stateChanges.listen(_sync);
  }

  final String _foregroundLock;
  late final StreamSubscription<BrokerAppLifecycleState> _subscription;
  Completer<void>? _releaseForeground;

  static String get _mount => Uri.parse(web.document.baseURI).path;

  static String get _foregroundPrefix => 'cosyncing-foreground:$_mount:';

  static web.LockManager get _locks => web.window.navigator.locks;

  @override
  Future<void> exclusive(String scopeKey, Future<void> Function() body) async {
    Object? failure;
    StackTrace? failureStack;
    await _locks
        .request(
          'cosyncing-present:$_mount:$scopeKey',
          ((web.Lock? _) => () async {
            try {
              await body();
            } on Object catch (error, stackTrace) {
              // Rethrown below, outside the lock, as the original error.
              failure = error;
              failureStack = stackTrace;
            }
          }().toJS).toJS,
        )
        .toDart;
    if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
  }

  @override
  Future<bool> anotherWindowInForeground() async {
    final snapshot = await _locks.query().toDart;
    return snapshot.held.toDart.any(
      (lock) =>
          lock.name.startsWith(_foregroundPrefix) &&
          lock.name != _foregroundLock,
    );
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    _release();
  }

  void _sync(BrokerAppLifecycleState state) {
    if (state != BrokerAppLifecycleState.resumed) {
      _release();
      return;
    }
    if (_releaseForeground != null) return;
    final release = Completer<void>();
    _releaseForeground = release;
    unawaited(
      _locks
          .request(
            _foregroundLock,
            ((web.Lock? _) => release.future.toJS).toJS,
          )
          .toDart
          .then<void>((_) {}, onError: (Object _) {}),
    );
  }

  void _release() {
    _releaseForeground?.complete();
    _releaseForeground = null;
  }

  static String _randomWindowToken() {
    final random = Random.secure();
    return List.generate(
      8,
      (_) => random.nextInt(0x10000).toRadixString(16).padLeft(4, '0'),
    ).join();
  }
}
