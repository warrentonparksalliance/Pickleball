# Pickleball / Pickle Jar — Claude Guidelines

## Environments

| Environment | Branch | URL | Hosted on | Firebase project |
|---|---|---|---|---|
| UAT | `uat` | uat.pickleball.warrentonparksalliance.com | Netlify (separate UAT site) | UAT project |
| Production | `main` | pickleball.warrentonparksalliance.com | GitHub Pages (`.github/workflows/deploy.yml`) | `pickleball-50914` |

- The Google Play app is a Trusted Web Activity wrapping the production URL,
  so merging to `main` updates the Play Store app too. A new app build is only
  needed when the Android wrapper itself changes.
- `Env` in `index.html` picks the Firebase project by hostname: only the
  production hostname uses production data. UAT, Netlify previews and local
  copies use the UAT project and show a "UAT test site" banner.

## Git Workflow

For all new work:
1. Create a feature branch from `uat`
2. Commit changes to the feature branch
3. Open a PR from the feature branch → `uat`
4. Once verified on the UAT site, the user releases with a PR `uat` → `main`
   (use a merge commit, not squash, so the branches stay aligned)

Never push directly to `uat` or `main`. All changes go through a PR. If a
hotfix lands on `main` directly, merge `main` back into `uat` afterwards.

## Branch Naming

Use descriptive branch names, e.g. `feature/bracket-pdf`, `fix/join-card-spacing`.

## Stack

- Single-file app: `index.html` (HTML + CSS + JS, no build step)
- Firebase Realtime Database for session state
- Netlify: UAT site (deploys `uat`) and PR previews

## Netlify Preview Usage

Netlify deploy previews are limited, so skip them by default. Add `[skip ci]`
to the commit message on PR commits unless the user explicitly asks for a
preview link on that PR. If a preview is needed later, push a follow-up
commit without the skip directive to trigger one.

Never put `[skip ci]` in a PR title: it can end up in the merge commit and
skip the UAT deploy (Netlify) or the production deploy (GitHub Actions).
