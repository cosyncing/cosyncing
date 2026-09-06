# Client distribution

Client releases are separate from the npm broker package and compiled native
broker releases. A `client-vX.Y.Z` tag stages five client artifacts from the
reviewed tag:

- a project-key-signed Android APK;
- a Linux x64 tarball;
- an unsigned Apple Silicon macOS DMG;
- an unsigned Apple Silicon macOS ZIP; and
- an unsigned Windows x64 portable ZIP.

The macOS DMG and ZIP hold the same app. The DMG is the browser download and
hits Gatekeeper's Finder gate; the ZIP is what the all-in-one installer places,
because `ditto -x -k` unpacks it into `~/Applications` with no mount, no prompt
and no `sudo`.

iOS distribution is deferred. TestFlight and App Store distribution require an
active Apple Developer Program membership; simulator compilation remains part
of public CI.

## The desktop clients also ship inside the broker release

The all-in-one installers (`install.sh`, `install.ps1`) place a desktop client
beside the broker, so the broker release carries the three desktop artifacts —
Linux x64, macOS arm64 ZIP, Windows x64 ZIP — copied from the matching
`client-vX.Y.Z` release rather than rebuilt. They are the same bytes a user
downloading by hand would get.

They are covered by the broker release's signed `SHA256SUMS`, and each
installer carries their digests baked in. They are deliberately **not** in the
release manifest: that manifest describes what a running broker can upgrade
*itself* to, and a GUI client is not a broker upgrade. Adding them there would
tell every installed broker to treat a client as a candidate for its own swap.

This makes a broker release depend on the matching client release already
existing, which is the client-first order below stated as a build step rather
than as a habit. Android is not carried: it installs from its own APK and no
installer places it.

## Who owns the `latest` pointer

GitHub keeps exactly one `latest` release per repository, and every broker ever
built compiles `releases/latest/download/release-manifest.json` in as its update
channel. **Only the broker release may hold that pointer.** A client promotion
that claims it moves `latest` to a release with no manifest, and every installed
broker's update check then 404s.

`client-release-promote.yml` therefore promotes with `--latest=false`, and
`test-client-release-policy.ts` fails the build if that ever changes. The same
pointer is what makes
`releases/latest/download/install.sh` a stable installer URL.

## Release controls

`.github/workflows/client-release.yml` requires the tag version to equal both
the root package version and the base version in `apps/client/pubspec.yaml`. The
tagged commit must already be on `main`, and the complete repository check runs
before packaging.

The workflow creates or resets only the matching draft, builds each platform on
its native hosted runner, uploads the five final assets, generates
`SHA256SUMS`, downloads and verifies the remote set, and publishes a GitHub
prerelease for physical acceptance. It never builds or ships the native broker.

After physical acceptance, `.github/workflows/client-release-promote.yml`
requires the exact tag plus typed `PROMOTE` confirmation. It verifies the same
six remote assets and promotes them stable — without the `latest` pointer, and
without rebuilding or replacing anything.

## Client-first rollout order

Broker and client releases use separate publication channels, and no workflow
gates one on the other. A release is client-first whenever a client that is
already published cannot fully drive the new broker. Before publishing the npm
broker for such a release:

1. publish and physically accept the matching client release;
2. promote that client release stable;
3. confirm every supported client download carries the new behavior; and
4. only then publish the npm broker release.

Do not reverse these steps. Holding this order is a manual responsibility; the
release workflows do not enforce it.

The order is mandatory whenever a release raises the broker's minimum client
contract revision. Past that floor an older client does not merely miss new
features — the pairing negotiates read-only and session controls stay disabled,
so a user whose broker updates first cannot drive their sessions until they
install a new client. A minimum-revision bump is therefore always at least a
minor version, and its release notes say so. The web client is exempt in both
directions because it ships inside the broker package and always matches it;
the ordering protects native desktop and mobile installs.

Release 0.5.0 raised the minimum client contract revision to 17. A 0.4.1 or
older client is read-only against a 0.5.0 broker.

### Pairing payload version 3

Pairing payload version 3 was the first change published under this rule. A
v1/v2 client cannot parse a v3 pairing offer. The updated client remains able
to pair with v1/v2 brokers during the rollout.
While connected to a revision-15 broker, that client also retains the old
WebSocket query credential path. It selects the fallback only after an
authenticated health response identifies revision 15; current brokers always
use one-use tickets. The revision-16 broker raises its minimum client revision
to 16 and rejects long-lived query credentials.

## Protected configuration

The `client-release-candidate` environment holds:

- `COSYNCING_ANDROID_KEYSTORE_B64`
- `COSYNCING_ANDROID_KEYSTORE_PASSWORD`
- `COSYNCING_ANDROID_KEY_ALIAS`
- `COSYNCING_ANDROID_KEY_PASSWORD`

The keystore must be backed up outside GitHub. Losing it prevents Android from
accepting future updates over the installed app. The workflow materializes it
only in runner temporary storage and fails closed rather than falling back to
Flutter's debug certificate. The final APK signer must also match the reviewed,
non-secret certificate fingerprint in
`docs/release/android-signing-certificate.sha256`; replacing the environment
secret with a different release key therefore fails publication.

The `client-production` environment guards manual stable promotion and contains
no signing key.

## Unsigned desktop policy

The macOS and Windows filenames, release notes, and user instructions state
that those builds are unsigned. macOS Gatekeeper and Windows SmartScreen may
warn or block first launch. Checksums provide file integrity, not publisher
authentication. A later signing/notarization lane must publish a new version;
it must not silently replace existing assets.
