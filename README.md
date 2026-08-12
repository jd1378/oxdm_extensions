# oxdm browser extension

Cross-browser WebExtension that captures downloads and forwards them to
the [oxdm](https://github.com/jd1378/oxdm) desktop app over its
loopback WebSocket bridge.

Built with [WXT](https://wxt.dev) — single TypeScript codebase, one
config, three build targets (Chromium MV3, Firefox MV2, Safari MV3).

## Features

- **Toolbar toggle** — click the action icon to switch auto-capture on
  / off; an `off` badge marks the disabled state.
- **Download interception** — when auto-capture is on,
  `chrome.downloads.onCreated` is cancelled + erased, and the URL is
  forwarded to oxdm with cookies, referrer, UA, and any
  `Content-Disposition` filename hint. Switching it off scopes the
  extension to explicit sends only — the connection, context menu and
  in-page pin all keep working, since someone who wants the browser to
  handle its own downloads still wants "Download with oxdm" on a
  right-click.
- **In-page button injection** — periodic viewport scan (default 5 s,
  stops on `load`, runs once more) finds anchors with a `download`
  attribute or downloadable URL extensions / paths and pins an oxdm
  button next to them. Each pin has a `✕` to dismiss. All injected DOM
  lives in a Shadow-DOM host so page CSS never bleeds in.
- **Hover triggers** — debounced `mouseover` re-scans the hovered
  anchor / button so dynamic UIs (single-page apps that render links on
  hover) still get the button.
- **Selection triggers** — `selectionchange` extracts URLs from the
  selected text. One URL → sent as a `capture` (dialog or not, per the
  handoff setting). Multiple URLs → forwarded as a `batch_capture`,
  oxdm shows its own triage dialog.
- **Context menu** — single "Download with oxdm" item; title rewrites
  with the count for link / selection / page contexts.
- **Capture rules** — file types, MIME filters, size threshold, and
  per-domain skips live in oxdm (Settings → Browser integration). The
  extension fetches them via `get_capture_rules` on connect and caches
  the result; oxdm is the single source of truth.
- **Handoff mode** — *Ask before downloading* (default on) sends
  `interactive: true`, so oxdm opens its Add Download dialog and owns
  folder / filename / category / queue / segments. Turn it off and jobs
  queue and start immediately; only then does the extension pick a
  queue, from oxdm's live list (`list_queues`). Leaving that on
  *Let oxdm decide* preserves oxdm's per-category queue rules.

## Build

```bash
pnpm install
pnpm build           # Chromium MV3 → .output/chrome-mv3/
pnpm build:firefox   # Firefox MV2  → .output/firefox-mv2/
pnpm build:safari    # Safari MV3   → .output/safari-mv3/  (untested on Linux)
pnpm zip             # .output/oxdm-0.1.0-chrome.zip
pnpm zip:firefox     # .output/oxdm-0.1.0-firefox.zip
pnpm test            # vitest — heuristics + URL extraction
pnpm compile         # tsc --noEmit
```

`pnpm dev` / `pnpm dev:firefox` launch the browser with the extension
auto-loaded (WXT spawns Chrome or Firefox if installed).

## Manual test plan

oxdm must be running with its IPC bridge enabled (default port `27812`)
and an extension token configured. Copy the token from
*Settings → Browser integration*, paste it into the extension's Options
page.

### Chromium

1. `pnpm build`
2. `chrome://extensions` → enable Developer Mode → **Load unpacked** →
   pick `.output/chrome-mv3/`.
3. Click the toolbar icon; popup should show *Connected to oxdm*.
4. Visit a page with a downloadable link
   (e.g. `https://www.example-files.com/file.zip`). Confirm the oxdm
   button appears next to it. Click it → oxdm queues the download.
5. Trigger a browser download (`<a download href="…big.zip">`). Confirm
   the download is cancelled in `chrome://downloads` and the job appears
   in oxdm.
6. Select text containing multiple URLs (e.g. paste a release page
   listing). Confirm the *Download Selected (N)* pill appears below the
   selection. Click → oxdm receives the batch and opens its triage
   dialog.

### Firefox

1. `pnpm build:firefox`
2. `about:debugging` → **This Firefox** → **Load Temporary Add-on…** →
   pick any file inside `.output/firefox-mv2/` (e.g. `manifest.json`).
3. Repeat the chromium checks.

### Safari

Not runnable on this machine. Build target exists; bundling for Safari
requires Xcode's `safari-web-extension-converter` on macOS.

## Project layout

```text
entrypoints/
  background.ts        # WS client, download intercept, message router
  content.ts           # in-page scanner bootstrap
  popup/               # toolbar popup
  options/             # pairing code, transport, UX toggles
src/
  shared/
    ipc.ts             # reconnecting WS, request/response correlation
    messages.ts        # protocol types
    state.ts           # settings persistence
    heuristics.ts      # URL / element classification
  content/
    scanner.ts         # viewport + hover + selection logic
    injector.ts        # Shadow-DOM button host
public/                # icons (on/off, multiple sizes)
```

## Protocol

Uses oxdm's v1.1 IPC. See `oxdm/docs/EXTENSION_API.md` for the wire
format. The extension sends:

| message             | when                                          |
|---------------------|-----------------------------------------------|
| `capture`           | single-URL send (intercept, pin, ctx)         |
| `batch_capture`     | multi-URL selection / page-link send          |
| `get_capture_rules` | on connect — oxdm owns the capture filters    |
| `list_queues`       | Options → Handoff, to fill the queue picker   |

`evaluate_url` is defined by the protocol but deliberately unused: both
oxdm dialogs probe their own rows, so calling it here would be a second
round-trip for metadata the user is about to be shown anyway.

`batch_capture` is sent without `interactive` or a queue, so oxdm always
opens its triage dialog for it. That is deliberate: oxdm only skips
triage when the caller both opts out *and* routes every item, so a page
that manages to drive the extension cannot bulk-queue downloads
silently. The queue setting therefore applies to single captures only.

## Division of responsibility

The extension's job ends at the handoff. It owns only what lives in the
browser and what oxdm cannot see:

| the extension owns                                 | oxdm owns                                              |
|----------------------------------------------------|--------------------------------------------------------|
| Intercepting `downloads.onCreated`, cancel + erase  | Everything after `accept_capture`                      |
| Cookie jar, real User-Agent, page referrer          | Filename resolution + numbering, `Content-Disposition` |
| In-page detection (pin, selection, context menu)    | Save folder, category classification, segments         |
| Applying the capture rules oxdm authored            | Authoring those rules (Settings → Browser integration) |
| Rejecting loopback / RFC1918 / link-local URLs      | Scheme guard only — LAN is allowed for token holders   |
| Whether the Add dialog opens (`interactive`)        | The dialog itself, and every choice inside it          |
| Queue only when no dialog will open                 | Per-category queue rules, Main fallback, schedulers    |

Two consequences worth keeping in mind when editing:

- `isPublicHttpUrl` is not backed by a second gate. oxdm's
  `guard_public_http_url` checks the scheme and nothing else, on
  purpose — a token-holding script is trusted to pull from a NAS. For
  page-driven captures the extension is the only thing standing between
  a hostile page and the user's intranet.
- Sending an explicit `queue` overrides oxdm's per-category routing,
  which is why it is sent only when the user turned the dialog off and
  chose a specific queue.
