import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Character } from './character';
import { CHARACTER_URL, CLIP_AIR_IDLE, CLIP_HAPPY_IDLE, CLIP_TRICK, CLIP_WALK, TRICK_DURATION_MS, type Tuning } from './scene';

// The visible character: an animated GLB placed at the physics body's feet, yawed to the
// controller's facing direction, with a small idle / walk / air-idle state machine plus a
// one-shot "trick" override. The physics body (character.ts) is invisible; this is only
// presentation, so nothing here feeds back into the sim.

type AnimName = 'happy' | 'walk' | 'air';

// Upward velocity (m/s) above which the character reads as airborne for animation, even if
// the float controller's ground ray still sees the floor (a jump barely clears that zone).
const AIR_LAUNCH_SPEED = 1.5;

export type CharacterVisuals = {
    /** Yawed to the controller's facing; positioned at the character's feet each frame. */
    root: THREE.Group;
    model: THREE.Object3D | null;
    mixer: THREE.AnimationMixer | null;
    actions: {
        happy: THREE.AnimationAction | null;
        air: THREE.AnimationAction | null;
        walk: THREE.AnimationAction | null;
        trick: THREE.AnimationAction | null;
    };
    playing: AnimName;
    /** Wall-clock end time (ms) of the trick override; 0 = not playing. */
    trickEndTime: number;

    // animation stability — stays "grounded" briefly after physics releases (anti-flicker).
    stableGrounded: boolean;
    airAccum: number;
    /** Low-pass horizontal speed (m/s), used to pick walk vs idle. */
    smoothedHSpeed: number;

    /** PMREM reflection env; applied to the model's materials once both exist. */
    envMap: THREE.Texture | null;
};

export function initCharacterVisuals(scene: THREE.Scene): CharacterVisuals {
    const root = new THREE.Group();
    root.name = 'Character';
    scene.add(root);

    return {
        root,
        model: null,
        mixer: null,
        actions: { happy: null, air: null, walk: null, trick: null },
        playing: 'happy',
        trickEndTime: 0,
        stableGrounded: false,
        airAccum: 0,
        smoothedHSpeed: 0,
        envMap: null,
    };
}

// Scale the model to the tuned height and centre it so its feet sit at the root origin.
// Box3.setFromObject works in WORLD space, so we detach the model first — otherwise the
// running render loop has already moved `root` to the spawn feet, that offset lands in the
// bounding box, and it gets baked into the model's local position (the dog then renders
// permanently offset from the physics body by the spawn amount).
function layoutModel(visuals: CharacterVisuals, tuning: Tuning): void {
    const model = visuals.model;
    if (!model) return;

    const parent = model.parent;
    parent?.remove(model); // lay out in the model's own (origin) frame

    model.position.set(0, 0, 0);
    model.quaternion.identity();
    model.scale.set(1, 1, 1);
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    const h = Math.max(box.max.y - box.min.y, 1e-4);
    model.scale.setScalar(tuning.characterHeight / h);
    model.updateMatrixWorld(true);

    box.setFromObject(model);
    model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    model.rotation.y = THREE.MathUtils.degToRad(tuning.characterYawDeg);

    parent?.add(model);
}

function actionFor(visuals: CharacterVisuals, anim: AnimName): THREE.AnimationAction | null {
    if (anim === 'happy') return visuals.actions.happy;
    if (anim === 'walk') return visuals.actions.walk;
    return visuals.actions.air;
}

function initAnimations(visuals: CharacterVisuals, clips: THREE.AnimationClip[]): void {
    if (!visuals.model || clips.length === 0) return;

    const mixer = new THREE.AnimationMixer(visuals.model);
    visuals.mixer = mixer;

    const byName = (name: string) => clips.find((c) => c.name === name);
    const happyClip = byName(CLIP_HAPPY_IDLE) ?? clips.find((c) => /happy\s*idle/i.test(c.name));
    const airClip = byName(CLIP_AIR_IDLE);
    const walkClip = byName(CLIP_WALK) ?? clips.find((c) => /brutal/i.test(c.name));
    const trickClip = byName(CLIP_TRICK) ?? clips.find((c) => /step\s*hip\s*hop/i.test(c.name));

    const names = clips.map((c) => c.name).join(', ');
    if (!happyClip) console.warn(`[character] missing idle clip (${CLIP_HAPPY_IDLE}). available: ${names}`);
    if (!airClip) console.warn(`[character] missing air-idle clip (${CLIP_AIR_IDLE}). available: ${names}`);
    if (!walkClip) console.warn(`[character] missing walk clip (${CLIP_WALK}). available: ${names}`);
    if (!trickClip) console.warn(`[character] missing trick clip (${CLIP_TRICK}). available: ${names}`);

    const make = (clip: THREE.AnimationClip | undefined) => {
        if (!clip) return null;
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        return action;
    };
    visuals.actions.happy = make(happyClip);
    visuals.actions.air = make(airClip);
    visuals.actions.walk = make(walkClip);
    visuals.actions.trick = make(trickClip);

    // Start on the first available of happy → air → walk.
    const start: AnimName = visuals.actions.happy ? 'happy' : visuals.actions.air ? 'air' : 'walk';
    const startAction = actionFor(visuals, start);
    if (startAction) {
        startAction.reset().setEffectiveWeight(1).play();
        visuals.playing = start;
    }
}

