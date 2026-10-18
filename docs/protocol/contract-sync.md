# Contract synchronization

The broker is the wire-contract owner. The exporter reads broker source from
this checkout and writes a flattened, self-contained TypeScript snapshot plus
the Dart contract identity:

```bash
bun run contract:generate
bun run contract:check
bun run client:test:contract
```

`contract:check` exports to a temporary directory and compares byte-for-byte.
It never reads a sibling repository and never copies a TypeScript barrel.
Generated files must change in the same pull request as the broker contract and
typed client adaptation. The always-running CI contract job is intentionally
not path-filtered.

The client advertises its version, revision, minimum broker revision, and
surface hash on every stream connection. The broker's first `hello` frame
contains both identities and the negotiated status: compatible,
client-behind, broker-behind, unknown, or hard-incompatible. Hard incompatibility
forces read-only Observe on both sides.

The hash covers the enumerated route, frame-kind, message-kind, and error-code
registries. It is a drift signal, not a canonical schema hash of every DTO.
Any structural wire change must update the flattened snapshot and explicitly
raise the contract revision when compatibility semantics change.

## Media previews (revision 32)

`POST /api/media-preview-tickets` requires an authenticated owner or paired
client with file-read permission. The body contains `tool`, `sessionId`, and
exactly one of `path` (workspace-relative) or `artifactId` (an interactive
delivery). The response supplies `url`, `expiresAt`, `mimeType`, and `size`.
The broker verifies the resource before issuing the URL.

`GET`/`HEAD /api/media-previews/{id}` accept the returned capability without a
broker credential, so native and browser media decoders can seek using HTTP
ranges. The opaque URL authorizes only that file, expires after six hours,
and is revoked by `DELETE` when the preview closes. The broker holds at most
256 capabilities; restarting it discards them. Paired-device generation and
file authorization are checked on every request. Workspace previews still
require the owner's HTTP workspace-browsing setting and the existing jailed
path and symlink checks. Export-only artifacts cannot be previewed.
The workspace root is bound at issuance, so seeking does not rediscover the
session roster or retarget the capability when the session changes directory.

Only raster PNG/JPEG/WebP/GIF (32 MiB), PDF (128 MiB), and MP4/M4V/MOV/WebM
(2 GiB) are allowed. These caps are independent of text reads and ordinary
file downloads. Responses are non-cacheable and use fixed MIME types,
`nosniff`, and a restrictive document policy. URLs are private bearer
capabilities: do not log, persist, or share them. Cross-origin decoder access
is allowed for remote web clients; this does not grant access without the
capability. HTML, SVG, and office documents do not receive media URLs.

The client requests a capability only for a visible preview. PDF and video
code and PDF engine assets load on demand; the static worker validates and
caches their build-specific bytes on first use. Hidden and backgrounded
previews dispose decoders and revoke capabilities without awaiting network
cleanup during session navigation. Native **Open with** explicitly downloads
a file to the existing disk cache and invokes the operating system's file
association; it does not run a renderer in session state.
Ordinary download limits still apply to **Open with**; the larger media
ceilings apply to embedded streaming previews.

Native video follows the configured broker scheme, including private HTTP
brokers. Android permits cleartext traffic; Apple clients use the narrower
[`NSAllowsArbitraryLoadsForMedia`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloadsformedia)
exception for AVFoundation. HTTPS remains preferred. An App Store submission
must explain that broker addresses and transport are managed by the user.
