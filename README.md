# RVR Ratings CRM (desktop app)

Electron desktop CRM client for RVR Rating Partners, built to replace day-to-day
EspoCRM web-UI use for staff. Each staff member logs in with their own real
EspoCRM username/password — the app is a genuine EspoCRM API client and
inherits the existing 6-role ACL model for free, with no permission logic
duplicated here.

Full scope and architecture decisions are tracked in the project's
`infrastructure-status.md` / desktop-app-scope addendum docs, not duplicated
here in full. Summary:

- **Framework:** Electron (matches the existing JS stack used by n8n/the website).
- **Auth:** direct EspoCRM API client, HTTP Basic Auth per staff login, held only
  in main-process memory for the session (never persisted to disk).
- **Distribution:** GitHub Releases + `electron-updater`. `.github/workflows/release.yml`
  builds Windows and macOS installers off a version tag push and attaches them
  to a Release.
- **Extensibility:** each screen is its own module (`src/renderer/modules/*.js`)
  against one shared EspoCRM API wrapper (`src/main/espoClient.js`) and n8n
  webhook wrapper (`src/main/n8nClient.js`), reached only via the `preload.js`
  contextBridge — the renderer never talks to EspoCRM or n8n directly.

## Status (v0.1.0 scaffold)

Built and wired to the real backend:

- Login screen (real EspoCRM auth, "Forgot password" opens the real login page
  where EspoCRM's native reset flow lives)
- Dashboard (KPI cards + cases-by-stage breakdown, from the logged-in user's
  own EspoCRM-visible cases)
- Claim a Case (calls the dedicated `rvr-case-claim-list` / `rvr-case-claim-submit`
  n8n webhooks, not the user's own EspoCRM token — a Caseworker's own ACL
  can't see unassigned cases outside their scope)
- Cases (list, respecting the user's real EspoCRM role/ACL)
- Pipeline (kanban board grouped by `cCaseStage`)
- Contacts (list)
- Clock In/Out (topbar widget — office clock-in/out wired to `rvr-clock-in-out`)
- Feedback button (Bug / Feature Request / Other → `rvr-app-feedback`)
- Background error capture (main + renderer process handlers → `rvr-app-error-tracking`)
- Auto-update wiring via `electron-updater` against this repo's GitHub Releases

**Not yet built / next steps:**

- Case detail view (Cases currently list-only)
- Clock In/Out's Surveyor-only Field option with the live GPS proximity check
  and case picker (the standalone `field-clock.html` mobile page already has
  this — porting the same UX into the topbar widget is the next step)
- Role-based UI (e.g. hiding financial fields for Trainee) — EspoCRM's own ACL
  already blocks the underlying data either way, but the UI doesn't yet hide
  fields a user can't see
- App icons (`build/icon.ico` / `build/icon.icns` are not yet supplied)
- Code signing (macOS notarization needs an Apple Developer Program membership,
  ~$99/yr; Windows signing is optional — see the project docs' "Flagged, not
  yet decided" section)
- `electron-store`/`electron-updater`/`electron`/`electron-builder` have not
  been `npm install`-ed or run in this environment — do that first before
  `npm start`

## Development

```bash
npm install
npm start
```

## Building installers

Requires a real macOS machine to build the macOS target (electron-builder
cannot cross-build macOS installers from Windows/Linux). The CI workflow
(`.github/workflows/release.yml`) handles both platforms automatically by
running on `windows-latest` and `macos-latest` runners — push a version tag
(`git tag v0.1.0 && git push --tags`) to trigger it.

To build locally:

```bash
npm run dist:win    # Windows only
npm run dist:mac    # macOS only (must run on a Mac)
npm run dist:all     # both (must run on a Mac)
```
