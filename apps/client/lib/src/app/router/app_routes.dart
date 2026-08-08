/// Canonical route locations shared by the router and feature pages.
///
/// Keep navigation targets centralized so pages never hardcode route
/// strings. Session detail deep links are built by `session_routes.dart`
/// (`sessionDetailLocation`).
library;

/// Session roster and workspace.
const String sessionsRoute = '/sessions';

/// Attention inbox.
const String attentionRoute = '/attention';

/// Broker connection management.
const String connectionRoute = '/connection';

/// App settings hub.
const String settingsRoute = '/settings';

/// Transfer manager.
const String transfersRoute = '/transfers';

// Settings is a two-layer hierarchy: the hub above lists categories, and each
// category below owns the controls. The leaf pages that follow (appearance,
// pairing, …) stay direct children of `/settings` so links published before the
// hierarchy existed keep resolving.

/// Display settings category: theme, text size, tool display, visibility.
const String displaySettingsRoute = '$settingsRoute/display';

/// Notification settings category: delivery, per-session alerts, remote wake.
const String notificationSettingsRoute = '$settingsRoute/notifications';

/// Broker and device settings category: connection, credentials, pairing.
const String brokerDevicesSettingsRoute = '$settingsRoute/broker-devices';

/// Agent and usage settings category: managed runtimes, quota warnings.
const String agentsSettingsRoute = '$settingsRoute/agents';

/// General settings category: shortcuts, scheduled sends, transfers.
const String generalSettingsRoute = '$settingsRoute/general';

/// Appearance settings.
const String appearanceSettingsRoute = '$settingsRoute/appearance';

/// Tool display settings.
const String toolDisplaySettingsRoute = '$settingsRoute/tool-display';

/// Scheduled sends manager.
const String scheduledSendsRoute = '$settingsRoute/scheduled-sends';

/// Broker profile management.
const String brokerProfilesRoute = '$settingsRoute/broker-profiles';

/// Keyboard shortcut reference.
const String keyboardShortcutsRoute = '$settingsRoute/keyboard-shortcuts';

/// Broker pairing flow.
const String pairingRoute = '$settingsRoute/pairing';
