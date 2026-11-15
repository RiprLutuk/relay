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

## Release

Keep the root, browser, editor and Cargo versions identical. Update the changelog and README download links, run all checks above, then build every supported package:

```sh
npm run package -- --all
(cd target/packages && shasum -a 256 -c SHA256SUMS.txt)
```

Push the verified commit before creating the matching GitHub tag and uploading the five VSIX files plus `SHA256SUMS.txt`. Publishing does not require CI and does not deploy a hosted service.

Keep transport, conversation orchestration, editor lifecycle and native execution separate. Add a failing regression test before behavior changes. Generated `build/`, `out/`, VSIX and native artifacts are not source.
