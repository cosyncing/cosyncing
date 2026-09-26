import 'package:broker_client_flutter/broker_client_flutter.dart';

/// The app's lifecycle monitor: Flutter's own on native platforms.
BrokerAppLifecycleMonitor createAppLifecycleMonitor() =>
    FlutterBrokerAppLifecycleMonitor();
