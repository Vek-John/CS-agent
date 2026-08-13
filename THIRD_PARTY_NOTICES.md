# Third-party notices

This file records the limited upstream audit for the isolated replay PoC. It
does not grant rights to map or game assets.

## MIT code references

### csfreezetime

Repository: <https://github.com/benginN/csfreezetime>

Audited commit: `dcf6a20e89dd11f7b3440a38c9e130d086566268`

License: MIT. Copyright (c) 2026 Orhan Bengin Epözdemir.

The PoC did not copy the 2,198-line `ReplayView.tsx` or other source files.
The audit informed the minimal radar/player/grenade layer split only.

### csgo-2d-demo-viewer

Repository: <https://github.com/sparkoo/csgo-2d-demo-viewer>

Audited commit: `0765bf613131a4fd5f88ed034bd9bc41bfb31e7e`

License: MIT. Copyright (c) 2023 Michal Vala.

The audit informed worker/protocol/player separation only. No source code,
parser, UI, or assets were copied.

### PixiJS

Package: `pixi.js@8.6.0`, installed as a normal workspace dependency for the
opt-in `/pixi-poc` route. PixiJS is distributed under the MIT License by its
upstream authors; its package license and notices remain in the installed
dependency tree and lockfile.

## Map and game assets

The local Mirage radar is not covered by the MIT code references above. The
renderer uses the project's existing version-pinned manifest:

- raster: `apps/web/public/generated-assets/maps/de_mirage.png`
- dimensions: `1024 × 1024`
- SHA-256:
  `c8032f6c83ffca63c0a20ebdcc598a0e1aa618efd746e381e2db26f33a4a964f`
- manifest source: awpy-data release `2000883`, as recorded by
  `@cs-coach/map-semantics`
- rights status: local-cache/localhost use with distribution review pending;
  Valve map/game asset rights are separate from the MIT code licenses above.

No csfreezetime or cs2replays radar image, game icon, brand, or proprietary
asset is copied.
