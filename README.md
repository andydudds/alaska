# Duddleston Expeditions

A growing archive of family trips. Each trip is its own self-contained page; the
root is the archive landing that lists them. Photos flow in automatically from a
shared iCloud album (mirrored server-side into Supabase) and can also be added by
hand from any phone.

## Layout

```
/index.html                 archive landing — lists every trip (reads trips.json)
/trips.json                 the config: one entry per trip (slug, dates, iCloud token…)
/alaska-2026/index.html     a trip page — itinerary + photo gallery (the TEMPLATE)
/alaska-2026/og-image.png   that trip's social preview image
/scripts/mirror.mjs         the iCloud → Supabase mirror (runs in the Action, not the browser)
/scripts/package.json       its dependencies
/.github/workflows/mirror.yml  hourly + manual schedule for the mirror
```

## How the photos work

- **Auto:** everyone adds to one shared iCloud album. An hourly GitHub Action
  (`mirror.yml` → `mirror.mjs`) reads the album server-side, re-hosts each new
  photo into Supabase Storage (iCloud's own URLs expire, so we never link them),
  converts HEIC → JPEG, derives the trip day from the capture time, and dedupes
  on the iCloud `photo_guid`. Safe to run every hour.
- **Manual fallback:** the **Add Photos** button on a trip page uploads straight
  from the browser with the Supabase **anon** key, gated by the family passcode.
- **Highlights:** star photos (passcode-gated) to feature them; the gallery shows
  highlights first with a "show all" toggle.

### Keys, and where each one lives

| Key | Where | Why |
|-----|-------|-----|
| Supabase **anon** | in each trip page's `index.html` | public by design, limited by RLS |
| Supabase **service_role** | GitHub secret `SUPABASE_SERVICE_ROLE` only | full power, server-side only — never in any HTML |
| iCloud album token | `trips.json` | it's a *public* album id, not a secret |

## Adding a new trip

1. Copy the template folder: `cp -r alaska-2026 <new-slug>` (e.g. `iceland-2027`).
2. In `<new-slug>/index.html`: change `TRIP_SLUG`, the `DAYS` labels, the og:url /
   og:image paths, and the itinerary copy.
3. Add an entry to `trips.json` with the new `slug`, `dates`, `start`/`end`,
   `tz`, and the new shared album's `icloudToken`.
4. Commit. The archive lists it automatically and the mirror starts pulling its
   photos on the next hourly run. No code changes needed.
