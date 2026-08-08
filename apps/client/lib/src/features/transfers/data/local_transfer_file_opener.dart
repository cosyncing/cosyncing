import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener_stub.dart'
    if (dart.library.io) 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener_io.dart'
    as platform;
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener_types.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'local_transfer_file_opener_types.dart';

/// App provider for transfer file actions in non-web tests and desktop/mobile targets.
final localTransferFileOpenerProvider = Provider<LocalTransferFileOpener>(
  (ref) => platform.createLocalTransferFileOpener(),
);
