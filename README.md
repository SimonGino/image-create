# image-create

Single-user, local web app for generating images across multiple providers
(OpenAI gpt-image + Google Gemini), text-to-image and reference-image-to-image.
Design spec: [SPEC.md](SPEC.md).

> **Status:** backbone (SPEC §9.3). Scaffold + Drizzle schema + provider
> abstraction + the **OpenAI adapter** wired end to end. Next up: the Gemini
> adapter and the two-pane console UI (ticket 06).

## Stack

Next.js (App Router) · TypeScript · Tailwind v4 · SQLite (better-sqlite3) +
Drizzle · sharp thumbnails. API keys are read **server-side only**.

## Getting started

```bash
npm install
cp .env.example .env          # add OPENAI_API_KEY / GOOGLE_API_KEY
npm run db:generate           # generate the SQLite migration (once, after schema changes)
npm run dev                   # http://localhost:3000
```

The DB self-migrates on first boot. The home page is a backbone status view
(registered models + key status); the generation console is the next step.

**Custom endpoints:** both providers accept a proxy / relay / gateway via
`OPENAI_BASE_URL` and `GOOGLE_BASE_URL` (or in-app Settings). OpenAI's
Organization Verification gate for gpt-image applies only when hitting the
official `api.openai.com` directly — via a custom base URL it doesn't apply.

### Scripts

| command | what it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` / `db:migrate` / `db:push` | Drizzle Kit |
| `npm run smoke` | end-to-end persistence test (no network — injected adapter) |

## Layout

```
app/
  page.tsx                 backbone status view
  api/generate/route.ts    POST — validate → generate → persist
  api/models/route.ts      GET  — model catalog + per-provider key status
src/
  providers/               the abstraction (SPEC §3)
    types.ts               request/response, capabilities, pricing contracts
    errors.ts              Auth | Validation | RateLimit | Provider | Timeout
    registry.ts            adapter registry — add a provider here
    pricing.ts             estimate (≈$) + actual-from-usage (SPEC §6)
    openai/                first adapter: models metadata + REST adapter
  db/                      Drizzle schema + connection (SPEC §4)
  lib/                     credentials, paths, image/thumbnail I/O, request schema
  services/generation.ts   end-to-end orchestration
drizzle/                   generated SQL migrations
data/                      SQLite DB + generated images (git-ignored)
```

**Adding a provider** = implement one `ImageProviderAdapter`, add its
`ModelDescriptor[]`, and register it in `src/providers/registry.ts`. Nothing
above the abstraction changes.
