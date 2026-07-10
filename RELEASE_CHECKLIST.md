# Release Checklist

## Pre-release quality gates

- [ ] Confirm `package.json` version and changelog entry.
- [ ] Run `npm audit` and resolve production-impacting findings.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run format:check`.
- [ ] Run `npm test`.
- [ ] Run `npm run coverage` and confirm thresholds pass.
- [ ] Run `npm run build`.
- [ ] Run `npm run size`.
- [ ] Run `npm run pack:audit`.
- [ ] Run runtime smokes: `npm run smoke:node`, `npm run smoke:browser`, `npm run smoke:worker`.
- [ ] Run performance gates: `npm run bench:throughput` and `npm run bench:hitratio`.

## Package review

- [ ] Inspect `npm pack --dry-run` output for only intended files.
- [ ] Verify `exports` map covers ESM, CJS, types, React, inspect, dashboard, and dashboard/server subpaths.
- [ ] Verify `dependencies` remains empty and React remains optional peer-only.
- [ ] Verify browser-facing bundles do not include `node:*` imports.
- [ ] Verify README examples match current API.
- [ ] Verify CLI demo (`node scripts/demo-cli.mjs`) and dashboard demo (`node scripts/demo-dashboard.mjs`) work after build.

## Publish

- [ ] Ensure npm login uses the intended maintainer account with 2FA enabled.
- [ ] Create a clean release commit and tag.
- [ ] Publish with provenance: `npm publish --provenance --access public`.
- [ ] Confirm package page, install command, types, and subpath imports work from a fresh temp project.
- [ ] Publish GitHub release notes with benchmark and compatibility notes.
