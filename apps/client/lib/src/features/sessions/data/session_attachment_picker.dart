import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'package:broker_client_flutter/broker_client_flutter.dart'
    show
        FileSelectorSessionAttachmentPicker,
        SessionAttachment,
        SessionAttachmentByteSource,
        SessionAttachmentPicker,
        SessionAttachmentTooLargeException,
        SessionAttachmentUploadPhase,
        sessionAttachmentMaxBytes;

/// App-level compatibility adapter for picker state wiring.
final sessionAttachmentPickerProvider = Provider<SessionAttachmentPicker>(
  (ref) => const FileSelectorSessionAttachmentPicker(),
);
