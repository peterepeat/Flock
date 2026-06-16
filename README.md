# Flock

A collaborative running route planner. A group shares one link, each person enters
their own start, pace, distance and time constraints, and Flock works out routes
that maximise the time any two people spend running together. No accounts, one
shared link per flock, everything publicly accessible.

This repo implements **all ten build steps** of the spec: scaffolding, map shell,
participant form, polling, ORS route generation, multi-participant routes, the
together-time analysis with its glowing overlay, the schedule view, plan locking +
GPX export, and the landing/error/mobile polish — plus a name-keyed edit token.

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
- `POST /api/routes/calculate` runs the route engine: builds a shared "fly together"
  corridor from the group's start points, routes everyone through it via ORS
  foot-hiking (parallel, cached), times each route by pace, runs the together-time
  analysis (≤50m + ≤10min proximity → clustered stretches), builds per-participant
  schedules, and persists the result. The browser auto-triggers it (debounced 2s)
  whenever constraints change.
- `GET /api/gpx/[flockId]/[participantId]` returns a schema-valid GPX 1.1 file with
  the route as `<rtept>`s and together-stretch / rest stops as annotated `<wpt>`s.

### The "fly together" engine

The signature feature is produced by `src/lib/routeEngine.ts` + `src/lib/together.ts`:
everyone converges onto a shared corridor (the spec's "candidate shared waypoint"),
flies together along it, then diverges home — giving the solo → together → solo
pattern in the schedule. The together-time analysis only counts overlap that is close
in **both space and time**. A distance guard falls back to independent loops / direct
routes when a runner is too far from the corridor, and that pair is reported as too
far apart. Tuning knobs: `CORRIDOR_KM`, `MAX_ANCHOR_DETOUR_KM` (engine) and
`PROXIMITY_M`, `TIME_WINDOW_SEC`, `CLUSTER_GAP_M` (analysis).

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
