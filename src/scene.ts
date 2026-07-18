import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene — asset URLs, spawn, and the tuning knobs the
// debug panel edits — lives here, so swapping in a new world or retuning the feel is a
// one-file edit. Per-system "how it works" constants stay in their own modules.

// --- Assets (served from public/) ---
// BASE_URL is '/' in dev and '/<repo>/' for a GitHub Pages build (vite.config.ts),
// so these resolve whether served from the domain root or a project subpath.
const BASE = import.meta.env.BASE_URL;

// Swap the world here: a Gaussian splat + an invisible collider mesh (.glb).
// The splat is a streaming-LOD `.rad` pre-built from the source `attic.spz` with Spark's
// build-lod tool (`pnpm build:lod`); it streams coarse-to-fine over HTTP Range requests
// instead of blocking the first frame on a full download.
export const SPLAT_URL = `${BASE}attic-lod.rad`;
export const COLLIDER_URL = `${BASE}collider.glb`;
// Equirectangular pano baked into a PMREM env map (character + reflector-ball reflections).
export const PANO_URL = `${BASE}pano.jpg`;

// Swap the character here: any animated GLB with idle, walk, air-idle, and trick clips.
export const CHARACTER_URL = `${BASE}dog.glb`;
// Clip names expected inside CHARACTER_URL — retune if your model names them differently.
export const CLIP_HAPPY_IDLE = 'Happy Idle';
export const CLIP_AIR_IDLE = 'Idle';
export const CLIP_WALK = 'Brutal To';
export const CLIP_TRICK = 'Step Hip Hop';
export const TRICK_DURATION_MS = 2000;

// --- Physics ---
export const GRAVITY: Vec3 = [0, -25, 0];
// The splat + collider GLBs are authored ~5× smaller than the physics/character scale,
// so both are uniformly scaled up on load (changing COLLIDER_SCALE rebakes the trimesh).
export const SPLAT_SCALE = 5;
export const COLLIDER_SCALE = 5;

// --- Character spawn (feet, world space) ---
// Origin is clear floor (walkable slab top sits at y≈0.2 after the 5× collider scale);
// the character drops the short distance and the float spring settles it on the ground.
export const CHARACTER_SPAWN: Vec3 = [0, 4, -13];

// Cap on the renderer device-pixel-ratio — keeps Spark's per-pixel splat sort/blend
// cost bounded on Retina/hi-DPI screens.
export const MAX_DPR = 2;

// --- Navigation (dynamic navmesh) ---
// Recast-style tile config for building the navmesh from the collider trimesh. World
// units (this scene is at 5× scale), so cells/tiles are larger than navcat's unit-scale
// example. This is the main thing to retune if the navmesh looks wrong (too coarse /
// missing floor / agents float). Cells dominate cost + precision; tileSizeVoxels sets
// how much each live rebuild touches.
export const NAV_CONFIG = {
    cellSize: 0.3,
    cellHeight: 0.3,
    tileSizeVoxels: 32,
    walkableRadiusWorld: 0.4, // agent radius the floor is eroded by (fits creatures + player)
    walkableClimbWorld: 0.5, // max step-up; anything taller (a ball) blocks
    walkableHeightWorld: 1.0, // min ceiling clearance to be walkable
    walkableSlopeAngleDegrees: 45,
    borderSize: 4,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 5,
    detailSampleDistance: 6,
    detailSampleMaxError: 1,
    tileRebuildThrottleMs: 250, // min time between rebuilds of the same tile
};
// Rebuilds are paced on the main thread — at most this many tiles rebuild per step.
export const NAV_MAX_TILES_PER_FRAME = 1;

// --- Creatures (the little guys that follow you) ---
export const CREATURE_COUNT = 7;

// --- Tuning (edited live by the lil-gui debug panel; see debug.ts) ---
// Grouped by subsystem. These are the values the various update()s read each frame,
// so nudging one in the panel takes effect immediately.
export type Tuning = {
    // movement
    moveSpeed: number;
    sprintMultiplier: number;
    jumpVelocity: number;
    airControlFactor: number;
    turnSpeed: number;

    // character mesh layout / animation
    characterHeight: number;
    characterYawDeg: number;
    walkSpeedThreshold: number;
    walkAnimTimeScale: number;
    sprintWalkAnimMultiplier: number;
    animGroundReleaseHold: number;
    animWalkSpeedSmoothing: number;
    animCrossfade: number;

    // camera follow
    cameraTargetYOffset: number;

    // lighting + shadows
    ambientIntensity: number;
    sunIntensity: number;
    sunColor: number;
    sunFollowCharacter: boolean;
    sunOffset: Vec3;
    shadowMapSize: number;
    shadowRadius: number;
    shadowIntensity: number;
    shadowCameraHalfExtent: number;
    shadowCameraNear: number;
    shadowCameraFar: number;
    colliderShadowOpacity: number;

    // post-processing
    ppEnabled: boolean;
    ppBloomIntensity: number;
    ppBloomThreshold: number;
    ppBloomSmoothing: number;
    ppBrightness: number;
    ppContrast: number;
    ppVignetteDarkness: number;
    ppVignetteOffset: number;

    // debug
    showPhysicsDebug: boolean;
    showNavMesh: boolean;
};

// Character capsule total height (metres): cylinder + two radius hemispheres. Shared by
// the physics capsule (character.ts) and the default mesh height below.
export const CHARACTER_CAPSULE_HEIGHT = 3;

export function createTuning(): Tuning {
    return {
        moveSpeed: 8,
        sprintMultiplier: 1.6,
        jumpVelocity: 9,
        airControlFactor: 0.2,
        turnSpeed: 10, // exponential ease rate toward the move direction (higher = snappier)

        characterHeight: CHARACTER_CAPSULE_HEIGHT,
        characterYawDeg: 0,
        walkSpeedThreshold: 0.4,
        walkAnimTimeScale: 1.7,
        sprintWalkAnimMultiplier: 1.4,
        animGroundReleaseHold: 0.11,
        animWalkSpeedSmoothing: 10,
        animCrossfade: 0.28,

        cameraTargetYOffset: CHARACTER_CAPSULE_HEIGHT * 0.74,

        ambientIntensity: 0.9,
        sunIntensity: 1.62,
        sunColor: 0xffe8c9,
        sunFollowCharacter: true,
        sunOffset: [-15.5, 102, 12],
        shadowMapSize: 2048,
        shadowRadius: 8,
        shadowIntensity: 1,
        shadowCameraHalfExtent: 25,
        shadowCameraNear: 1,
        shadowCameraFar: 120,
        colliderShadowOpacity: 0.3,

        ppEnabled: true,
        ppBloomIntensity: 0.75,
        ppBloomThreshold: 0.29,
        ppBloomSmoothing: 0.5,
        ppBrightness: -0.1,
        ppContrast: 0.1,
        ppVignetteDarkness: 0.57,
        ppVignetteOffset: 0.5,

        showPhysicsDebug: false,
        showNavMesh: false,
    };
}
