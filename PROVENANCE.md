# Provenance

Relay began as a derivative of [Snapgent Connector](https://github.com/herdodp/snapgent-connector). It retains the GPL-3.0-or-later license and acknowledges that origin. A new version sequence and consolidated Git history do not change this attribution.

The implementation review used upstream commit `b910073c394c43b20a1ad43880d32c7e51801e81` on 30 October 2026. The inherited browser controller, parser, providers and overlay were replaced with TypeScript conversation orchestration, explicit action framing, declarative DOM profiles, session-aware transport and activity presentation. Site selectors can still overlap because they describe the same public interfaces.

The Rust runtime manages workspace leases, permissions and execution receipts. The editor companion registers its own folders rather than inferring another application's active workspace.

This is a rewrite within a derivative project's development history, not a claim of an isolated clean-room process. Third-party packages retain their licenses. See `LICENSE`, lockfiles and bundled package licenses.