export async function loadCharacterVisuals(visuals: CharacterVisuals, tuning: Tuning): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(CHARACTER_URL);
    const model = gltf.scene;
    model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = false;
        }
    });

    visuals.model = model;
    visuals.root.add(model);
    layoutModel(visuals, tuning);
    initAnimations(visuals, gltf.animations);
    applyEnvMap(visuals); // in case reflections loaded first
}

// Which animation the state should be in (idle vs walk vs airborne), respecting which
// clips actually loaded.
function resolveWant(visuals: CharacterVisuals, inAir: boolean, movingOnGround: boolean): AnimName {
    if (inAir) return visuals.actions.air ? 'air' : visuals.actions.happy ? 'happy' : 'walk';
    if (movingOnGround) return visuals.actions.walk ? 'walk' : visuals.actions.happy ? 'happy' : 'air';
    return visuals.actions.happy ? 'happy' : visuals.actions.air ? 'air' : 'walk';
}

/** Kick off the one-shot trick animation (press 1). */
export function requestTrick(visuals: CharacterVisuals): void {
    const trick = visuals.actions.trick;
    if (!trick || !visuals.mixer) return;
    visuals.trickEndTime = performance.now() + TRICK_DURATION_MS;
    const prev = actionFor(visuals, visuals.playing);
    trick.reset().setEffectiveWeight(1).play();
    if (prev && prev !== trick) prev.crossFadeTo(trick, 0.28, false);
}

function updateAnimations(visuals: CharacterVisuals, character: Character, tuning: Tuning, dt: number): void {
    const mixer = visuals.mixer;
    if (!mixer) return;

    // grounding with release-hold, and a low-pass horizontal speed (anti-flicker).
    const lv = character.body.motionProperties.linearVelocity;
    // A jump is weak enough that the float controller's ground ray keeps seeing the floor
    // for most of the hop, so `isOnGround` alone never reads "airborne". Treat a clear
    // upward launch as airborne too, so the air-idle clip actually plays on a jump.
    const grounded = character.isOnGround && lv[1] < AIR_LAUNCH_SPEED;
    if (grounded) {
        visuals.stableGrounded = true;
        visuals.airAccum = 0;
    } else {
        visuals.airAccum += dt;
        if (visuals.airAccum >= tuning.animGroundReleaseHold) visuals.stableGrounded = false;
    }
    const hSpeed = Math.hypot(lv[0], lv[2]);
    const t = 1 - Math.exp(-tuning.animWalkSpeedSmoothing * dt);
    visuals.smoothedHSpeed += (hSpeed - visuals.smoothedHSpeed) * t;

    const trickPlaying = visuals.actions.trick !== null && visuals.trickEndTime > 0 && performance.now() < visuals.trickEndTime;

    // Walk clip speed scales with the tuned playback rate (and sprint).
    if (visuals.actions.walk && !trickPlaying) {
        let ts = tuning.walkAnimTimeScale;
        if (character.wantToRun && visuals.playing === 'walk') ts *= tuning.sprintWalkAnimMultiplier;
        visuals.actions.walk.setEffectiveTimeScale(ts);
    }

    if (trickPlaying) {
        mixer.update(dt);
        return;
    }

    const inAir = !visuals.stableGrounded;
    const movingOnGround = visuals.smoothedHSpeed > tuning.walkSpeedThreshold;
    const want = resolveWant(visuals, inAir, movingOnGround);

    if (want !== visuals.playing) {
        const next = actionFor(visuals, want);
        const prev = actionFor(visuals, visuals.playing);
        if (next) {
            const d = tuning.animCrossfade;
            next.reset().setEffectiveWeight(1).play();
            if (prev && prev !== next) prev.crossFadeTo(next, d, false);
            else next.fadeIn(d);
            visuals.playing = want;
        }
    }

    // The trick just ended (timer elapsed) — fall back to the resolved clip.
    if (visuals.trickEndTime > 0 && performance.now() >= visuals.trickEndTime) {
        visuals.trickEndTime = 0;
        const trick = visuals.actions.trick;
        const next = actionFor(visuals, want);
        if (trick && next) {
            next.reset().setEffectiveWeight(1).play();
            trick.crossFadeTo(next, tuning.animCrossfade, false);
            visuals.playing = want;
        }
    }

    mixer.update(dt);
}

// Place + animate the model. `feet` and `facingYaw` are the interpolated render transform
// (from the fixed-step loop); the animation state still reads the character's live grounded
// / velocity, and the mixer advances by the real frame `dt`.
export function updateCharacterVisuals(
    visuals: CharacterVisuals,
    character: Character,
    tuning: Tuning,
    dt: number,
    feet: THREE.Vector3,
    facingYaw: number,
): void {
    visuals.root.position.copy(feet);
    visuals.root.rotation.y = facingYaw;

    updateAnimations(visuals, character, tuning, dt);
}

/** Store the reflection env map and apply it to the model's standard/physical materials. */
export function setCharacterEnvMap(visuals: CharacterVisuals, env: THREE.Texture): void {
    visuals.envMap = env;
    applyEnvMap(visuals);
}

function applyEnvMap(visuals: CharacterVisuals): void {
    const env = visuals.envMap;
    if (!env || !visuals.model) return;
    visuals.model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
            if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhysicalMaterial) {
                mat.envMap = env;
                mat.envMapIntensity = 1;
            }
        }
    });
}

// Re-run the model layout (called by the debug panel when height / mesh-yaw changes).
export function relayoutCharacterVisuals(visuals: CharacterVisuals, tuning: Tuning): void {
    layoutModel(visuals, tuning);
}
