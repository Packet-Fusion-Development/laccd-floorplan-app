# PF Site Survey

Packet Fusion's field survey platform. Engineers record rooms, device mounting
locations, device photos and floor-plan pins on site, from a phone or tablet,
into one central database that serves every customer project.

**LACCD is the first project.** The app started as the LACCD Floorplan Catalog:
a searchable catalog of 719 floor plans and telecom as-built drawings across
the ten Los Angeles Community College District campuses, built for the LACCD
District Technology Survey. That catalog is still what the app serves today,
and it seeds the LACCD project in the survey database. Some names (the
`laccd-floorplans` bucket, the 1Password item, the current hostname) still say
LACCD because they hold LACCD's data or have not been cut over yet. See
[Rename cutover](#rename-cutover).

## Survey data model

D1 database `pf-site-survey` (binding `DB`), schema in
[migrations/0001_multi_project_schema.sql](migrations/0001_multi_project_schema.sql):

```
customer → project → site → building → floor → floor_plan (drawing sheet)
                                            → room
project  → survey → device (pinned on a floor_plan) → photo
```

- **Ids are UUIDs** so field devices can create surveys, devices and photos
  offline and sync later without collisions.
- **Field-synced rows** (rooms, surveys, devices, photos) carry `updated_at`
  and `deleted_at`, so offline edits and deletions can be reconciled.
- **Device pins** are stored as `pin_x` / `pin_y` fractions (0–1) of the sheet,
  so they stay in place at any zoom or render size.
- **Category-specific device fields** go in the `attributes` JSON column, so a
  new device type needs no migration.
- **Room names in the LACCD export do not pair with room numbers**, so the seed
  creates one room per distinct room number and keeps the names as search text
  (`floor_plans.room_names_raw`). Engineers confirm room names in the field.

```bash
npm run db:migrate:local    # apply migrations to local D1
npm run db:seed:local       # load LACCD from data/catalog.json (idempotent)
```

The seed derives every id from its natural key, so it can be re-run after a
catalog edit without duplicating rows. `:remote` variants exist for both
commands. They write to the deployed database.

## Field survey app

`/survey` is an installable web app (PWA) for phones, tablets and desktops.
It is always branded **Packet Fusion Site Survey**, with the Packet Fusion
logo on every screen and no provider name or partner logo. It is generic: it
works for a university campus, a city's facilities, or a company's offices.
Each project sets only:

- **Wording:** what a location is called (Campus / Facility / Office) and
  what is being surveyed.
- **Categories:** each has a briefing button (e.g. "User List") and an item
  name for list and form screens (e.g. "Phones").
- **Get Support** contacts (call, text, email).

The engineer flow follows the welcome screen:

1. **Start** → choose a site.
2. **Site briefing:** site contact, parking, access hours, maps, and
   **Get Support**.
3. Choose a category.
4. Search the pre-loaded list by name, extension or number.
5. Mark the location on the floor plan (or describe it if no plan exists).
6. Fill in the required fields: the **test result** (working / not working /
   can't test), plus a location.
7. Add a photo only if something is unusual.
8. Set the **discrepancy flag** if something doesn't match the list.

Saved items drop off the list. Each engineer gets one survey per site,
created automatically.

**How each screen looks.** The layout follows the field-survey mockups:

- Solid brand-blue buttons on the site picker and the briefing.
- **Briefing:** a red "Contact … Support" button, plus WiFi network,
  username and password (masked until tapped).
- **List screen:** a blue app bar with back, refresh, sort and +, then
  Search items and a Not started / All filter.
- **Record form:** form-first, with ✕ and ✓ in the app bar; Site, Building
  and Floor at the top; a "Mark on floor plan" step; and an Attachments box.

Each category can add its own fields, such as "Cable drop status: Present,
Not present". Values are stored in `devices.attributes` and included in the
CSV export.

On phones, screens fill the display. On tablets and iPad they become a
centred card.

**Project setup** (`#/p/<code>/setup`, for the emails in `ADMIN_EMAILS`):

- Branding and wording.
- Logo upload.
- Site briefings.
- **Device-list import from CSV or Excel.** Columns are mapped automatically
  and can be adjusted. Buildings and floors that don't exist yet are created.
  Re-importing the same list updates rows instead of duplicating them.
- Results download (`/api/projects/<code>/devices.csv`), including test
  results and discrepancies.

Schema: [migrations/0002_field_workflow.sql](migrations/0002_field_workflow.sql).
Excel parsing uses SheetJS 0.20.3, vendored in `public/vendor/xlsx-0.20.3`.
It is loaded only on the setup screen.

**Online-first, offline as a fallback.** With a connection, every screen
loads live from the server and every save goes straight to D1. A copy of
what was loaded is kept on the device. Only when a request fails (no signal,
or no answer within 8 s) does the app switch to that copy and queue new
changes on the device. The queue syncs by itself, in order, when the
connection returns. Details:

| Piece | Where | Behaviour |
|---|---|---|
| Screens and data | [public/js/net.js](public/js/net.js) | Network first. Offline: device copy (IndexedDB) plus queued changes, marked "Not synced". |
| Writes | [src/api.ts](src/api.ts) | Idempotent `PUT`s keyed by a device-generated UUID, so a replayed queue lands once. Conflicts: last write wins on the client's `updated_at`, clamped so a fast clock cannot win forever. |
| Room added offline twice | `PUT /api/rooms/:id` | The server merges into the existing room (`merged_into`) and the app repoints queued devices. |
| App shell, plans, photos | [public/sw.js](public/sw.js) | Service worker, network first, cached copy only on failure. Floor-plan PDFs and photos are kept once viewed. |
| Expired sign-in | `net.js` | Treated like offline (nothing is lost), with a "Sign in again" prompt. |
| Server rejected a change | `net.js` | Moved to a review list instead of blocking the queue. |

Floor plans render from the PDF with pdf.js (vendored in
`public/vendor/pdfjs-3.11.174`, so it works offline). They fall back to the
catalog thumbnail if the PDF cannot load. Local dev has no PDFs in R2, so
locally you will always see the thumbnail.

**Local dev:** `cp .dev.vars.example .dev.vars` first. It turns off the Access
check for localhost only. Then `npm run db:migrate:local`,
`npm run db:seed:local`, `npm run dev`, and open http://localhost:8787/survey.

When changing a file listed in `SHELL` in `public/sw.js`, bump `VERSION` so
installed apps refresh their offline copy.

## Demo project: Packet Fusion University

A fictitious campus for showing the app to peers without customer data.
It is built by [scripts/build-demo.mjs](scripts/build-demo.mjs):

- 5 sites. Sites 1–3 have 2 buildings × 3 floors; sites 4–5 have
  5 buildings × 2 floors.
- 500 users (100 per site) on five-digit extensions laid out as
  site · building · floor · station. For example, `41203` is Site 4,
  Building 1, 2nd floor, station 03, and Site N uses the N0000s.
- 38 generated floor-plan PDFs, all marked "DEMO — FICTITIOUS".
- Briefings, plus a few completed records at Site 1.

```bash
npm run demo:build                     # → data/demo/ (gitignored)
npx wrangler d1 execute DB --env test --remote --file data/demo/pfu-demo.sql
# upload each data/demo/plans/<key> to the MEDIA bucket under the same <key>:
npx wrangler r2 object put "pf-site-survey-media-test/<key>" --file "data/demo/plans/<key>" --remote
```

Floor plans for any project other than LACCD live in the MEDIA bucket under
`<project_code>/plans/…`. `/pdfs/*` serves those keys from MEDIA and everything
else from the LACCD `laccd-floorplans` bucket.

## Test copy

`npx wrangler deploy --env test` deploys `pf-site-survey-test` to
https://survey-test.packetfusion.com/survey. It has its own D1 database
(`pf-site-survey-test`) and photo bucket (`pf-site-survey-media-test`). The
hostname is a second public hostname on the `laccd-floorplan-app` Access
application, so it shares that app's sign-in policy and AUD tag.

## Rename cutover

The repo, Worker and app are being renamed from `laccd-floorplan-app` to
`pf-site-survey`. A Worker's name is its identity, so the new name deploys as a
**new Worker** next to the old one. Do these steps in order before this branch
merges to `main` (merging auto-deploys):

1. **GitHub** (repo admin): Settings → General → rename to `pf-site-survey`.
   GitHub redirects the old URL. Then reconnect Workers Builds if it is linked.
2. **D1**: `npx wrangler d1 create pf-site-survey`, paste the id into
   `wrangler.jsonc` in place of the placeholder, then `npm run db:migrate:remote`
   and `npm run db:seed:remote`. Create the photo bucket:
   `npx wrangler r2 bucket create pf-site-survey-media`.
3. **Access**: create a self-hosted Access application for the new hostname
   (e.g. `survey.packetfusion.com`) **before** deploying to it, then set its
   `ACCESS_AUD` in `wrangler.jsonc` and update the `routes` pattern.
4. **Deploy** `pf-site-survey`, confirm it serves, then remove the old
   `laccd-floorplan-app` Worker, or keep its hostname as a redirect.

Until step 3, `wrangler.jsonc` still routes `laccd-floorplan-app.packetfusion.com`.
That domain is attached to the old Worker. **Do not deploy the new Worker
until step 3 is done**: depending on the Wrangler version, the deploy will
either fail or move the hostname away from the old Worker.

Runs as a single Cloudflare Worker: static frontend at the edge, PDFs streamed
from R2.

**Live:** https://laccd-floorplan-app.packetfusion.com (behind Cloudflare Access / Entra SSO)
**Cloudflare account:** `itcontact@packetfusion.com` (`521c322a89a17bb69f91f1e65177606e`)

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS, no build step | 719 rows filter instantly client-side; a framework buys nothing here |
| Hosting | Workers Static Assets | Shell + 719 thumbnails (12 MB) served from the edge with zero Worker invocations |
| Catalog | `catalog.json` as a static asset | 680 KB, read once on load. No database to operate |
| PDFs | R2, proxied by the Worker at `/pdfs/*` | 380 MB — too large for git, and R2 has no egress fees |
| Deploys | Wrangler CLI, or Workers Builds from GitHub | — |

**Why the PDFs are not in Workers Static Assets:** they would technically fit
(the 22.9 MB `LAVC Telecom Survey.pdf` is under the 25 MiB per-file cap), but
380 MB in a git repo makes clones and CI builds painful. In R2 they are
decoupled from the deploy entirely — a revised drawing is one upload, not a
redeploy.

**Why the Worker proxies R2 instead of a public bucket:** one hostname to put
Cloudflare Access in front of, and the bucket never has to be world-readable.
See [Access control](#access-control).

## Layout

```
src/index.ts              Worker — routes /pdfs/* to R2, everything else to static assets
src/access.ts             Cloudflare Access JWT verification
public/                   Deployed static bundle
  index.html, style.css, app.js
  catalog.json            Generated by `npm run build` (gitignored)
  thumbs/<CAMPUS>/*.jpg    719 preview images
data/
  catalog.json            Source of truth — edit this, tracked in git
  Floorplan_Data_Export_Claude.xlsx   Original export the catalog was derived from
scripts/
  build-catalog.mjs       Validates + minifies data/catalog.json → public/catalog.json
  upload-pdfs.mjs         Seeds / re-syncs R2 from ./pdfs
  test-access.mjs         Tests for the Access JWT gate (npm test)
  verify-r2.mjs           Cross-checks the R2 bucket against the catalog
pdfs/<CAMPUS>/*.pdf       Source drawings — NOT in git, lives in R2
```

## First-time setup

```bash
npm install
npx wrangler login
```

The `laccd-floorplans` bucket already exists. Seed it (one time, ~380 MB):

```bash
cp .env.example .env      # then fill in R2 API token credentials
npm run upload:pdfs -- --dry-run    # confirm what it would push
npm run upload:pdfs
```

`upload:pdfs` is idempotent — re-running skips objects already present at the
same size, so an interrupted upload can just be restarted. Use `--force` to
overwrite.

Then confirm the bucket matches the catalog:

```bash
npm run verify:r2
```

This checks every catalog row against a real R2 key and size, and reports
orphans. Run it after any bulk upload — a key mangled on the way in produces
a card that 404s on click, and nothing else surfaces that.

> **Do not bulk-upload with `wrangler r2 object put`.** It truncates keys at
> the first `#`, so `LASC/Parking Structure #8.pdf` silently lands under the
> key `LASC/Parking Structure ` and the Worker can never find it. `wrangler r2
> object get` truncates identically, so a CLI round-trip appears to succeed and
> hides the problem — only `list()` reveals the real key. Two files in this set
> are affected. `upload:pdfs` uses the S3 API and stores keys verbatim.

## Develop

```bash
npm run dev          # http://localhost:8787 — local R2 stub
npm run dev:remote   # http://localhost:8787 — reads the real R2 bucket
```

`npm run dev` runs fully locally, which is what you want for frontend work: it
needs no network and starts instantly. Its R2 stub is empty, though, so
`/pdfs/*` returns 404. Use `dev:remote` to exercise real PDF delivery.

## Deploy

```bash
npm run deploy
```

Or connect the GitHub repo under **Workers & Pages → laccd-floorplan-app →
Settings → Builds** with build command `npm run build` and deploy command
`npx wrangler deploy`. Pushes to `main` then ship automatically.

## Updating the catalog

`data/catalog.json` is the source of truth. Edit it (or regenerate from the
spreadsheet in `data/`), then:

```bash
npm run build      # validates every row, fails on a missing thumbnail
npm run deploy
```

The build step is a tripwire: it rejects rows with missing required fields,
duplicate `rel_path`s, or thumbnails that are not on disk, so a broken card
cannot reach production.

To add drawings: drop the PDF in `pdfs/<CAMPUS>/`, the thumbnail in
`public/thumbs/<CAMPUS>/`, add the row to `data/catalog.json`, then
`npm run upload:pdfs && npm run deploy`.

## Access control

The app is gated by **Cloudflare Access with Microsoft Entra ID SSO**.

Two things are worth understanding before touching this:

**Access cannot protect `*.workers.dev`.** A self-hosted Access application
requires a hostname on an active zone in the account, so the app lives at
`laccd-floorplan-app.packetfusion.com` and `workers_dev` is set to `false`.
Leaving workers.dev enabled would keep an unauthenticated door open next to
the locked one.

**Entra needs no per-application change.** The OAuth callback is the Zero
Trust *team domain*, not the app hostname:

```
https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback
```

Every Access application in the org shares that one IdP integration, so
adding a *second* application here does not require a new redirect URI.

What did have to be registered once was this org's callback. PacketFusion's
existing Entra app registration (`7660c7e3-5a2f-4abb-be55-caa1ab0d367a`) had
been set up against a different Zero Trust org, so the first sign-in failed
with:

```
AADSTS50011: The redirect URI 'https://packetfusion.cloudflareaccess.com/cdn-cgi/access/callback'
specified in the request does not match the redirect URIs configured for the application
```

That is an OAuth handshake failure, not an Access policy failure — it happens
before Cloudflare has an identity to evaluate a policy against, so no amount
of policy editing will move it. Fix: Entra admin center → that app
registration → Authentication → Platform configurations → Web → Add URI →
`https://packetfusion.cloudflareaccess.com/cdn-cgi/access/callback`. Entra
allows several redirect URIs, so this does not disturb the org it already
serves.

### Setup

1. **Zero Trust → Access → Applications → Add a self-hosted application.**
   Domain `laccd-floorplan-app.packetfusion.com`. Select the existing Entra ID
   identity provider. Add an Allow policy (an Entra group is preferable to an
   email-domain rule). Copy the **Application Audience (AUD) tag**.
2. **Fill in `vars` in `wrangler.jsonc`** — `ACCESS_TEAM_DOMAIN` (e.g.
   `packetfusion.cloudflareaccess.com`) and `ACCESS_AUD`. Neither is a secret.
3. **`npm run deploy`.** This creates the DNS record for the custom domain and
   retires the workers.dev hostname.

Do step 1 before step 3, so the hostname is never briefly public.

### How enforcement works

Access authenticates at the edge, before any request reaches the Worker. The
Worker then independently re-verifies the `Cf-Access-Jwt-Assertion` JWT on
every `/pdfs/*` request — checking signature, `aud`, `iss`, and expiry against
the team's published keys — so the drawings stay protected even if something
reaches the Worker directly. `npm test` covers that gate, including tampered
payloads, `alg: none`, expired tokens, and wrong-audience tokens.

Static assets (shell, `catalog.json`, thumbnails) are protected by Access at
the edge but are *not* re-verified in the Worker, because they are served
without invoking it. That is a deliberate trade: re-checking them would cost a
Worker invocation on all 719 thumbnails. To close that gap, set
`"run_worker_first": true` and move the check above the `/pdfs/` branch.

While `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are empty the Worker serves
without authentication — that is what makes a staged cutover possible, but it
does mean clearing those vars silently unprotects the PDFs.

When Access is enforcing, PDFs are returned `Cache-Control: private` so
intermediary caches cannot retain authenticated drawings.

## Notes

- `catalog.json` currently has room-level data (names/numbers) on 335 of 719
  sheets; the rest carry building/floor metadata only. Search already covers
  room fields, so it improves for free as that data is filled in.
- Should the catalog outgrow a single JSON payload — or need edits without a
  redeploy — the swap is D1 behind an `/api/catalog` route in the Worker, and
  a one-line change to the `fetch` in `public/app.js`.
