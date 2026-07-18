import { type Box3, box3, type Vec3, vec2 } from 'mathcat';
import {
    addTile,
    BuildContext,
    buildCompactHeightfield,
    buildContours,
    buildDistanceField,
    buildPolyMesh,
    buildPolyMeshDetail,
    buildRegions,
    buildTile,
    ContourBuildFlags,
    calculateGridSize,
    calculateMeshBounds,
    createFindNearestPolyResult,
    createHeightfield,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    erodeWalkableArea,
    filterLedgeSpans,
    filterLowHangingWalkableObstacles,
    filterWalkableLowHeightSpans,
    findNearestPoly,
    markWalkableTriangles,
    type NavMesh,
    polyMeshDetailToTileDetailMesh,
    polyMeshToTilePolys,
    rasterizeSphere,
    rasterizeTriangles,
    removeTile,
    WALKABLE_AREA,
} from 'navcat';
import { crowd } from 'navcat/blocks';
import { createNavMeshHelper, type DebugObject } from 'navcat/three';
import type * as THREE from 'three';
import { NAV_CONFIG } from './scene';

// Dynamic navmesh + crowd. The navmesh is built from the collider trimesh into tiles at
// load, then individual tiles are recomputed on the main thread as dynamic obstacles (the
// reflector balls) move — navcat's dynamic-navmesh pattern. Steering runs through a navcat
// crowd; the player is a target-less proxy agent so the creatures avoid + home in on it.

const CROWD_MAX_AGENT_RADIUS = 1.5; // ≥ the largest agent radius (player proxy + creatures)
const FIND_HALF_EXTENTS: Vec3 = [1, 2, 1];

// The player proxy — bigger than the character capsule so the creatures keep a comfortable
// berth around you (more "presence"). Must stay ≤ CROWD_MAX_AGENT_RADIUS above.
const PLAYER_AGENT_RADIUS = 1.5;
const PLAYER_AGENT_HEIGHT = 1.5;

const tileKey = (x: number, y: number) => `${x}_${y}`;

// A dynamic obstacle carves a hole in the navmesh where it sits (rasterized as a sphere).
type NavObstacle = {
    /** Current world position, written into the out array. */
    getPosition: (out: Vec3) => void;
    radius: number;
    /** Whether the obstacle is still moving — sleeping bodies stop dirtying tiles. */
    isMoving: () => boolean;
    lastPosition: Vec3;
    lastTiles: Set<string>;
};

// Heavy per-navmesh build state (config, per-tile static caches, dirty tracking).
type NavBuild = {
    buildCtx: ReturnType<typeof BuildContext.create>;
    positions: Float32Array;
    indices: Uint32Array;
    meshBounds: Box3;
    config: {
        tileSizeWorld: number;
        walkableRadiusVoxels: number;
        walkableClimbVoxels: number;
        walkableHeightVoxels: number;
        detailSampleDistanceWorld: number;
        detailSampleMaxErrorWorld: number;
        tileWidth: number;
        tileHeight: number;
    };
    caches: {
        expandedBounds: Map<string, Box3>;
        staticTriangles: Map<string, number[]>;
        staticHeightfields: Map<string, ReturnType<typeof createHeightfield>>;
    };
    tracking: {
        obstacles: NavObstacle[];
        tileToObstacles: Map<string, Set<number>>;
        dirtyTiles: Set<string>;
        rebuildQueue: Array<[number, number]>;
        tileLastRebuilt: Map<string, number>;
    };
};

export type Navigation = {
    navMesh: NavMesh | null;
    crowd: crowd.Crowd | null;
    playerAgentId: string | null;
    build: NavBuild | null;
    navMeshHelper: DebugObject | null;
    /** Set when a tile rebuilds so the debug helper refreshes. */
    debugDirty: boolean;
};

export function initNavigation(): Navigation {
    return { navMesh: null, crowd: null, playerAgentId: null, build: null, navMeshHelper: null, debugDirty: false };
}

/**
 * Build the tiled navmesh from a world-space triangle soup (the collider — see world.ts),
 * pre-caching each tile's static heightfield, then build every tile once. Also creates the
 * crowd. Call from load() after the collider is baked.
 */
