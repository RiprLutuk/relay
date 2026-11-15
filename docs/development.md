# Development

Requirements: Node 22.18+, Rust 1.88+, Cargo, and platform build tools.

```sh
npm run setup
npm test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
npm run package
```

`npm test` type-checks and bundles both TypeScript hosts, runs browser/editor regression tests, then runs Rust unit and integration tests. The Playwright fixture is documented in [verification](verification.md).

Keep transport, conversation orchestration, editor lifecycle and native execution separate. Add a failing regression test before behavior changes. Generated `build/`, `out/`, VSIX and native artifacts are not source.
