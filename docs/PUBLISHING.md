# Publishing

How to cut a release and get it into the Chrome Web Store, Firefox
Add-ons (AMO) and Safari.

## Release artifacts

Tagging does not build anything. The flow is deliberately manual at both
ends so nothing reaches a store without being looked at:

1. Bump `version` in `package.json`. The workflow refuses to run if the
   tag and this value disagree.
2. Commit, then tag: `git tag v0.1.1 && git push origin v0.1.1`.
3. On GitHub, draft a release for that tag, tick **Set as a pre-release**,
   and publish it.
4. `.github/workflows/release.yml` fires, builds all three targets, and
   attaches:

   | asset | goes to |
   | --- | --- |
   | `oxdm-extension-<v>-chrome.zip` | Chrome Web Store |
   | `oxdm-extension-<v>-firefox.zip` | AMO |
   | `oxdm-extension-<v>-safari.zip` | input to the Xcode converter |
   | `oxdm-extension-<v>-sources.zip` | AMO source review |
   | `SHA256SUMS.txt` | checksums for all of the above |

5. Download and check the assets. Verify with
   `sha256sum -c SHA256SUMS.txt`.
6. Untick pre-release to promote it. That emits `released`, not
   `published`, so the workflow does not re-run and cannot overwrite the
   assets you just verified.

To test a change to the workflow itself without touching a release, run
it via **Actions → Release artifacts → Run workflow**. It builds the
same zips and leaves them as a workflow artifact instead of uploading
them anywhere.

## Privacy policy

`site/index.html` is published to GitHub Pages by
`.github/workflows/pages.yml` on every push to `main` that touches
`site/`.

The workflow passes `enablement: true` to `actions/configure-pages`, so
it turns Pages on itself the first time it runs. If that step still
reports *Get Pages site failed*, Pages is unavailable for the repository
rather than merely unconfigured: it needs a public repo, or a plan that
includes Pages for private ones. The manual equivalent is **Settings →
Pages → Build and deployment → Source → GitHub Actions**.

Both stores want the resulting URL
(`https://jd1378.github.io/oxdm_extensions/`). Keep it reachable for as
long as the extension is listed.

## Chrome Web Store

1. Register at
   [the developer dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time fee, payable once per account).
2. **Add new item**, upload the chrome zip. Save as draft; do not submit
   yet.
3. Copy the assigned extension ID. See "The extension ID" below: the
   native host will not work for store users until oxdm knows it.
4. Fill in the listing (description, category, screenshots at 1280x800
   or 640x400, the 128px icon).
5. Under **Privacy practices**, give the single-purpose description, the
   privacy policy URL, and a justification for each permission. Copy
   them from the tables below.
6. Submit. Expect a slow, human review: `cookies` plus broad host access
   plus `nativeMessaging` is a combination that gets read carefully.

## Firefox (AMO)

1. Sign in at
   [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).
2. Upload the firefox zip.
3. When asked whether the reviewer needs your sources, answer **yes** and
   upload the sources zip. The shipped code is bundled and minified, so
   this is required, not optional.
4. Give build instructions. What a reviewer needs:

   ```text
   Node 22, pnpm 10.1.0 (see packageManager in package.json)
   pnpm install --frozen-lockfile
   pnpm build:firefox        # output in .output/firefox-mv2/
   ```

5. Fill in the listing and submit.

The Firefox add-on ID is already fixed in `wxt.config.ts` as
`oxdm@jd1378.github.io`, and oxdm's native-host manifest already lists
it. Nothing to reconcile.

## Safari

`pnpm zip:safari` produces the extension, but a distributable Safari app
needs macOS: run Xcode's `safari-web-extension-converter` against
`.output/safari-mv2/`, then build and notarise the resulting app with an
Apple Developer account. None of that can happen in this repo's CI, and
this target is untested.

## The extension ID

Chrome derives the extension ID from a signing key, so it is not known
until upload, but oxdm's native-messaging manifest has to name it:

```json
"allowed_origins": ["chrome-extension://<32-char-id>/"]
```

Get the ID before you publish, either by creating the draft item and
reading it off the dashboard, or by generating a key yourself and adding
the public half to the manifest as `"key"`, which makes the ID
deterministic.

Then set it as the default for `oxdm/tools/install-native-host.sh
--chromium-id`. Keep your unpacked development ID in `allowed_origins`
alongside the published one; the field takes a list, and dropping the
dev ID breaks local testing.

