import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createTriangleMeshBody, type Physics } from './physics';
import { COLLIDER_SCALE, COLLIDER_URL, SPLAT_SCALE, SPLAT_URL, type Tuning } from './scene';

// The world: the Gaussian splat we render (Spark) plus an invisible collider GLB that
// backs both physics (a static triangle mesh) and shadows (a shadow-catcher material, so
// the character's shadow lands on the floor even though splats can't receive shadows).
// The two GLBs are authored small; both are uniformly scaled up to game scale on load.

// depthWrite:false keeps splats (drawn in the transparent pass) from being punched out by
// the shadow catcher; a high renderOrder draws it after the splats.
const SHADOW_CATCHER_RENDER_ORDER = 1000;

export type World = {
    spark: SparkRenderer;
    splat: SplatMesh;
    /** Scaled root holding the collider GLB meshes (turned into shadow catchers). */
    colliderRoot: THREE.Group;
    shadowMaterial: THREE.ShadowMaterial;
    /** The baked collider triangle soup (world space) — reused to build the navmesh. */
    colliderPositions: number[];
    colliderIndices: number[];
};

export function initWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): World {
    // SparkRenderer drives splat sorting + LOD streaming. lodRenderScale skips the
    // tiniest screen-space splats — ~2 is usually imperceptible and saves fill.
    const spark = new SparkRenderer({ renderer, enableLod: true, lodRenderScale: 2 });
    scene.add(spark);

    // The splat is a pre-built streaming-LOD `.rad` (see scene.ts / `pnpm build:lod`), so
    // `paged: true` streams it coarse-to-fine over HTTP Range requests. The `.rad` already
    // encodes the LOD tree, so no `lod: true` is needed. `splat.initialized` now resolves
    // once the stream is wired up (near-instant); detail fills in over the next frames.
    const splat = new SplatMesh({ url: SPLAT_URL, paged: true });
    splat.quaternion.identity();
    splat.position.set(0, 0, 0);
    splat.scale.setScalar(SPLAT_SCALE);
    scene.add(splat);

    const colliderRoot = new THREE.Group();
    colliderRoot.name = 'Collider';
    scene.add(colliderRoot);

    const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.3, color: 0x000000 });
    shadowMaterial.transparent = true;
    shadowMaterial.depthWrite = false;
    shadowMaterial.depthTest = true;

    return { spark, splat, colliderRoot, shadowMaterial, colliderPositions: [], colliderIndices: [] };
}

const _triWorld = new THREE.Vector3();

// Merge every mesh under `root` into one world-space triangle soup (for the trimesh).
function mergeWorldSpaceTriangles(root: THREE.Object3D): { positions: number[]; indices: number[] } {
    const positions: number[] = [];
    const indices: number[] = [];
    let base = 0;
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!posAttr) return;
        for (let i = 0; i < posAttr.count; i++) {
            _triWorld.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
            positions.push(_triWorld.x, _triWorld.y, _triWorld.z);
        }
        // A negative-determinant world matrix (mirror / negative scale, as the authored
        // floor slab uses) flips triangle winding. crashcat's trimesh raycast + solid
        // collision are single-sided, so a downward-facing floor is invisible and the
        // character tunnels through it — flip those triangles back to keep winding
        // consistent across the whole soup.
        const flip = mesh.matrixWorld.determinant() < 0;
        const pushTri = (a: number, b: number, c: number) => {
            if (flip) indices.push(base + a, base + c, base + b);
            else indices.push(base + a, base + b, base + c);
        };
        const indexAttr = mesh.geometry.getIndex();
        if (indexAttr) {
            for (let i = 0; i + 2 < indexAttr.count; i += 3)
                pushTri(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
        } else {
            for (let i = 0; i + 2 < posAttr.count; i += 3) pushTri(i, i + 1, i + 2);
        }
        base += posAttr.count;
    });
    return { positions, indices };
}

export async function loadWorld(world: World, physics: Physics, tuning: Tuning): Promise<void> {
    // Wait for the splat to finish downloading/decoding before we report ready.
    await world.splat.initialized;

    const gltf = await new GLTFLoader().loadAsync(COLLIDER_URL);
    world.colliderRoot.add(gltf.scene);

    world.shadowMaterial.opacity = tuning.colliderShadowOpacity;
    world.shadowMaterial.transparent = tuning.colliderShadowOpacity < 0.999;

    // Turn every collider mesh into an invisible shadow catcher.
    gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const prev = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of prev) m?.dispose();
        mesh.material = world.shadowMaterial;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.renderOrder = SHADOW_CATCHER_RENDER_ORDER;
    });

    // Scale to game units, then bake the (now world-space) triangles into a static body.
    world.colliderRoot.scale.setScalar(COLLIDER_SCALE);
    world.colliderRoot.updateMatrixWorld(true);
    const { positions, indices } = mergeWorldSpaceTriangles(world.colliderRoot);
    if (indices.length < 3) {
        console.warn(`${COLLIDER_URL}: no triangles found for the static collider`);
        return;
    }
    createTriangleMeshBody(physics, positions, indices);
    // Keep the soup so the navmesh (navigation.ts) builds from the exact same geometry.
    world.colliderPositions = positions;
    world.colliderIndices = indices;
    console.log(`collider baked: ${positions.length / 3} verts, ${indices.length / 3} tris`);
}

/** Push the tuned shadow-catcher opacity onto the shared collider material. */
export function syncWorldShadow(world: World, tuning: Tuning): void {
    world.shadowMaterial.opacity = tuning.colliderShadowOpacity;
    world.shadowMaterial.transparent = tuning.colliderShadowOpacity < 0.999;
}
