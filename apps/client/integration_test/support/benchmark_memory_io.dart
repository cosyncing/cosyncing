import 'dart:io';

/// Resident process memory reported by the host OS.
int benchmarkMemoryBytes() => ProcessInfo.currentRss;
