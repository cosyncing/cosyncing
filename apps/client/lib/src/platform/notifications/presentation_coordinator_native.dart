import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_presentation_coordinator.dart';

/// A native app is the only window on its device.
AttentionPresentationCoordinator createPresentationCoordinator(
  BrokerAppLifecycleMonitor lifecycle,
) => const SingleWindowPresentationCoordinator();
