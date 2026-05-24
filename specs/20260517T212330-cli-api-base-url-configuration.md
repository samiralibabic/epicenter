# CLI API Base URL Configuration

**Date**: 2026-05-17
**Status**: Superseded by simpler design (see below)
**Author**: Braden + AI-assisted

## One sentence

`EPICENTER_API_URL` in `packages/constants/src/apps.ts` reads `process.env.EPICENTER_API_URL` when set, else the canonical prod URL; every Node consumer that already imported the constant gets the override for free.

## Shape

```ts
// packages/constants/src/apps.ts
export const EPICENTER_API_URL =
  (typeof process !== 'undefined' && process.env?.EPICENTER_API_URL) ||
  APPS.API.urls[0];
```

That is the whole feature. Browser bundles and Cloudflare Workers lack `process.env` and fall through to the prod default; Node CLI and daemon pick up the override.

Two scripts make the dev loop ergonomic, in both root and `packages/cli/`:

```
bun run cli         prod
bun run cli:local   http://localhost:8787
```

## Refused

- A `resolveApiEndpoint()` resolver, a `packages/cli/src/util/api-url.ts` module, and a 9-test file. Replaced by the env-aware constant.
- A separate CLI resolver for per-host token files. Machine auth already belongs under `env-paths('epicenter').data/auth/<host>.json`; the same-subject guard wiping a mismatched cell on identity change remains correct.
- A `Using API at <url>.` stderr log. Untestable as user-visible behavior; required a test-only module-state reset hatch.
- Trailing-slash stripping and upfront `URL.canParse` validation. Downstream fetch errors are clear enough.
- A `--api-url` flag. Env var subsumes it.

## Postmortem

The original commit added 66 LOC of resolver, 106 LOC of tests, per-host filename derivation, a stderr log, a test-only reset export, and a 278-line spec, AND broke 6 `runUp` tests by computing `filePath` from `os.homedir()` directly (bypassing the test infrastructure's `process.env.HOME` override). The product requirement was "point the CLI at a different URL." A default value, not an architecture. The follow-up collapsed everything to one line in the constant.
