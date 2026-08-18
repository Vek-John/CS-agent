# Third-party notices

This file records the limited upstream audit for localhost replay integrations. It
does not grant rights to map or game assets.

## MIT code references

### cs-net

Repository: local pinned checkout `/Users/vekel/编程/CS-agent/.local-data/upstream/cs-net`

Audited commit: `e15acc3fda3de21f25fe12a5ca31722381f40162`

License: MIT. The integration uses the upstream win-rate model contract and
checkpoint as a separately recorded asset. It does not import `demoparser2`,
copy the upstream parser, or copy the upstream source tree into the product.
The repository-owned TypeScript feature adapter consumes only the pinned
cs2d structured Replay port. The exported ONNX asset is recorded at
`apps/web/public/generated-assets/models/cs-net/manifest.json` with its SHA,
revision, temperature, and size.

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

## cs2d source reference and Cloudflare build

Repository: <https://github.com/zenojunior/cs2d>

Pinned commit: `dbbe698c9b9c91f9a14cecea92374b4114bf60ec`

The host clones that exact upstream commit into the ignored
`.local-data/upstream/cs2d` directory and applies the ordered patches in
`tools/cs2d-host/patches/`. The repository did not contain a `LICENSE`, package
license, or other explicit grant when audited on 2026-08-14. Consequently the
upstream source is not vendored into this repository. CI currently builds the
pinned Viewer and places its generated `/cs2d/` runtime plus required map,
weapon, and WASM assets in the Cloudflare release; this is an explicit
temporary deployment decision, not a claim that the upstream is MIT or otherwise
redistributable. Before public commercialization or wider redistribution, obtain
permission, record a license, or replace the substrate.

The patches add the compact 5+5 HUD, local host bridge, retention of the Source
engine `m_szLastPlaceName` fact, a link to the repository-owned
`@cs-coach/cs2d-analysis-adapter`, and the `/cs2d/` production base. Raw Replay
data remains inside the iframe and `.dem` bytes stay in the user's browser.
`pnpm cs2d:setup` can rebuild the modified parser WASM locally; CI uses the
pinned generated parser artifact from the patch and builds the Viewer. This is
the accepted browser source-reference substrate,
but it is not approved for public redistribution until the upstream license is
clarified or replaced.
