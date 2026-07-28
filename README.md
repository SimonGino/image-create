# image-create

Single-user, local web app for generating images across multiple providers
(OpenAI gpt-image + Google Gemini), text-to-image and reference-image-to-image.
Design spec: [SPEC.md](SPEC.md).

> **Status: SPEC v1 complete.** Every in-scope feature is built and
> live-verified against real provider endpoints (both t2i and reference).

## Features

- **Text-to-image** and **reference-image-to-image** (edit / compose from inputs)
- **OpenAI** (gpt-image, REST) + **Google Gemini** (Nano Banana, `@google/genai`),
  switchable per generation, each with its own **custom base URL** (proxy / relay)
- **Capabilities-driven** parameter panel — one metadata source drives the UI,
  validation, and cost. OpenAI is pixel-sized; Gemini is aspect-ratio + tier.
  Gemini has no native `n`, so multi-image is done by client-side fan-out.
- **Cost** — pre-flight `≈$` estimate + actual-from-usage (official token rates),
  cumulative usage by provider / model / month
- **Gallery** — thumbnail grid with filters, detail view, delete
- **Prompt templates / favorites** — save, apply (with default model), favorite
- **Iterative editing** — send any result/gallery image back in as a reference
- **Multi-model compare** — one prompt across several models, side by side
- **In-app Settings** — manage per-provider keys + base URLs (writes config.json)

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind v4 · SQLite (better-sqlite3) +
Drizzle · sharp thumbnails. API keys are read **server-side only**.

## Getting started

```bash
npm install
cp .env.example .env          # add OPENAI_API_KEY and/or GOOGLE_API_KEY (either is fine)
npm run db:generate           # generate the SQLite migration (once, after schema changes)
npm run dev                   # http://localhost:3000
```

The DB self-migrates on first boot. Only a provider with a configured key is
enabled in the model selector.

**Custom endpoints:** both providers accept a proxy / relay / gateway via
`OPENAI_BASE_URL` and `GOOGLE_BASE_URL`. OpenAI's Organization Verification gate
for gpt-image applies only when hitting the official `api.openai.com` directly —
via a custom base URL it doesn't apply. Note some relays only serve a subset of
models / snap non-standard pixel sizes to the standard set (the app always
reports the *actual* returned dimensions).

### Scripts

| command | what it does |
|---|---|
| `npm run dev` / `start` | Next.js dev / prod server |
| `npm run build` | production build (run standalone, not alongside `dev`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` / `db:migrate` / `db:push` | Drizzle Kit |
| `npm run smoke` | non-network e2e test (isolated `.smoke-data` DB, injected adapter) |

## Layout

```
app/
  page.tsx                        generation console
  gallery/page.tsx                gallery view
  api/generate/route.ts           POST — validate → generate → persist
  api/models/route.ts             GET  — model catalog + per-provider key status
  api/images/[...path]/route.ts   GET  — serve generated files (traversal-guarded)
  api/generations/route.ts        GET  — list (filter by provider/model/mode, paginate)
  api/generations/[id]/route.ts   GET one · DELETE (cascade DB + rm image dir)
  api/usage/route.ts              GET  — cumulative cost by provider / model / month
  api/prompt-templates/…          GET/POST · [id] PATCH/DELETE
src/
  components/                     client UI: console, gallery, history, compare,
                                  app-header, usage-chip, settings-form
  providers/                      the abstraction (SPEC §3)
    types.ts errors.ts registry.ts pricing.ts
    openai/  google/              the two adapters (models metadata + adapter)
  db/                             Drizzle schema + connection (SPEC §4)
  lib/                            credentials, paths, images, request-schema
  services/generation.ts          orchestration: validate → generate (native n or
                                  fan-out) → persist images/thumbnails/usage/cost
drizzle/                          generated SQL migrations
data/                             SQLite DB + generated images (git-ignored)
```

**Adding a provider** = implement one `ImageProviderAdapter`, add its
`ModelDescriptor[]`, and register it in `src/providers/registry.ts`. Nothing
above the abstraction changes.

## Optional follow-ups

- **Production build check** — `npm run build` once (verifies deployability).
- **Model list** — the three shipped ids (`gpt-image-2`,
  `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`) are all
  verified on the current relay. Older/cheaper ids were dropped on purpose;
  past Generations keep the id and cost they were recorded with.
- **Mask editing** (OpenAI) and **shadcn/ui** polish — supported by the
  abstraction / stack but not surfaced in the UI yet.
