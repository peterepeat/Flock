# Flock

A collaborative running route planner. A group shares one link, each person enters
their own start, pace, distance and time constraints, and Flock works out routes
that maximise the time any two people spend running together. No accounts, one
shared link per flock, everything publicly accessible.

This repo currently implements **build steps 1–4** of the spec (scaffolding, map
shell, participant form, polling) plus a name-keyed edit token. Steps 5–10 (ORS
route generation, together-time analysis, schedule view, GPX export, landing
polish) are scaffolded but not yet built.

## Stack

- **Next.js 14.2** (App Router) + TypeScript
- **Leaflet / react-leaflet 4** with OpenStreetMap tiles
- **Tailwind CSS 3** + Zustand
- **Storage:** Upstash Redis (KV-compatible) in production, local file store in dev
- **OpenRouteService** (routing, step 5+) · **Nominatim** (geocoding, via a server proxy)

> Note: Vercel KV is discontinued, so `src/lib/store.ts` is a small abstraction that
> uses Upstash Redis when `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set and
> otherwise falls back to a JSON file store under `./.flock-data` (dev only, gitignored).

## Getting started

```bash
npm install
cp .env.example .env.local   # already populated locally with the ORS key
npm run dev
```

Open http://localhost:3000 and click **Start a flock →**.

### Environment variables

| Var | Purpose |
|---|---|
| `ORS_API_KEY` | OpenRouteService key (used from step 5) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis. If unset, the local file store is used. |
| `NEXT_PUBLIC_APP_URL` | Public base URL for share links |
| `FLOCK_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default: debug in dev) |

## How it works so far

- `POST /api/flocks/create` → 6-char id + share URL (30-day TTL).
- `GET /api/flocks/[id]` → full session (no-store). Edit tokens are **never** returned.
- `PATCH /api/flocks/[id]` → action-based, server-side read→apply→write. Every write
  bumps `updatedAt` (the polling heartbeat) and resets TTL.
- Clients poll every 5s; the store only re-renders when `updatedAt` changes, so an open
  form draft is never clobbered.
- `GET /api/geocode?q=` proxies Nominatim with the required `User-Agent` (client
  debounces 1s).

### Edit tokens

When you create a participant the client generates a secret token, keeps it in
`localStorage` (keyed by flock + participant id), and sends the raw token to the
server, which stores only its SHA-256 hash in a separate key. To edit or remove that
entry you must present the token. Result: on a given device you can edit only the
entry you created, while the link itself stays fully public.

## Diagnostics

`src/lib/logger.ts` is a structured, namespaced logger (timestamp · level · namespace ·
message · JSON context) with a `time()` helper for elapsed-ms timing. It is wired
through every API route and key client flow, and is the backbone for the heavy
diagnostics planned for the complex steps (ORS, together-time analysis, GPX).

## Scripts

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — Next lint