export function buildNavigation(navigation: Navigation, positionsArray: number[], indicesArray: number[]): void {
    const positions = new Float32Array(positionsArray);
    const indices = new Uint32Array(indicesArray);

    const buildCtx = BuildContext.create();
    const navMesh = createNavMesh();
    const meshBounds = calculateMeshBounds(box3.create(), positions, indices);

    const cs = NAV_CONFIG.cellSize;
    const ch = NAV_CONFIG.cellHeight;
    const tileSizeWorld = NAV_CONFIG.tileSizeVoxels * cs;
    const walkableRadiusVoxels = Math.max(0, Math.ceil(NAV_CONFIG.walkableRadiusWorld / cs));
    const walkableClimbVoxels = Math.max(0, Math.ceil(NAV_CONFIG.walkableClimbWorld / ch));
    const walkableHeightVoxels = Math.max(0, Math.ceil(NAV_CONFIG.walkableHeightWorld / ch));
    const detailSampleDistanceWorld = NAV_CONFIG.detailSampleDistance < 0.9 ? 0 : cs * NAV_CONFIG.detailSampleDistance;
    const detailSampleMaxErrorWorld = ch * NAV_CONFIG.detailSampleMaxError;

    const gridSize = calculateGridSize(vec2.create(), meshBounds, cs);
    const tileWidth = Math.max(1, Math.floor((gridSize[0] + NAV_CONFIG.tileSizeVoxels - 1) / NAV_CONFIG.tileSizeVoxels));
    const tileHeight = Math.max(1, Math.floor((gridSize[1] + NAV_CONFIG.tileSizeVoxels - 1) / NAV_CONFIG.tileSizeVoxels));

    navMesh.tileWidth = tileSizeWorld;
    navMesh.tileHeight = tileSizeWorld;
    box3.min(navMesh.origin, meshBounds);

    const build: NavBuild = {
        buildCtx,
        positions,
        indices,
        meshBounds,
        config: {
            tileSizeWorld,
            walkableRadiusVoxels,
            walkableClimbVoxels,
            walkableHeightVoxels,
            detailSampleDistanceWorld,
            detailSampleMaxErrorWorld,
            tileWidth,
            tileHeight,
        },
        caches: { expandedBounds: new Map(), staticTriangles: new Map(), staticHeightfields: new Map() },
        tracking: {
            obstacles: [],
            tileToObstacles: new Map(),
            dirtyTiles: new Set(),
            rebuildQueue: [],
            tileLastRebuilt: new Map(),
        },
    };

    // Per-tile: filter the triangle soup to the (border-expanded) tile box, then
    // pre-rasterize just the static geometry into a cached heightfield (reused every rebuild).
    const borderOffset = NAV_CONFIG.borderSize * cs;
    const hfSize = Math.floor(NAV_CONFIG.tileSizeVoxels + NAV_CONFIG.borderSize * 2);
    const triA: Vec3 = [0, 0, 0];
    const triB: Vec3 = [0, 0, 0];
    const triC: Vec3 = [0, 0, 0];

    for (let tx = 0; tx < tileWidth; tx++) {
        for (let ty = 0; ty < tileHeight; ty++) {
            const key = tileKey(tx, ty);
            const minX = meshBounds[0] + tx * tileSizeWorld;
            const minZ = meshBounds[2] + ty * tileSizeWorld;
            const maxX = meshBounds[0] + (tx + 1) * tileSizeWorld;
            const maxZ = meshBounds[2] + (ty + 1) * tileSizeWorld;
            const expanded: Box3 = [
                minX - borderOffset,
                meshBounds[1],
                minZ - borderOffset,
                maxX + borderOffset,
                meshBounds[4],
                maxZ + borderOffset,
            ];
            build.caches.expandedBounds.set(key, expanded);

            const tris: number[] = [];
            for (let i = 0; i < indices.length; i += 3) {
                const a = indices[i];
                const b = indices[i + 1];
                const c = indices[i + 2];
                triA[0] = positions[a * 3];
                triA[1] = positions[a * 3 + 1];
                triA[2] = positions[a * 3 + 2];
                triB[0] = positions[b * 3];
                triB[1] = positions[b * 3 + 1];
                triB[2] = positions[b * 3 + 2];
                triC[0] = positions[c * 3];
                triC[1] = positions[c * 3 + 1];
                triC[2] = positions[c * 3 + 2];
                if (box3.intersectsTriangle3(expanded, triA, triB, triC)) tris.push(a, b, c);
            }
            build.caches.staticTriangles.set(key, tris);

            const heightfield = createHeightfield(hfSize, hfSize, expanded, cs, ch);
            if (tris.length > 0) {
                const areaIds = new Uint8Array(tris.length / 3);
                markWalkableTriangles(positions, tris, areaIds, NAV_CONFIG.walkableSlopeAngleDegrees);
                rasterizeTriangles(buildCtx, heightfield, positions, tris, areaIds, walkableClimbVoxels);
            }
            build.caches.staticHeightfields.set(key, heightfield);
        }
    }

    navigation.navMesh = navMesh;
    navigation.build = build;
    navigation.crowd = crowd.create(CROWD_MAX_AGENT_RADIUS);
    navigation.crowd.agentPlacementHalfExtents = [2, 4, 2];

    // Build every tile once.
    for (let tx = 0; tx < tileWidth; tx++) {
        for (let ty = 0; ty < tileHeight; ty++) buildTileAtCoords(navigation, tx, ty);
    }
    console.log(`navmesh: built ${tileWidth * tileHeight} tiles (${tileWidth}×${tileHeight})`);
}

