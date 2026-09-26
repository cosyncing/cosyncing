# flutter_local_notifications_windows (vendored fork)

Repository-owned fork of the pub package `flutter_local_notifications_windows`,
used only by `apps/client` through `dependency_overrides`. Upstream's own
`README.md` is kept as-is; this file records the fork.

## Provenance

| | |
| --- | --- |
| Upstream | https://github.com/MaikuB/flutter_local_notifications/tree/master/flutter_local_notifications_windows |
| Forked from | pub.dev `flutter_local_notifications_windows` 3.1.1 |
| Fork version | `3.1.1+cosyncing.1` |
| License | unchanged, see `LICENSE` |

Bump the `+cosyncing.N` suffix on every fork change.

## Why this is vendored

The Windows client is unpackaged: the one-line installer places a plain
executable, with no MSIX package identity. Upstream only removes a delivered
toast when the app has package identity, so for this app `cancel` did nothing.
A read or answered notification stayed in Action Center, and a reminder
stacked a new toast next to the old one.

## Divergence from upstream 3.1.1

Every change is marked `cosyncing:` in the source.

- **Toast group.** `showNotification` sets group `cosy` on every toast. An
  unpackaged app can remove one toast only through
  `History.Remove(tag, group, aumid)`, which rejects an empty group. Showing
  the same tag and group again replaces the earlier toast.
- **Cancel.** `cancelNotification` calls `Remove(tag, group)` with package
  identity and `Remove(tag, group, aumid)` without it. Removing a toast that
  is no longer in Action Center throws "Element not found", which is ignored.
- **Setting.** New export `getNotificationSetting` returns
  `ToastNotifier.Setting`. Dart exposes it as `notificationSetting()` returning
  `WindowsNotificationSetting`, so the app can report "turned off in Windows"
  instead of claiming delivery.
- **Cold-start activation.** `UpdateRegistry` also writes
  `HKCU\Software\Classes\CLSID\{guid}\LocalServer32` = the running
  executable, on every start. COM then launches the app with `-Embedding` when
  a toast is clicked while it is not running, and delivers the activation
  once the plugin registers its class object.
- `lib/src/ffi/bindings.dart` is edited by hand to add the one binding.
  `ffigen.yaml` is kept, and regenerating from `src/ffi_api.h` produces the
  same entry point.

Toasts delivered by an older client carry no group, so `Remove` cannot reach
them. The app clears them once with `cancelAll` (`History.Clear(aumid)`) the
first time it starts with this fork.

**Not vendored.** `test/` (its fixtures are binary and it needs a built DLL),
`example/`, `build.bat`, `dart_test.yaml`, and `analysis_options.yaml` (its
`include: package:flutter_lints/...` does not resolve from a path dependency).
`dev_dependencies` are removed for the same reason. Trailing whitespace in
`CHANGELOG.md` is stripped.

## Verification

- WinRT behaviour, checked on Windows 11 build 26200: `Remove(tag)` throws
  "Element not found"; `Remove(tag, group, aumid)` and
  `RemoveGroup(group, aumid)` remove the toast; an empty group is rejected;
  `Clear(aumid)` works; `Setting` reads `Enabled`.
- The built DLL, driven directly under a throwaway AUMID: every toast carries
  group `cosy`, the same tag replaces, `cancelNotification` removes one toast
  and ignores an absent one, `cancelAll` clears, `LocalServer32` names the
  running executable, and `getNotificationSetting` reads `Enabled`.
- Native code is compiled by the Windows client build (`flutter build windows`
  from PowerShell against an NTFS copy of the tree).

## Updating the fork

1. `flutter pub cache add flutter_local_notifications_windows -v <version>`
2. `diff -ru ~/.pub-cache/hosted/pub.dev/flutter_local_notifications_windows-<version> packages/dart/flutter_local_notifications_windows`
3. Reapply every `cosyncing:` change.
4. Build the Windows client and repeat the clear, replace, and cold-start checks.
5. Update this file and bump the `+cosyncing.N` suffix in `pubspec.yaml`.
