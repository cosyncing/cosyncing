import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The wall clock behind the app's short behavioural windows, such as how
/// recently the user typed.
///
/// One provider rather than `DateTime.now()` at each site, so a test can drive
/// those windows on fake time.
final appClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);
