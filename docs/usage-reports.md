# Usage reports

Usage reports summarize the local history read by Tokdash. They include tools
that are not managed by cosyncing; project attribution may cover fewer sources
than the period totals. Project names are available only to the broker owner.

## What cost means

Cost is the API list-price equivalent calculated by Tokdash from its usage
records and effective pricing table. It is an estimate, not billed spend or a
subscription charge. Provider discounts, subscriptions, credits, and billing
adjustments can make your actual bill different. This meaning also applies to
costs included in exported images. Cost is excluded from exports by default.

## When a report refreshes

Reports stay in memory for up to five minutes. Complete windows ending before
the broker's local today can also stay on disk for up to 24 hours, across broker
restarts. Their runtime and baseline pricing identities must still match;
successful identity checks are memoized for up to five minutes. A verified disk
hit warms memory without changing the original report timestamp or extending
the disk entry's 24-hour deadline.

The next read after that deadline rebuilds the report and asks Tokdash to
refresh its usage, activity, and insights response caches. This allows imported,
restored, or corrected history to appear even when the runtime and pricing
versions have not changed. An unavailable upstream cannot revalidate an expired
report; the request can fail or return the available partial data instead.

Before and after a fresh scan, the broker checks the live runtime and pricing
identity. Changed identities, pricing overrides, failed identity reads, and
incomplete reports prevent persistence. These checks are conservative; Tokdash
currently does not provide a transactional identity attached to every response.
A pricing or runtime change may still take up to five minutes to appear in a
cached report. Previously stored cache files are rebuilt once after this upgrade.

## Sharing images

Desktop exports write PNG files to a selected folder; web exports download them.
Android uses the system share sheet. The machine overview omits project names;
the project-detail image includes them. Review the selected image before sharing.

Android share-sheet tests cover handoff and cancellation using a mocked platform
boundary. Device acceptance must also confirm that a receiving app can open both
light and dark PNGs, that exporting all four images works, and that cancellation
returns without a success message. A passing build or widget test alone does not
establish those device behaviors.
