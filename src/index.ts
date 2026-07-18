import { type Vec3, vec3 } from 'mathcat';
import * as THREE from 'three';

import { CHARACTER_FEET_OFFSET, initCharacter, updateCharacter } from './character';
import {
    initCharacterVisuals,
    loadCharacterVisuals,
    requestTrick,
    setCharacterEnvMap,
    updateCharacterVisuals,
} from './character-visuals';
import { getMoveDirection, initControls, updateCameraFollow } from './controls';
import { initCreatures, setCreatureTargets, spawnCreatures, updateCreatures } from './creatures';
import { initDebug, updateDebug } from './debug';
import { initLighting, updateLighting } from './lighting';
import {
    addPlayerAgent,
    buildNavigation,
    initNavigation,
    registerSphereObstacle,
    updateCrowd,
    updateDynamicNavMesh,
    updateNavigationDebug,
    updatePlayerAgent,
} from './navigation';
import { initPhysics, updatePhysics } from './physics';
import { initPostProcessing, renderPostProcessing, resizePostProcessing, updatePostProcessing } from './postprocessing';
import { BALL_RADIUS, initReflections, loadReflections, snapshotReflections, updateReflections } from './reflections';
import { CREATURE_COUNT, createTuning, MAX_DPR, NAV_MAX_TILES_PER_FRAME } from './scene';
import { initWorld, loadWorld, syncWorldShadow } from './world';
import './style.css';

function init() {
    const tuning = createTuning();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd6d6d6);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);

    // antialias helps the character mesh + balls; splats ignore MSAA. sRGB output + no
    // tone mapping matches the source template's colour pipeline.
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    const physics = initPhysics();

    // Floating (spring-suspended) dynamic-body character controller.
    const character = initCharacter(physics);

    const world = initWorld(scene, renderer);
    const lighting = initLighting(scene);
    const visuals = initCharacterVisuals(scene);
    const reflections = initReflections(scene, physics);
    const controls = initControls(camera, renderer.domElement, character, physics);
    const pp = initPostProcessing(renderer, scene, camera, tuning);

    // Dynamic navmesh + crowd, and the little creatures that path-find over it to follow us.
    const navigation = initNavigation();
    const creatures = initCreatures(scene);

    const debug = initDebug(scene, physics, tuning, character, visuals);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        resizePostProcessing(pp, window.innerWidth, window.innerHeight);
    });

    return {
        tuning,
        scene,
        camera,
        renderer,
        physics,
        character,
        world,
        lighting,
        visuals,
        reflections,
        controls,
        navigation,
        creatures,
        pp,
        debug,
    };
}

type State = ReturnType<typeof init>;

async function load(state: State) {
    // The splat download gates the loading indicator; the rest streams in behind it.
    await loadWorld(state.world, state.physics, state.tuning);

    // Build the navmesh from the same collider geometry the physics uses, then populate
    // the crowd: a player proxy (presence) + a pack of creatures spawned around us.
    buildNavigation(state.navigation, state.world.colliderPositions, state.world.colliderIndices);
    const p = state.character.body.position;
    const feet: Vec3 = [p[0], p[1] - CHARACTER_FEET_OFFSET, p[2]];
    addPlayerAgent(state.navigation, feet);
    spawnCreatures(state.creatures, state.navigation, CREATURE_COUNT, feet);

    // Register the reflector balls as dynamic navmesh obstacles — as they roll, the tiles
    // under them recompute and the creatures reroute (navcat dynamic-navmesh pattern).
    for (const rig of state.reflections.rigs) {
        registerSphereObstacle(
            state.navigation,
            (out) => {
                out[0] = rig.body.position[0];
                out[1] = rig.body.position[1];
                out[2] = rig.body.position[2];
            },
            BALL_RADIUS,
            () => vec3.length(rig.body.motionProperties.linearVelocity) > 0.05,
        );
    }

    loadCharacterVisuals(state.visuals, state.tuning).catch((err) => console.warn('could not load character model', err));
    loadReflections(state.reflections, state.renderer, (env) => setCharacterEnvMap(state.visuals, env)).catch((err) =>
        console.warn('could not load reflections', err),
    );
}

// The floating controller's spring is impulse-based, so its rest height depends on the
// step size — at variable frame dt the equilibrium shifts every frame and the capsule
// visibly bobs. We fix the physics dt and interpolate the render transform between the
// last two steps, so motion is both stable and smooth regardless of display refresh rate.
const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.2; // clamp a tab-refocus pause so we don't spiral stepping to catch up

