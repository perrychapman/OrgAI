# Contributing to OrgAI

Read `.orgai/ARCHITECTURE.md` and `CLAUDE.md` first. They record the stack, module layout and conventions.

## Branches

- `dev` is the integration branch. Work on a feature branch (or directly on `dev`) and open pull requests into `dev`.
- `main` is stable and protected. It changes only through a pull request from `dev` once `dev` is stable.
- CI (`.github/workflows/ci.yml`) runs on pushes to and pull requests into `main` and `dev`.
- OrgAI agent runs merge their worktrees into whatever branch is checked out. Keep `dev` checked out for agent work.

## Releases

1. Bump `version` in `package.json` on `dev`.
2. Merge `dev` into `main` by pull request.
3. Tag the main commit and push the tag: `git tag v<version> && git push origin v<version>`.
4. `.github/workflows/release.yml` checks that the tag is on `main` and equals the package version, builds the
   Windows and macOS installers and drafts a GitHub release. Publish the draft by hand.

The release workflow refuses tags that are not reachable from `main`. A manual dry run of another branch builds only.

## Commands

- Install: `npm ci`
- Typecheck: `npm run typecheck`
- Unit tests: `npm test`
- Build: `npm run build`
- E2E (free, needs a build): `npm run e2e:free`

## Tokens

Never run the smoke scripts (`scripts/smoke-*.mjs`) or the token-spending e2e scripts (`e2e/setup.mjs`,
`e2e/history.mjs`, `e2e/worktree.mjs`) in CI or without the maintainer's explicit consent. `npm test` and
`npm run e2e:free` never spend tokens.
