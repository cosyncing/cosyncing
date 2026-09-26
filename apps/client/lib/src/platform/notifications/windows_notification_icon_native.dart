import 'dart:io';

import 'package:flutter/foundation.dart';

/// The toast app logo the Windows build installs next to the executable
/// (`data\notification_icon.png`), or null anywhere else or when missing.
String? windowsNotificationIconPath() {
  if (defaultTargetPlatform != TargetPlatform.windows) return null;
  try {
    final directory = File(Platform.resolvedExecutable).parent.path;
    final sep = Platform.pathSeparator;
    final path = '$directory${sep}data${sep}notification_icon.png';
    return File(path).existsSync() ? path : null;
  } on Object {
    return null;
  }
}
