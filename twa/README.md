# Iron Dominion Android APK (Trusted Web Activity)

The APK is a thin Android wrapper (a Trusted Web Activity) around the hosted PWA. It shows the same game, uses the same IndexedDB saves inside Chrome's storage, and updates whenever the site updates. Build it on your own machine with Bubblewrap; nothing here is built in CI.

Files in this folder:

- `twa-manifest.json`: Bubblewrap project file, pre-filled for the GitHub Pages root build.
- `assetlinks.template.json`: Digital Asset Links template (see below).

## Values to check before you build

In `twa-manifest.json`:

| Field | Value now | Change when |
| --- | --- | --- |
| `host` | `mikkeymoo.github.io` | you move to a custom domain |
| `startUrl` | `/iron-dominion/` | you serve from a domain root (`/`) or want the preview (`/iron-dominion/next/`) |
| `fullScopeUrl`, `webManifestUrl`, `iconUrl`, `maskableIconUrl` | `https://mikkeymoo.github.io/iron-dominion/...` | the host or path changes |
| `packageId` | `io.github.mikkeymoo.irondominion` | you want another Android package name (cannot change after you publish) |

## Build steps (your machine)

1. Install Node.js 22 or newer, then Bubblewrap: `npm i -g @bubblewrap/cli`.
2. Run `bubblewrap doctor`. It offers to download a JDK and the Android SDK; accept both, or point it at existing installs.
3. In a new empty folder, initialise from the live manifest (the game must be deployed first):
   `bubblewrap init --manifest https://mikkeymoo.github.io/iron-dominion/manifest.webmanifest`
   Answer the prompts. Keep the package id `io.github.mikkeymoo.irondominion`. Let it create a signing key and keep `android.keystore` and its passwords safe: losing them means you cannot update an installed APK.
   To start from the pre-filled file instead, copy `twa/twa-manifest.json` into that folder and run `bubblewrap update`.
4. Build: `bubblewrap build`. It writes `app-release-signed.apk` (and an `.aab` for the Play Store).
5. Print the signing fingerprint for the next section: `bubblewrap fingerprint list` (or `keytool -list -v -keystore android.keystore`, SHA-256 line).
6. Install on the phone:
   - With adb: enable Developer options and USB debugging, connect the phone, then `adb install app-release-signed.apk` (`bubblewrap install` does the same).
   - Without adb: copy the APK to the phone (USB, cloud drive, email), open it from the Files app and allow "Install unknown apps" for that app when Android asks.

## Digital Asset Links (full-screen, no URL bar)

A TWA only hides Chrome's address bar when the site proves it belongs to the app. Chrome fetches

    https://<host>/.well-known/assetlinks.json

and looks for your package name and signing-key SHA-256 fingerprint. Fill in `assetlinks.template.json` (replace the placeholder fingerprint) and publish it at that exact path on the host.

**A GitHub project page cannot serve that path.** `mikkeymoo.github.io/iron-dominion` lives under `/iron-dominion/`, and Chrome only checks the domain root: `https://mikkeymoo.github.io/.well-known/assetlinks.json`. Your options:

1. A user-site repo. Create the repo `mikkeymoo/mikkeymoo.github.io`, enable Pages on it, and add `.well-known/assetlinks.json` (GitHub Pages serves dot-folders only if the repo has an empty `.nojekyll` file at its root, so add one). The game stays at `/iron-dominion/`; keep `host` as `mikkeymoo.github.io`.
2. A custom domain (for example `irondominion.example`) pointed at Pages, with the game at the domain root or a path and `assetlinks.json` under that domain's `.well-known/`. Update `host`, `startUrl` and the URLs in `twa-manifest.json`, then rebuild.

Without a valid `assetlinks.json` the APK still installs and runs the game, but Chrome falls back to a Custom Tab with a browser URL bar at the top. That fallback is `"fallbackType": "customtabs"` in `twa-manifest.json`. Saves still work either way.

## After the first install

- Game updates ship by deploying the site; the APK does not need a rebuild. The in-game "Update available" toast appears when a new build is waiting.
- Rebuild the APK only for icon, name, colour or package changes. Bump `appVersion` and `appVersionCode` first.
- The signing key you use for sideloading must be the one in `assetlinks.json`. If you ever upload to the Play Store with Play App Signing, add Play's fingerprint to the `sha256_cert_fingerprints` list as well.