// Recompute one tile: clone its cached static heightfield, rasterize the dynamic obstacles
// overlapping it (as spheres), run the Recast pipeline, and swap the tile in the navmesh.
function buildTileAtCoords(navigation: Navigation, tx: number, ty: number): void {
    const build = navigation.build;
    const navMesh = navigation.navMesh;
    if (!build || !navMesh) return;
    const key = tileKey(tx, ty);

    const cached = build.caches.staticHeightfields.get(key);
    if (!cached) return;
    const heightfield = structuredClone(cached);

    const obstacles = build.tracking.tileToObstacles.get(key);
    if (obstacles && obstacles.size > 0) {
        const _c: Vec3 = [0, 0, 0];
        for (const idx of obstacles) {
            const obs = build.tracking.obstacles[idx];
            if (!obs) continue;
            obs.getPosition(_c);
            rasterizeSphere(heightfield, _c, obs.radius, WALKABLE_AREA, build.config.walkableClimbVoxels, build.buildCtx);
        }
    }

    filterLowHangingWalkableObstacles(heightfield, build.config.walkableClimbVoxels);
    filterLedgeSpans(heightfield, build.config.walkableHeightVoxels, build.config.walkableClimbVoxels);
    filterWalkableLowHeightSpans(heightfield, build.config.walkableHeightVoxels);

    const chf = buildCompactHeightfield(
        build.buildCtx,
        build.config.walkableHeightVoxels,
        build.config.walkableClimbVoxels,
        heightfield,
    );
    erodeWalkableArea(build.config.walkableRadiusVoxels, chf);
    buildDistanceField(chf);
    buildRegions(build.buildCtx, chf, NAV_CONFIG.borderSize, NAV_CONFIG.minRegionArea, NAV_CONFIG.mergeRegionArea);

    const contourSet = buildContours(
        build.buildCtx,
        chf,
        NAV_CONFIG.maxSimplificationError,
        NAV_CONFIG.maxEdgeLength,
        ContourBuildFlags.CONTOUR_TESS_WALL_EDGES,
    );
    const polyMesh = buildPolyMesh(build.buildCtx, contourSet, NAV_CONFIG.maxVerticesPerPoly);
    for (let p = 0; p < polyMesh.nPolys; p++) {
        if (polyMesh.areas[p] === WALKABLE_AREA) polyMesh.areas[p] = 0;
        if (polyMesh.areas[p] === 0) polyMesh.flags[p] = 1;
    }
    const polyMeshDetail = buildPolyMeshDetail(
        build.buildCtx,
        polyMesh,
        chf,
        build.config.detailSampleDistanceWorld,
        build.config.detailSampleMaxErrorWorld,
    );

    const tilePolys = polyMeshToTilePolys(polyMesh);
    const tileDetail = polyMeshDetailToTileDetailMesh(tilePolys.polys, polyMeshDetail);

    const tile = buildTile({
        bounds: polyMesh.bounds,
        vertices: tilePolys.vertices,
        polys: tilePolys.polys,
        detailMeshes: tileDetail.detailMeshes,
        detailVertices: tileDetail.detailVertices,
        detailTriangles: tileDetail.detailTriangles,
        tileX: tx,
        tileY: ty,
        tileLayer: 0,
        cellSize: NAV_CONFIG.cellSize,
        cellHeight: NAV_CONFIG.cellHeight,
        walkableHeight: NAV_CONFIG.walkableHeightWorld,
        walkableRadius: NAV_CONFIG.walkableRadiusWorld,
        walkableClimb: NAV_CONFIG.walkableClimbWorld,
        // biome-ignore lint/suspicious/noExplicitAny: buildTile's param type is broader than we spell out
    } as any);

    removeTile(navMesh, tx, ty, 0);
    addTile(navMesh, tile);
    navigation.debugDirty = true;
}

