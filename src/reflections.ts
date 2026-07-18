import { type Quat, quat, type Vec3, vec3 } from 'mathcat';
import * as THREE from 'three';
import { createDynamicSphere, type Physics, type RigidBody } from './physics';
import { PANO_URL } from './scene';

// A few dynamic "reflector balls" the character can bump into, plus a PMREM environment
// map baked from an equirectangular pano. The env map gives the metallic balls (and the
// character) something to reflect; the balls are real crashcat dynamic bodies whose
// meshes track the physics — interpolated between fixed steps (see index.ts) so they
// move as smoothly as the character.

const BALL_COUNT = 3;
export const BALL_RADIUS = 1.2;
const BALL_HUES = [0xf8bbd9, 0xf06292, 0xad1457, 0xf48fb1, 0xce93d8];
// Spawn the row in front of (−Z) and slightly to the right (+X) of the character spawn.
const SPAWN_Z = -12;
const SPAWN_X = 4;
const GRID_STEP = 2.75;

// Previous/current fixed-step transforms, interpolated on render.
type BallRig = { mesh: THREE.Mesh; body: RigidBody; prevPos: Vec3; currPos: Vec3; prevQuat: Quat; currQuat: Quat };

export type Reflections = {
    group: THREE.Group;
    rigs: BallRig[];
    envMap: THREE.Texture | null;
};

export function initReflections(scene: THREE.Scene, physics: Physics): Reflections {
    const group = new THREE.Group();
    group.name = 'ReflectorBalls';
    scene.add(group);

    const geo = new THREE.SphereGeometry(BALL_RADIUS, 32, 24);
    const rigs: BallRig[] = [];

    for (let i = 0; i < BALL_COUNT; i++) {
        const x = (i - (BALL_COUNT - 1) / 2) * GRID_STEP + SPAWN_X;
        const z = SPAWN_Z;
        const y = BALL_RADIUS;

        const mat = new THREE.MeshStandardMaterial({
            color: BALL_HUES[i % BALL_HUES.length],
            metalness: 0.22,
            roughness: 0.4,
            envMapIntensity: 0.5,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(x, y, z);
        group.add(mesh);

        const body = createDynamicSphere(physics, [x, y, z], BALL_RADIUS, { mass: 0.85, friction: 0.38, restitution: 0.12 });
        rigs.push({
            mesh,
            body,
            prevPos: vec3.fromValues(x, y, z),
            currPos: vec3.fromValues(x, y, z),
            prevQuat: quat.create(),
            currQuat: quat.create(),
        });
    }

    return { group, rigs, envMap: null };
}

// Bake the pano into a PMREM env map, apply it to the balls, and hand it back via
// `onEnv` (so the character mesh can use the same reflections).
export async function loadReflections(
    reflections: Reflections,
    renderer: THREE.WebGLRenderer,
    onEnv: (env: THREE.Texture) => void,
): Promise<void> {
    let tex: THREE.Texture;
    try {
        tex = await new THREE.TextureLoader().loadAsync(PANO_URL);
    } catch (err) {
        console.warn(`could not load ${PANO_URL} — skipping reflections`, err);
        return;
    }
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const env = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    pmrem.dispose();

    reflections.envMap = env;
    for (const { mesh } of reflections.rigs) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.envMap = env;
        mat.envMapIntensity = 0.5;
    }
    onEnv(env);
}

// Roll each ball's transform forward one fixed step: current → previous, then read the
// post-step body transform into current. Call once per fixed physics step.
export function snapshotReflections(reflections: Reflections): void {
    for (const rig of reflections.rigs) {
        vec3.copy(rig.prevPos, rig.currPos);
        rig.prevQuat[0] = rig.currQuat[0];
        rig.prevQuat[1] = rig.currQuat[1];
        rig.prevQuat[2] = rig.currQuat[2];
        rig.prevQuat[3] = rig.currQuat[3];
        vec3.copy(rig.currPos, rig.body.position);
        const q = rig.body.quaternion;
        rig.currQuat[0] = q[0];
        rig.currQuat[1] = q[1];
        rig.currQuat[2] = q[2];
        rig.currQuat[3] = q[3];
    }
}

const _pos = vec3.create();
const _quat = quat.create();

// Place the ball meshes at the interpolated (prev→curr, by alpha) fixed-step transforms.
export function updateReflections(reflections: Reflections, alpha: number): void {
    for (const { mesh, prevPos, currPos, prevQuat, currQuat } of reflections.rigs) {
        vec3.lerp(_pos, prevPos, currPos, alpha);
        quat.slerp(_quat, prevQuat, currQuat, alpha);
        mesh.position.set(_pos[0], _pos[1], _pos[2]);
        mesh.quaternion.set(_quat[0], _quat[1], _quat[2], _quat[3]);
    }
}