const _moveDir3 = new THREE.Vector3();
const _moveDir: Vec3 = [0, 0, 0];

// Fixed-step interpolation snapshots: character body position + facing yaw, prev vs current.
const _prevCharPos = vec3.create();
const _currCharPos = vec3.create();
let _prevYaw = 0;
let _currYaw = 0;
const _lerpPos = vec3.create();
const _feetVec = new THREE.Vector3();
const _playerFeet: Vec3 = [0, 0, 0];
let accumulator = 0;

function lerpAngle(a: number, b: number, t: number): number {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
}

// One deterministic physics tick: read input, drive the character, integrate the world,
// and roll the interpolation snapshots forward (previous ← last current ← post-step).
function fixedStep(state: State) {
    vec3.copy(_prevCharPos, _currCharPos);
    _prevYaw = _currYaw;

    getMoveDirection(state.controls, _moveDir3);
    _moveDir[0] = _moveDir3.x;
    _moveDir[1] = _moveDir3.y;
    _moveDir[2] = _moveDir3.z;
    updateCharacter(
        state.physics,
        state.character,
        { moveDir: _moveDir, jump: state.controls.input.jump, run: state.controls.input.sprint },
        state.tuning,
        FIXED_DT,
    );

    // AI (before physics): recompute dirty navmesh tiles from the balls' motion, then step
    // the crowd with the player pinned in as a presence proxy and the creatures homing in.
    updateDynamicNavMesh(state.navigation, NAV_MAX_TILES_PER_FRAME);
    _playerFeet[0] = state.character.body.position[0];
    _playerFeet[1] = state.character.body.position[1] - CHARACTER_FEET_OFFSET;
    _playerFeet[2] = state.character.body.position[2];
    updatePlayerAgent(state.navigation, _playerFeet, state.character.body.motionProperties.linearVelocity);
    setCreatureTargets(state.creatures, state.navigation, _playerFeet);
    updateCrowd(state.navigation, FIXED_DT);

    updatePhysics(state.physics, FIXED_DT);
    snapshotReflections(state.reflections);

    vec3.copy(_currCharPos, state.character.body.position);
    _currYaw = state.character.facingYaw;
}

// Render one frame: interpolate the physics transforms by `alpha`, then sync everything
// that follows the character. `frameDt` (real time) drives the animation mixer + composer.
function render(state: State, alpha: number, frameDt: number) {
    vec3.lerp(_lerpPos, _prevCharPos, _currCharPos, alpha);
    const yaw = lerpAngle(_prevYaw, _currYaw, alpha);
    _feetVec.set(_lerpPos[0], _lerpPos[1] - CHARACTER_FEET_OFFSET, _lerpPos[2]);

    // One-shot trick (press 1), consumed once per frame.
    if (state.controls.input.trick) {
        state.controls.input.trick = false;
        requestTrick(state.visuals);
    }

    updateReflections(state.reflections, alpha);
    updateCharacterVisuals(state.visuals, state.character, state.tuning, frameDt, _feetVec, yaw);

    // Creatures read their crowd agents (stepped in fixedStep) and write their instances.
    updateCreatures(state.creatures, state.navigation, frameDt);
    updateNavigationDebug(state.navigation, state.scene, state.tuning.showNavMesh);

    updateLighting(state.lighting, state.tuning, _feetVec);
    syncWorldShadow(state.world, state.tuning);
    updatePostProcessing(state.pp, state.tuning);
    updateDebug(state.debug, state.physics, state.tuning, _feetVec);

    updateCameraFollow(state.controls, state.physics, _feetVec, state.tuning, frameDt);
    renderPostProcessing(state.pp, frameDt);
}

function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 500);
}

async function start() {
    const state = init();
    await load(state);
    hideLoading();

    // Seed both snapshots with the spawn transform so the first frames don't interpolate
    // from the origin.
    vec3.copy(_currCharPos, state.character.body.position);
    vec3.copy(_prevCharPos, _currCharPos);
    _prevYaw = _currYaw = state.character.facingYaw;

    let lastTime = performance.now();
    function loop() {
        const now = performance.now();
        const frameDt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
        lastTime = now;

        accumulator += frameDt;
        while (accumulator >= FIXED_DT) {
            fixedStep(state);
            accumulator -= FIXED_DT;
        }
        render(state, accumulator / FIXED_DT, frameDt);

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