/* ---------------- dynamic obstacles ---------------- */

// Register a moving obstacle (a crashcat body). Its swept motion dirties the tiles it
// overlaps each step (updateDynamicNavMesh), and those tiles rebuild with it rasterized in.
export function registerSphereObstacle(
    navigation: Navigation,
    getPosition: (out: Vec3) => void,
    radius: number,
    isMoving: () => boolean,
): void {
    const build = navigation.build;
    if (!build) return;
    const pos: Vec3 = [0, 0, 0];
    getPosition(pos);
    const obstacle: NavObstacle = { getPosition, radius, isMoving, lastPosition: [pos[0], pos[1], pos[2]], lastTiles: new Set() };
    const idx = build.tracking.obstacles.push(obstacle) - 1;
    // Seed its tiles + dirty them so the first rebuild carves it in.
    const tiles = tilesForAABB(build, pos[0] - radius, pos[2] - radius, pos[0] + radius, pos[2] + radius);
    for (const [tx, ty] of tiles) {
        const key = tileKey(tx, ty);
        obstacle.lastTiles.add(key);
        let set = build.tracking.tileToObstacles.get(key);
        if (!set) {
            set = new Set();
            build.tracking.tileToObstacles.set(key, set);
        }
        set.add(idx);
        enqueueTile(build, tx, ty);
    }
}

function tilesForAABB(build: NavBuild, minX: number, minZ: number, maxX: number, maxZ: number): Array<[number, number]> {
    const size = build.config.tileSizeWorld;
    if (build.config.tileWidth <= 0 || build.config.tileHeight <= 0 || size <= 0) return [];
    const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
    const x0 = clamp(Math.floor((minX - build.meshBounds[0]) / size), build.config.tileWidth - 1);
    const y0 = clamp(Math.floor((minZ - build.meshBounds[2]) / size), build.config.tileHeight - 1);
    const x1 = clamp(Math.floor((maxX - build.meshBounds[0]) / size), build.config.tileWidth - 1);
    const y1 = clamp(Math.floor((maxZ - build.meshBounds[2]) / size), build.config.tileHeight - 1);
    if (x0 > x1 || y0 > y1) return [];
    const out: Array<[number, number]> = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
    return out;
}

function enqueueTile(build: NavBuild, x: number, y: number): void {
    if (x < 0 || y < 0 || x >= build.config.tileWidth || y >= build.config.tileHeight) return;
    const key = tileKey(x, y);
    if (build.tracking.dirtyTiles.has(key)) return;
    build.tracking.dirtyTiles.add(key);
    build.tracking.rebuildQueue.push([x, y]);
}

const _obsPos: Vec3 = [0, 0, 0];

/**
 * Track obstacle movement (swept AABB → dirty tiles) and rebuild up to `maxPerFrame`
 * queued tiles. A no-op until obstacles are registered (so it's free in Phase 1).
 */
