# CI

`github-actions-ci.yml` is the pipeline for this project.

It is stored here rather than at `.github/workflows/` because the automation
account that authored it lacks GitHub's `workflows` permission, so a push
containing that path is rejected. Activate it with:

```bash
mkdir -p .github/workflows
cp infra/ci/github-actions-ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml && git commit -m "ci: enable" && git push
```

## What it enforces

**Quality gate** (SPEC 117.66) — typecheck, the full test suite, migrations
applied against an empty database, and the admin bundle building. The migration
step matters on its own: a migration that only works against an
already-populated database is exactly the one that fails on a fresh deploy.

**Financial invariants**, asserted against the source. Each has been verified
to fail when violated rather than passing vacuously:

| Check | Why |
|---|---|
| No `AUTO_*=true` | SPEC 3755 — the treasury is funded only by the owner, manually |
| No `REAL`/`DOUBLE`/`FLOAT` money columns | A rounded amount is a financial bug |
| Journal writes only in `packages/ledger` | `post()` is the sole posting path |
| No jetton identifiers | GRAM is TON's native currency, not a token |

**Security** — dependency audit (advisory, so a transitive finding does not
block an unrelated fix) and a scan for committed credentials.
