# MiChelly — personal webOS client for Jellyfin

This is a **personal fork** of [`jellyfin/jellyfin-webos`](https://github.com/jellyfin/jellyfin-webos),
imported verbatim at version **1.2.2** (upstream commit `ab4794046467cdb88212ccc29212300cf9112a43`).
It is maintained for a personal **webOS 3.0** TV.

It is a small wrapper around the web interface provided by the server
(https://github.com/jellyfin/jellyfin-web) so most of the development happens there. The app shows a
server picker, auto-discovers Jellyfin servers on the LAN through a bundled Luna service, and then
hands off to the jellyfin-web UI hosted by the user's Jellyfin server inside an iframe.

- Documentation entry point: [`docs/project.md`](docs/project.md)
- webOS 3.0 compatibility report: [`docs/context/webos-3-compatibility.md`](docs/context/webos-3-compatibility.md)
- Fork provenance and how to sync with upstream: [`docs/context/upstream-provenance.md`](docs/context/upstream-provenance.md)

## Download

The upstream app is available on the LG Content Store:
<p align="center">
<a href="https://us.lgappstv.com/main/tvapp/detail?appId=1030579"><img alt="Enjoy on LG Smart TV" src="https://repo.jellyfin.org/releases/other/lg-badge/LG_BADGE_greyborders_135x40.png"/></a>
<br/>
<em><strong>Note:</strong> If you previously installed the app via Homebrew or Developer mode, you must uninstall that before you can use the store version.</em>
</p>

This fork is **not** distributed through the store; it is built locally and installed via Developer
mode or Homebrew Channel (see [`docs/context/hbc-distribution-plan.md`](docs/context/hbc-distribution-plan.md)).

## License

All Jellyfin webOS code is licensed under the MPL 2.0 license, some parts incorporate content
licensed under the Apache 2.0 license. All images are taken from and licensed under the same license
as https://github.com/jellyfin/jellyfin-ux.

---

## Development

The general development workflow looks like this:

- Prepare a build environment of your choice (see below)
- Compile an IPK either with the IDE or with ares-package
- Test the app on the emulator or ares-server, or install it on your TV by following
  http://webostv.developer.lge.com/develop/app-test/

There are three ways to create the required build environment:

- Full WebOS SDK Installation
- Docker
- NPM ares-cli

### Managing the ares-tools via npm (recommended here)

This requires `npm`, the Node.js package manager.

Install the required WebOS toolkit for building & deployment:

```sh
npm install
```

Validate and package the app:

```sh
npm run check     # ares-package --check
npm run package   # ares-package --no-minify --outdir build/ services frontend
```

This produces `build/com.daverui.michelly_<version>_all.ipk`. Generate the Homebrew manifest (which
contains the IPK's sha256) with:

```sh
npm run manifest  # node tools/gen-manifest.js build/com.daverui.michelly.manifest.json
```

Version handling: bump `version` in `package.json`, then run `npm run version` to copy it into
`frontend/appinfo.json`.

### Full WebOS SDK Installation

- Install the WebOS SDK from http://webostv.developer.lge.com/sdk/installation/

### Docker

A prebuilt docker image is available that includes the build and deployment dependencies, see
[Docker Hub](https://ghcr.io/oddstr13/docker-tizen-webos-sdk).

```sh
# Build the package via Docker
./dev.sh ares-package --no-minify services frontend
# Build the package with a natively installed WebOS SDK
ares-package --no-minify services frontend
```

## Usage

Fill in your hostname, port and scheme and click connect. The app checks for a server by grabbing the
manifest and the public server info. Afterwards, the app hands off control to the hosted web UI.

## Testing

Testing on a TV requires
[registering a LG developer account](https://webostv.developer.lge.com/develop/app-test/preparing-account/)
and [setting up the devmode app](https://webostv.developer.lge.com/develop/app-test/using-devmode-app/).

Once you have installed the devmode app on your target TV and logged in with your LG developer
account, you need to turn on the `Dev Mode Status` and `Key Server`.
**Make sure** to take a note of the passphrase.

```sh
# Add your TV. The defaults are fine, but I recommend naming it `tv`.
./dev.sh ares-setup-device --search

# This command sets up the SSH key for the device `tv` (Key Server must be running)
./dev.sh ares-novacom --device tv --getkey

# Run this command to verify that things are working.
./dev.sh ares-device-info -d tv

# This command installs the app. Remember to build it first.
./dev.sh ares-install -d tv com.daverui.michelly_*.ipk

# Launch the app and the web developer console.
./dev.sh ares-inspect -d tv com.daverui.michelly

# Or just launch the app.
./dev.sh ares-launch -d tv com.daverui.michelly
```

Without Docker, the npm aliases wrap the same tools:

```sh
npm run deploy    # ares-install build/com.daverui.michelly_<version>_all.ipk
npm run launch    # ares-launch com.daverui.michelly
```

## Attribution

This repository is a fork of [jellyfin/jellyfin-webos](https://github.com/jellyfin/jellyfin-webos).
Upstream code is imported verbatim; `LICENSE` and `CONTRIBUTORS.md` are kept unchanged. See
[`docs/context/upstream-provenance.md`](docs/context/upstream-provenance.md) for the sync and
divergence policy.
