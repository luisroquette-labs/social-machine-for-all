# ADR 0001: Exclude parallel worktrees from tests

## Context

Developers keep parallel Git worktrees under `.worktrees/`. Vitest otherwise discovers tests in those checkouts while running from the main checkout. A failing test on another branch can then block the current branch's pre-push check.

## Decision

Exclude `**/.worktrees/**` from Vitest discovery, alongside `node_modules`.

## Consequence

Each worktree runs its own tests. The current checkout's test result does not depend on tests from unrelated branches.
