import 'package:flutter/material.dart';

/// One theme derived from the ambient one, kept while neither the ambient
/// theme nor the derivation's input changes.
///
/// `Theme(data: Theme.of(context).copyWith(...))` in a build hands its subtree
/// a new [ThemeData] on every build. It is equal to the last one, so nothing
/// rebuilds for it, but it is not identical, and `Theme.of` localizes a theme
/// through a small cache keyed by identity: every read below a fresh copy
/// misses that cache and copies the theme again. A row that rebuilds with each
/// streamed chunk then pays for several theme copies per frame. Holding the
/// derived theme keeps the subtree's theme identical while what it is made of
/// is unchanged.
///
/// One instance serves every widget that derives the same way: they all read
/// the same ambient theme, so the one theme kept is the one they all need.
final class DerivedTheme<T> {
  /// Derives each theme with the given function of the base and the input.
  DerivedTheme(this._derive);

  final ThemeData Function(ThemeData base, T input) _derive;
  ThemeData? _base;
  T? _input;
  ThemeData? _derived;

  /// [base] derived for [input]: the theme kept from an earlier call when
  /// [base] and [input] equal that call's, a new derivation otherwise.
  ThemeData of(ThemeData base, T input) {
    final derived = _derived;
    if (derived != null &&
        input == _input &&
        (identical(base, _base) || base == _base)) {
      // Equal is as good as identical for the result; remembering this
      // instance keeps the next call on the identity fast path.
      _base = base;
      return derived;
    }
    _base = base;
    _input = input;
    return _derived = _derive(base, input);
  }
}
