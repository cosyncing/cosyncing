import 'package:flutter/services.dart';

/// Lets Session Detail own right-click menus while this route is mounted.
Future<void> disableSessionBrowserContextMenu() =>
    BrowserContextMenu.disableContextMenu();

/// Restores the browser context menu after leaving Session Detail.
Future<void> restoreSessionBrowserContextMenu() =>
    BrowserContextMenu.enableContextMenu();
