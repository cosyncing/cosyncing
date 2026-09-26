/// Coordinates attention presentation between windows of this app on one
/// device.
///
/// A browser can run the app in several tabs, and every tab runs the same
/// feed workers against the same local database. Without coordination, the
/// tab the user is looking at shows an in-app banner while a background tab
/// posts a system notification for the same event, or two background tabs
/// both alert for it.
abstract interface class AttentionPresentationCoordinator {
  /// Runs [body] while no other window presents events of [scopeKey].
  ///
  /// The next window then reads the state [body] recorded, so an event is
  /// presented once per device.
  Future<void> exclusive(String scopeKey, Future<void> Function() body);

  /// Whether another window of this app is in the foreground. Such a window
  /// shows events in-app, so this one leaves them to it instead of posting
  /// system notifications.
  Future<bool> anotherWindowInForeground();

  /// Stops coordinating.
  void dispose();
}

/// The only window on the device: native apps, and browsers without the Web
/// Locks API.
final class SingleWindowPresentationCoordinator
    implements AttentionPresentationCoordinator {
  /// Creates the single-window coordinator.
  const SingleWindowPresentationCoordinator();

  @override
  Future<void> exclusive(String scopeKey, Future<void> Function() body) =>
      body();

  @override
  Future<bool> anotherWindowInForeground() async => false;

  @override
  void dispose() {}
}
