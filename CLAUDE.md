# Pickleball / Pickle Jar — Claude Guidelines

## Git Workflow

**Default target branch is `uat`, not `main`.**

For all new work:
1. Create a feature branch from `uat`
2. Commit changes to the feature branch
3. Open a PR from the feature branch → `uat`
4. Only merge to `main` when explicitly asked to release/promote from `uat`

Never push directly to `main` or `uat`. All changes go through a PR.

## Branch Naming

Use descriptive branch names, e.g. `feature/bracket-pdf`, `fix/join-card-spacing`.

## Stack

- Single-file app: `index.html` (HTML + CSS + JS, no build step)
- Firebase Realtime Database for session state
- Deployed via Netlify (auto-deploys `main`; PR previews for feature branches)
