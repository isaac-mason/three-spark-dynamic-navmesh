# three-spark-dynamic-navmesh

## Quick start

```bash
pnpm install
pnpm dev      # → http://localhost:5173
```

```bash
pnpm build    # tsc + vite build
pnpm preview
pnpm check    # biome format + lint (--write)
```

## Building the LOD splat

The runtime loads `public/attic-lod.rad` — a streaming-LOD [`.rad`](https://sparkjs.dev/)
pre-built from the source `public/attic.spz` with Spark's `build-lod` tool. It streams
coarse-to-fine over HTTP Range requests instead of blocking the first frame on the full
download. Rebuild it with:

```bash
pnpm build:lod            # public/attic.spz → public/attic-lod.rad (quality mode)
pnpm build:lod public/attic.spz --quick
```

`build-lod` is a Rust binary that isn't published to npm. A prebuilt macOS-arm64 copy is
vendored at `tools/build-lod`; on other platforms, build it from a
[Spark checkout](https://github.com/sparkjsdev/spark)
(`cd spark/rust && cargo build --release -p build-lod`) and point the script at it via
`SPARK_BUILD_LOD=…` or `SPARK_DIR=…` (see `scripts/build-lod.mjs`).

## Layout

- `src/scene.ts` — asset URLs, spawn, and the live-tunable `Tuning` (the debug panel edits it).
- `src/physics.ts` — crashcat world, collision layers, and shared body helpers.
- `src/character.ts` — the floating character controller (ported from crashcat's example).
- `src/controls.ts` — keyboard input + the third-person orbit-follow camera.
- `src/character-visuals.ts` — the animated GLB, its layout, and the idle/walk/air/trick state machine.
- `src/world.ts` — the Spark splat + the collider GLB (physics trimesh + shadow catcher).
- `src/lighting.ts` — ambient + character-following sun and shadows.
- `src/reflections.ts` — pano PMREM env map + the dynamic reflector balls.
- `src/postprocessing.ts` — the bloom / vignette / brightness-contrast pass.
- `src/debug.ts` — the lil-gui panel + crashcat wireframe debug renderer.
- `src/index.ts` — `init()` / `load()` / `update()` orchestration.

Swap the world by replacing `public/attic.spz` + `public/collider.glb` and the URLs in
`scene.ts`; swap the character by replacing `public/dog.glb` and the `CLIP_*` names.
