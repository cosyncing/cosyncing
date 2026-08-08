/// Formats a navigation badge count, capping large values at `99+`.
///
/// Shared by the app shell's nav badges and the workspace roster header so
/// every unread/attention badge renders the same label.
String navBadgeLabel(int count) => count > 99 ? '99+' : '$count';
