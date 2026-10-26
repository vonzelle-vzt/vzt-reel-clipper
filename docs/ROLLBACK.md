# Rollback

vzt-reel-clipper is a local CLI published as an npm package (`vzt-reel-clipper`). It has no hosted deployment, mobile app, or database, so there are no Vercel/OTA rollbacks and no DB migrations to revert.

## Roll back a release

1. Find the last good tag: `git tag --sort=-creatordate | head`.
2. If the bad version was published to npm, do not unpublish. Deprecate it and publish a fixed patch release from the last good commit:
   `npm deprecate vzt-reel-clipper@<bad> "broken, use <good>"`
3. If the bad change is on `main`, revert it: `git revert <sha>` (or `git revert -m 1 <merge-sha>`), open a PR, and let CI pass.
4. Users on a bad version can pin the previous one: `npm i -g vzt-reel-clipper@<good>`.

## Data

The CLI writes only clip output files. Re-run it on the source video to regenerate them; there is no persistent state to restore.
