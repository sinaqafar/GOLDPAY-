# ADR-001 — Monorepo with npm workspaces

**Status:** Accepted

## Context

The system is six runnable applications (api, bot, mini-app, admin, worker,
scheduler) over a shared financial core. Money types, error codes, the ledger
contract and the event envelope must be identical everywhere; a divergence
between, say, the bot's idea of a balance and the API's would be a financial
bug, not a cosmetic one.

SPEC 117.2 calls for a monorepo and suggests pnpm + Turborepo.

## Decision

Monorepo, but with **npm workspaces** rather than pnpm + Turborepo.

Layout per SPEC 117.100: `apps/*`, `packages/*`, `db/`, `scripts/`, `tests/`,
`docs/`, `infra/`.

## Consequences

Shared types and validation have exactly one definition. A change to the fee
engine cannot land in the API while the bot keeps the old behaviour.

The deviation from pnpm is an environment constraint: pnpm is not available
here. Nothing in the source depends on the package manager — the workspace
protocol is standard and a later migration is a `package.json` change.

Turborepo caching is absent. With a ~50 second test suite this costs nothing
yet; revisit if the suite grows past a few minutes.