export function updateDynamicNavMesh(navigation: Navigation, maxPerFrame: number): void {
    const build = navigation.build;
    if (!build) return;

    for (let i = 0; i < build.tracking.obstacles.length; i++) {
        const obs = build.tracking.obstacles[i];
        obs.getPosition(_obsPos);
        const r = obs.radius;
        const minX = Math.min(obs.lastPosition[0], _obsPos[0]) - r;
        const minZ = Math.min(obs.lastPosition[2], _obsPos[2]) - r;
        const maxX = Math.max(obs.lastPosition[0], _obsPos[0]) + r;
        const maxZ = Math.max(obs.lastPosition[2], _obsPos[2]) + r;

        const newTiles = new Set<string>();
        for (const [tx, ty] of tilesForAABB(build, minX, minZ, maxX, maxZ)) newTiles.add(tileKey(tx, ty));

        const moving = obs.isMoving();
        // Tiles it left must always rebuild (remove the obstacle); tiles it occupies rebuild
        // only while it's awake.
        for (const oldKey of obs.lastTiles) {
            if (!newTiles.has(oldKey)) {
                const [tx, ty] = oldKey.split('_').map(Number);
                enqueueTile(build, tx, ty);
            }
        }
        if (moving) {
            for (const newKey of newTiles) {
                const [tx, ty] = newKey.split('_').map(Number);
                enqueueTile(build, tx, ty);
            }
        }

        // Re-register the obstacle against its current tiles.
        for (const oldKey of obs.lastTiles) {
            if (!newTiles.has(oldKey)) {
                const set = build.tracking.tileToObstacles.get(oldKey);
                if (set) {
                    set.delete(i);
                    if (set.size === 0) build.tracking.tileToObstacles.delete(oldKey);
                }
            }
        }
        for (const newKey of newTiles) {
            if (!obs.lastTiles.has(newKey)) {
                let set = build.tracking.tileToObstacles.get(newKey);
                if (!set) {
                    set = new Set();
                    build.tracking.tileToObstacles.set(newKey, set);
                }
                set.add(i);
            }
        }
        obs.lastTiles = newTiles;
        obs.lastPosition[0] = _obsPos[0];
        obs.lastPosition[1] = _obsPos[1];
        obs.lastPosition[2] = _obsPos[2];
    }

    processRebuildQueue(navigation, maxPerFrame);
}

function processRebuildQueue(navigation: Navigation, maxPerFrame: number): void {
    const build = navigation.build;
    if (!build) return;
    let processed = 0;
    const now = performance.now();

    // Examine each currently-queued tile at most once this call: a throttled tile is
    // shifted off and re-pushed to the back, so without this bound a queue full of
    // throttled tiles would spin forever (processed never advances, length never shrinks).
    let toExamine = build.tracking.rebuildQueue.length;

    while (processed < maxPerFrame && toExamine > 0) {
        toExamine--;
        const next = build.tracking.rebuildQueue.shift();
        if (!next) break;
        const [tx, ty] = next;
        const key = tileKey(tx, ty);

        const last = build.tracking.tileLastRebuilt.get(key) ?? 0;
        if (now - last < NAV_CONFIG.tileRebuildThrottleMs) {
            build.tracking.rebuildQueue.push([tx, ty]); // too soon — retry a later frame
            continue;
        }

        build.tracking.dirtyTiles.delete(key);
        try {
            buildTileAtCoords(navigation, tx, ty);
            build.tracking.tileLastRebuilt.set(key, performance.now());
        } catch (err) {
            console.error(`navmesh tile ${key} rebuild failed`, err);
        }
        processed++;
    }
}

/* ---------------- crowd (agent steering / avoidance) ---------------- */

const _nearest = createFindNearestPolyResult();

export function makeAgentParams(radius: number, height: number, maxSpeed: number): crowd.AgentParams {
    return {
        radius,
        height,
        maxAcceleration: maxSpeed * 8,
        maxSpeed,
        collisionQueryRange: radius * 6,
        separationWeight: 1,
        updateFlags:
            crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
            crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
            crowd.CrowdUpdateFlags.SEPARATION |
            crowd.CrowdUpdateFlags.OPTIMIZE_VIS |
            crowd.CrowdUpdateFlags.OPTIMIZE_TOPO,
        queryFilter: DEFAULT_QUERY_FILTER,
    };
}

export function addCrowdAgent(navigation: Navigation, position: Vec3, params: crowd.AgentParams): string | null {
    if (!navigation.crowd || !navigation.navMesh) return null;
    return crowd.addAgent(navigation.crowd, navigation.navMesh, position, params);
}

