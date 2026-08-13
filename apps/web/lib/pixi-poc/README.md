# PixiJS replay PoC boundary

This is an isolated, opt-in route at `/pixi-poc`. It does not replace the
existing AI coaching canvas or `replay-viewer.tsx`.

## Upstream audit and scope

- `benginN/csfreezetime` at commit
  `dcf6a20e89dd11f7b3440a38c9e130d086566268` (MIT): audit scope was
  `apps/web/src/components/ReplayView.tsx`, `apps/web/src/lib/mapbase.ts`, and
  the radar/player/grenade types in `apps/web/src/api.ts`. The PoC reuses no
  source files; it only implements a small typed layer boundary inspired by
  the radar/player/grenade responsibilities.
- `sparkoo/csgo-2d-demo-viewer` at commit
  `0765bf613131a4fd5f88ed034bd9bc41bfb31e7e` (MIT): audit scope was
  `web/public/worker.js`, `web/src/Player/MessageBus.js`,
  `web/src/Player/Player.js`, `protos/Message.proto`, and
  `parser/pkg/parser/map.go`. Only protocol/layer separation was considered;
  no old UI or parser code is copied.
- `cs2replays` was used only as a public behavior reference. No JS/WASM,
  product UI, API, report, ML, database, heatmap, or proprietary asset is
  copied.
- PixiJS is consumed from the pinned npm dependency `pixi.js@8.6.0`; see
  [`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md).

## Local data flow

`ReplayBundle JSON → toGroundTruthReplaySource (one index pass) →
buildOmniscientFrame` or `ObservationBoundaryInput → buildKnowledgeFrame` →
`PixiPlaybackLayer.update(PlaybackFrameViewModel)`.

The layer public update method accepts only `PlaybackFrameViewModel`. It does
not accept `ReplayBundle`, `ReplayViewModel`, `PlayerStateSample`, or
`ObservableState`. A knowledge frame cannot be built from a GroundTruth source;
it receives only observer-scoped state and typed, claim-proven display slots.

## Current PoC limits

- It loads the generated local `test_demo.replay.json` and shows its first
  complete round. The parser remains the worker owner; the browser does not
  parse `.dem`.
- PLAYER_KNOWLEDGE is empty apart from self/direct-claim data when the bundle
  has no valid `ObservableState`; it never hides omniscient actors after the
  fact.
- Visual asset rights are separate from MIT code rights. Mirage uses the
  repository's version-pinned local radar manifest and hash; no radar is
  redistributed by the upstream MIT notices.
