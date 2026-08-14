import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';

/// Formats one roster or attention timestamp against an explicit clock.
///
/// Keeping [now] explicit makes boundary behavior deterministic and prevents
/// the roster and Notifications surfaces from drifting into different copy.
String relativeTimeLabel(
  BuildContext context,
  AppLocalizations l10n,
  int epochMs, {
  required DateTime now,
}) {
  final timestamp = DateTime.fromMillisecondsSinceEpoch(epochMs);
  final difference = now.difference(timestamp);
  if (difference.inMinutes < 1) return l10n.sessionRosterJustNow;
  if (difference.inMinutes < 60) {
    return l10n.sessionRosterMinutesAgo(difference.inMinutes);
  }
  if (difference.inHours < 24) {
    return l10n.sessionRosterHoursAgo(difference.inHours);
  }
  if (difference.inDays < 7) {
    return l10n.sessionRosterDaysAgo(difference.inDays);
  }
  return MaterialLocalizations.of(context).formatCompactDate(timestamp);
}
