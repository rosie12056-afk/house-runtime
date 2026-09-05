# Changelog

## 0.2.1 - 2026-09-05

- Refresh the root dependency lock to fast-uri 3.1.7, addressing the published URI normalization advisories.
- Keep protocol document versions, storage schemas, and existing lifecycle semantics unchanged.
- Pin the tested maintenance dependency chain: house-protocols v0.2.2, house-toolkit v0.2.2.

The repository lockfile protects root installs with `npm ci`. It is not inherited by consuming projects. Consumers must refresh their own lockfiles and verify a patched fast-uri version (3.1.6 or newer in the 3.x line). Existing tags are not changed.

This is maintenance of the public package only. It does not deploy an instance, change model providers, or promote an experimental/candidate API to stable.