## Store copy

### Single purpose

> Hands downloads from the browser to the oxdm download manager running
> on the same computer.

### Category

| Store | Choose | Why |
| --- | --- | --- |
| AMO | **Download Management** | An exact category match. AMO allows two; there is no second one that genuinely applies, and padding it with *Other* helps nobody. |
| Chrome | **Tools** | Chrome has no download category. *Tools* is the closest fit for a utility that does one mechanical job. *Workflow & Planning* is the defensible alternative, but it skews toward task and project managers. |

Chrome's categories changed in mid-2023; the pre-2023 *Productivity*
that download managers used to sit in no longer exists.

### Name

Chrome allows 45 characters. `oxdm` alone is accurate but invisible in
search, so prefer:

> oxdm Download Manager Integration

On AMO the add-on name can stay `oxdm`, since the Download Management
category already supplies the context.

### Short description

Chrome's summary field allows 132 characters:

> Sends browser downloads to the oxdm download manager running on your
> computer. Requires the oxdm desktop app.

AMO's summary allows 250:

> Hands your browser's downloads to oxdm, a download manager that runs
> on your own computer, together with the cookies and referrer needed
> for files behind a login. Requires the oxdm desktop application; this
> extension does nothing on its own.

### Full description

Works for both stores. AMO renders limited HTML, Chrome plain text, so
this is kept to plain paragraphs and bullets.

```text
oxdm Integration hands downloads from your browser to oxdm, a download
manager that runs on your own computer.

Requires the oxdm desktop application. Install it first from
https://github.com/jd1378/oxdm - this extension does nothing on its own.

What it does

- Intercepts downloads as they start and passes them to oxdm instead of
  the browser's downloader, along with the cookies, referrer and
  User-Agent a server needs for files behind a login.
- Adds "Download with oxdm" to the right-click menu, for a link, for
  text you have selected, or for every download link on the page.
- Shows a small button next to download links as you hover them.
- Select several links and send them at once. oxdm opens its own triage
  window so you can see what was found and choose what to keep.
- Choose whether oxdm asks first through its Add Download dialog, or
  queues the download immediately and starts it.
- Which downloads are captured - size threshold, file types, MIME types,
  skipped domains - is configured in oxdm itself, so there is one set of
  rules to maintain rather than two.

Privacy

No analytics, no telemetry, no accounts, no third-party services. The
extension talks only to oxdm at 127.0.0.1 on your own machine, and
nothing is sent anywhere else. Full policy:
https://jd1378.github.io/oxdm_extensions/

Open source, licensed AGPL-3.0:
https://github.com/jd1378/oxdm_extensions
```

Say up front that the desktop application is required. Both stores treat
"installs, appears broken" as a user-experience defect, and it is the
first thing a reviewer will hit.

### Permission justifications

Chrome asks for one per permission. These are also worth pasting into
the AMO notes-for-reviewer field.

| Permission | Justification |
| --- | --- |
| `downloads` | Detects a download starting in the browser and cancels it so oxdm can take it over. This interception is the extension's core feature. |
| `cookies` | Reads the cookies for the specific URL being downloaded and passes them to oxdm, so files behind a login are downloaded as the logged-in user rather than failing. Only cookies matching that one URL are read. |
| `nativeMessaging` | Sends the download to the local `oxdm-native-host` program, one of the two supported ways to reach the desktop application. |
| `storage` | Stores the user's own settings (pairing code, transport, toggles, chosen queue), rules cached from oxdm, and a local 100-entry diagnostic log shown on the Options page. |
| `tabs` | Reads the URL of the tab a download came from, to send as the referrer. Many hosts reject a download without a correct referrer. Also used to tell content scripts whether oxdm is currently reachable. |
| `contextMenus` | Adds the "Download with oxdm" right-click entry for links, selections and pages. |
| `notifications` | Shows a notification when oxdm refuses a download, so a rejected download is not silently lost. |
| Host permission `<all_urls>` | A download can begin on any site, so the extension cannot know in advance which sites to watch. Access is used only to detect download links on the page and to read cookies for a file the user is downloading. No page content is collected or transmitted. |

### Remote code

Both stores ask. The answer is **no**: everything ships in the package,
nothing is fetched or evaluated at runtime.

### Data handling

Declare no collection and no transfer. The only network destination is
`127.0.0.1` on the user's own machine. See `site/index.html` for the
full statement.
