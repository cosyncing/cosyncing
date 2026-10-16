import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:intl/intl.dart';

/// Decimal file sizes, matching the KB/MB/GB units shown by download tools.
String formatFileSize(AppLocalizations l10n, int bytes) {
  if (bytes < 1000) return l10n.bytesCount(bytes);
  var size = bytes / 1000;
  var unit = 0;
  while (size >= 999.95 && unit < 3) {
    size /= 1000;
    unit++;
  }
  final value = NumberFormat('0.#', l10n.localeName).format(size);
  return switch (unit) {
    0 => l10n.fileSizeKilobytes(value),
    1 => l10n.fileSizeMegabytes(value),
    2 => l10n.fileSizeGigabytes(value),
    _ => l10n.fileSizeTerabytes(value),
  };
}

/// Transfer progress uses the same units as file rows and previews.
String formatFileProgress(
  AppLocalizations l10n, {
  int? transferred,
  int? total,
}) {
  if (transferred == null && total == null) return '';
  if (total == null) return formatFileSize(l10n, transferred!);
  if (total < 1000 && (transferred ?? 0) < 1000) {
    return l10n.transferProgressBytes(transferred ?? 0, total);
  }
  return l10n.transferProgressSize(
    formatFileSize(l10n, transferred ?? 0),
    formatFileSize(l10n, total),
  );
}