export function removeCrowdAgent(navigation: Navigation, agentId: string): void {
    if (navigation.crowd) crowd.removeAgent(navigation.crowd, agentId);
}

export function getAgent(navigation: Navigation, agentId: string): crowd.Agent | undefined {
    return navigation.crowd?.agents[agentId];
}

// Snap a world point onto the nearest navmesh poly. Returns false if none is in range.
export function snapToNavMesh(navigation: Navigation, point: Vec3, out: Vec3): boolean {
    if (!navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, point, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    out[0] = _nearest.position[0];
    out[1] = _nearest.position[1];
    out[2] = _nearest.position[2];
    return true;
}

export function setAgentTarget(navigation: Navigation, agentId: string, target: Vec3): boolean {
    if (!navigation.crowd || !navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, target, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    return crowd.requestMoveTarget(navigation.crowd, agentId, _nearest.nodeRef, _nearest.position);
}

export function setAgentVelocity(navigation: Navigation, agentId: string, velocity: Vec3): boolean {
    if (!navigation.crowd) return false;
    return crowd.requestMoveVelocity(navigation.crowd, agentId, velocity);
}

export function updateCrowd(navigation: Navigation, dt: number): void {
    if (!navigation.crowd || !navigation.navMesh) return;
    crowd.update(navigation.crowd, navigation.navMesh, dt);
}

/* ---------------- player proxy agent ---------------- */

// The player is a target-less proxy agent, pinned to the player's feet each frame so the
// creatures' avoidance/separation treats the player as a moving obstacle ("presence").
export function addPlayerAgent(navigation: Navigation, position: Vec3): void {
    const params = makeAgentParams(PLAYER_AGENT_RADIUS, PLAYER_AGENT_HEIGHT, 8);
    navigation.playerAgentId = addCrowdAgent(navigation, position, params);
}

const _playerSnap: Vec3 = [0, 0, 0];

// Pin the player's proxy agent to the player. Call BEFORE updateCrowd.
export function updatePlayerAgent(navigation: Navigation, position: Vec3, velocity: Vec3): void {
    if (!navigation.crowd || navigation.playerAgentId === null) return;
    const agent = navigation.crowd.agents[navigation.playerAgentId];
    if (!agent) return;

    if (snapToNavMesh(navigation, position, _playerSnap)) {
        agent.position[0] = _playerSnap[0];
        agent.position[1] = _playerSnap[1];
        agent.position[2] = _playerSnap[2];
    } else {
        agent.position[0] = position[0];
        agent.position[1] = position[1];
        agent.position[2] = position[2];
    }
    agent.velocity[0] = velocity[0];
    agent.velocity[1] = 0;
    agent.velocity[2] = velocity[2];
    agent.desiredVelocity[0] = velocity[0];
    agent.desiredVelocity[1] = 0;
    agent.desiredVelocity[2] = velocity[2];
}

/* ---------------- debug ---------------- */

// Toggle the navmesh wireframe overlay. Rebuilds the helper when a tile changed
// (debugDirty) so the overlay reflects live rebuilds.
export function updateNavigationDebug(navigation: Navigation, scene: THREE.Scene, show: boolean): void {
    if (!navigation.navMesh) return;

    if (show && (!navigation.navMeshHelper || navigation.debugDirty)) {
        if (navigation.navMeshHelper) {
            scene.remove(navigation.navMeshHelper.object);
            navigation.navMeshHelper.dispose();
        }
        const helper = createNavMeshHelper(navigation.navMesh);
        helper.object.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.frustumCulled = false;
            mesh.renderOrder = 999;
            const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshBasicMaterial[];
            for (const mat of mats) {
                mat.transparent = true;
                mat.opacity = 0.4;
                mat.depthWrite = false;
            }
        });
        scene.add(helper.object);
        navigation.navMeshHelper = helper;
        navigation.debugDirty = false;
    } else if (!show && navigation.navMeshHelper) {
        scene.remove(navigation.navMeshHelper.object);
        navigation.navMeshHelper.dispose();
        navigation.navMeshHelper = null;
    }
}
