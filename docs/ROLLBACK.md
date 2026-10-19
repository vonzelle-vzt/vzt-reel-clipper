# Rollback

vzt-reel-clipper is a local CLI published as an npm package / git checkout. It has no hosted service, mobile app, or database, so there are no deploys or migrations to revert.

## Roll back a release

1. Find the last good tag or commit: `git log --oneline` / `git tag`.
2. Revert the bad change on `main` with a PR: `git revert <sha>` (use `-m 1` for merge commits).
3. If a version was published to npm, do not unpublish. Publish a patch release from the revert, or point users at the previous version: `npm install vzt-reel-clipper@<good-version>`. Deprecate the bad one: `npm deprecate vzt-reel-clipper@<bad-version> "use <good-version>"`.
4. Local installs from git: `git checkout <good-tag> && npm ci`.

## If a hosted deploy is added later

- Vercel: open the project's Deployments tab, pick the previous good production deployment, and choose "Promote to Production" (or `vercel rollback`).
- Mobile: roll back via OTA update republish of the previous build, or halt the store phased release.
- Database: revert with a down migration, or restore from a backup/point-in-time snapshot. Document the migration tooling here when it exists.
