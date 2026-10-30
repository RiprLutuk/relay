# Security

Report vulnerabilities through [private vulnerability reporting](https://github.com/RiprLutuk/relay/security/advisories/new). If unavailable, request a private contact through an issue without posting secrets or exploit details.

The runtime listens on loopback. Browser connections require an extension Origin and a pairing token on every request. Native editor connections require a Bearer token at handshake and a token on each request. Only authenticated native connections can register editor windows. Repeated authentication failures temporarily block the loopback peer.

The OS generates the token at `~/.relay/bridge-token`, or under `RELAY_STATE_DIR`. Unix permissions are `0700` for the directory and `0600` for the token. Pair only through the browser popup; never put the token into chat or Git. To rotate it, stop Relay, remove the token file, restart and pair again.

Each conversation binds to a registered window and root. Full access requires explicit popup approval and applies only to that session. Closing the owner, changing its roots or losing its lease invalidates its sessions. The browser rejects messages from obsolete run identities after a target change.

Workspace mode restricts file paths and command entry points. It is not an OS sandbox: project scripts and tools run as your user. Full access permits broader filesystem and process operations. Untrusted repositories, prompt injection, custom MCP servers and compromised local software remain risks; custom servers enforce their own behavior.

Install matching editor, browser and runtime versions from the same package. See [configuration](docs/configuration.md) for upgrade steps.
