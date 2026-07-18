// Procedural "guys" — little googly-eyed creatures that follow the player around,
// ported from the-boiler-room's crawler creatures. Here they're PURE navcat crowd
// agents (no crashcat physics bodies): each creature's world position comes straight
// from its crowd agent, and its facing/speed from the agent's velocity. The body
// bob/lope, FABRIK leg gait, idle arm swing, and googly eyes are all kept; the
// boiler-room ragdoll/getup/coal-carry behaviour is dropped.
//
// All spatial math is mathcat on plain arrays (the same lib navcat/crashcat use, so
// agent positions/velocities flow through with no conversion). THREE is used only for
// the rendering objects it requires: two BatchedMeshes (body+limbs; eyes), a shared
// MeshStandardMaterial, Color, and a single Matrix4 to hand to setMatrixAt.
import { mat4, type Quat, quat, type Vec3, vec3 } from 'mathcat';
import * as THREE from 'three';
import { bone, type Chain, fabrikFixedIterations, JointConstraintType } from './fabrik';
import {
    addCrowdAgent,
    getAgent,
    makeAgentParams,
    type Navigation,
    setAgentTarget,
    setAgentVelocity,
    snapToNavMesh,
} from './navigation';

/* ---------------- tuning (all spatial dims scaled by CREATURE_SCALE) ---------------- */

// This world is authored at 5× scale (floor at y≈0.2, player capsule ~3 units tall).
// The source used 0.06 for ~0.1-unit creatures; scale so a guy's top sits ~1 world unit
// up (HEIGHT + BODY_RADIUS = 1.7·SCALE): 0.6 → ~1.02 units tall. Retune here.
const CREATURE_SCALE = 0.6;

const SPAWN_RADIUS = 0.5; // spawn radius around the centre — small so they start on the player

const BODY_RADIUS = 0.5 * CREATURE_SCALE;
const HEIGHT = 1.2 * CREATURE_SCALE; // body-centre ride height above the navmesh surface

const N_LEGS = 2;
const LEG_SEGMENTS = 4; // more joints → curvier, organic creature legs
const LEG_LENGTH = 1.25 * CREATURE_SCALE; // a little longer than the hip→ground reach → gentle bend, some slack
const ATTACH_RADIUS = 0.28 * CREATURE_SCALE; // hips close together under the body
const FOOT_RADIUS = 0.38 * CREATURE_SCALE; // feet roughly under the hips (a stance), not splayed out
const LEG_RADIUS = 0.05 * CREATURE_SCALE;
const LEG_IK_ITERATIONS = 6; // FABRIK passes per frame (reset each frame; longer chain needs more)
const LEG_JOINT_ROTOR = Math.PI / 2; // per-joint ball-constraint limit
const LEG_ATTACH_Y = -0.3 * CREATURE_SCALE; // hips low-ish → legs come from the lower body

const N_ARMS = 2;
const ARM_SEGMENTS = 4; // more joints → noodly, expressive arms
const ARM_LENGTH = 1.4 * CREATURE_SCALE;
const ARM_RADIUS = 0.06 * CREATURE_SCALE;
const ARM_IK_ITERATIONS = 5; // warm-started, but the longer chain needs a few more passes
const ARM_JOINT_ROTOR = Math.PI / 2; // looser ball limit → noodly, expressive arms
// Idle arm swing — a smooth fore/aft walk-pump (driven off smoothed speed, NOT the noisy
// gait cadence, so it never gets erratic).
const ARM_SWING_SMOOTH = 5; // per-sec low-pass rate for the swing's speed input
const ARM_SWING_FREQ_BASE = 1.2; // swing Hz when standing
// extra Hz per unit of (world-scale) speed. smoothSpeed runs up to AGENT_MAX_SPEED (~4),
// so this is scaled way down from the source's unit-scale value — at full run the arms
// swing ~2 Hz, matching the original's feel instead of a frantic ~11 Hz.
const ARM_SWING_FREQ_GAIN = 0.2;
const ARM_OUT = 0.6; // reach direction: out to the side
const ARM_DOWN = 0.5; // reach direction: downward — arms hang down so the swing scoops DOWN through centre
const ARM_EXTEND = 0.95; // reach near full ARM_LENGTH → arm outstretched/straight, the whole limb sweeps the U
const ARM_SWING_AMP_BASE = 0.2; // fore/aft component of the reach dir when standing
const ARM_SWING_AMP_GAIN = 0.6; // extra fore/aft component per unit speed fraction
const ARM_U_LIFT = 0.9; // hand lifts this much at the fore/aft extremes → the 'U' scoops down at centre, up at the ends

// Below this smoothed speed (world u/s) a creature reads as idle: the gait cycle freezes
// (no stepping in place) and the arm swing fades to zero (no idle twitch). Ramps 0→1 over
// [0, IDLE_SPEED] so the transition to walking is smooth.
const IDLE_SPEED = 0.4;

// Time-based gait: each leg steps once per gait cycle on a schedule. Cadence scales with
// speed so the planted foot doesn't slip; stride = speed / cadence.
const STEP_ARC_HEIGHT = 0.1 * CREATURE_SCALE;
const STEP_CADENCE_BASE = 2.5; // gait cycles/sec when standing still
const STEP_CADENCE_GAIN = 1.6; // extra cycles/sec per unit of body speed (world-scale speeds are large → keep low)
const STEP_DURATION_FRAC = 0.45; // a step swing takes this fraction of a cycle (the rest is planted)
const STEP_LEAD_FRACTION = 0.35; // foot lands this fraction of a stride ahead; it then recedes → swings well behind too
const STEP_LEAD_MAX = 0.45 * CREATURE_SCALE; // but never lead by more than this — else the leg over-extends

// Movement bob: the body rises/dips with the gait while walking, so the creatures lope
// instead of gliding. Faded in by smoothed speed → no bob when idle.
const BOB_AMP = 0.18 * CREATURE_SCALE; // peak vertical bob at full stride
const BOB_CYCLES = 2; // body rises this many times per bob cycle (one per push)
const BOB_FULL_SPEED = 1.6; // smoothed speed (world units/s) at which the bob reaches full amplitude
const BOB_MAX_CADENCE = 1.6; // bob cycles/sec ceiling → stays a calm lope even at high leg cadence

const TURN_RATE = 8; // how fast the body yaws toward its heading (per second, slerp fraction)
const TURN_MIN_SPEED = 0.15; // below this speed, keep the current facing (don't spin in place)

// Crowd agent + follow behaviour. The creatures hang back a little so they don't jitter
// on top of the player, and only re-issue a target when the player has actually moved.
const AGENT_RADIUS = 0.35;
const AGENT_MAX_SPEED = 4; // roughly half the player's move speed → they scurry to keep up
const STOP_DISTANCE = 2.5; // stop this far from the player (world units) → hang back, no piling on
const REISSUE_DIST = 1.0; // only re-path when the player has moved this far since the last issued target

// Per-creature body colour, assigned round-robin from this hand-picked palette of vibrant
// pastels (saturated enough to pop, soft but not washed out). Limbs are the same colour a
// touch deeper (LIMB_DARKEN); eyes stay white + dark iris.
const CREATURE_PALETTE = [
    0xffc9d9, // pink
    0xffd6e0, // light pink
    0xfdd4f0, // bubblegum
    0xffcabf, // melon
    0xffe5c4, // peach
    0xeecdff, // lavender
    0xd6ccff, // periwinkle
    0xccecff, // baby blue
    0xcef7e4, // mint
];
const LIMB_DARKEN = 0.86; // limb colour = body colour × this (kept light so limbs stay soft too)

const EYE_RADIUS = 0.14 * CREATURE_SCALE;
const IRIS_RADIUS = 0.05 * CREATURE_SCALE;
const N_EYES = 2;

// Googly-eye pupil physics (in eye-local normalised units: disc radius = 1).
const EYE_MAX = (EYE_RADIUS - IRIS_RADIUS) / EYE_RADIUS; // how far the pupil can roam
const EYE_CENTER_WALK = 11; // spring stiffness pulling the pupil back to forward
const EYE_GRAVITY_WALK = 1.5; // slight downward bias so the forward gaze isn't dead-perfect
const EYE_INERTIA_WALK = 0.12; // how hard socket ACCELERATION flings the pupil (low → footfalls barely nudge it)
const EYE_DAMP = 0.95; // per-frame velocity damping (higher = rings/wobbles longer)
const EYE_RESTITUTION = 0.85; // bounce off the eye rim (higher = rattlier)

// Body + limbs live in the shadow-casting mesh; the eyes (flat discs, whose shadows look
// wrong) live in a separate non-casting mesh — hence the two instance counts.
const EYE_INSTANCES_PER_CREATURE = N_EYES * 2; // white + iris per eye
const BODY_INSTANCES_PER_CREATURE = 1 + N_LEGS * LEG_SEGMENTS + N_ARMS * ARM_SEGMENTS;
// Reserve enough instances that spawnCreatures can be called with a generous count.
const MAX_CREATURES = 64;

/* ---------------- limb definitions (shared by every creature) ---------------- */

type LimbDef = {
    attachment: Vec3; // base, in body-local space
    restEnd: Vec3; // nominal straightened tip, in body-local space (initial IK pose)
    segments: number;
    length: number;
    phaseOffset: number; // legs only
    rotor: number; // per-joint ball-constraint angle limit
};

const LEG_DEFS: LimbDef[] = Array.from({ length: N_LEGS }, (_, i) => {
    // legs spread evenly, centred symmetric about the forward (+Z) axis — so 2 legs become
    // a left/right pair.
    const angle = Math.PI / 2 + (i - (N_LEGS - 1) / 2) * ((Math.PI * 2) / N_LEGS);
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    return {
        attachment: [x * ATTACH_RADIUS, LEG_ATTACH_Y, z * ATTACH_RADIUS],
        restEnd: [x * FOOT_RADIUS, 0, z * FOOT_RADIUS],
        segments: LEG_SEGMENTS,
        length: LEG_LENGTH,
        phaseOffset: i > N_LEGS / 2 ? i / N_LEGS - 1 : i / N_LEGS,
        rotor: LEG_JOINT_ROTOR,
    };
});

const ARM_DEFS: LimbDef[] = Array.from({ length: N_ARMS }, (_, i) => {
    const side = i === 0 ? -1 : 1;
    // Shoulders: up on the upper-front of the body, above + ahead of the hips so arms and
    // legs read as separate limbs.
    const attachment: Vec3 = [side * 0.34 * CREATURE_SCALE, 0.12 * CREATURE_SCALE, 0.18 * CREATURE_SCALE];
    // Rest pose reaches out to the SIDE (slightly forward + down) at ~85% arm length, so
    // the arms sit at the body's sides where they're visible (the near-straight chain has
    // no ambiguous elbow fold for FABRIK to flip).
    const reach = vec3.scale([0, 0, 0], vec3.normalize([0, 0, 0], [side * 1.0, -0.15, 0.45]), ARM_LENGTH * 0.85);
    const restEnd: Vec3 = [attachment[0] + reach[0], attachment[1] + reach[1], attachment[2] + reach[2]];
    return { attachment, restEnd, segments: ARM_SEGMENTS, length: ARM_LENGTH, phaseOffset: i, rotor: ARM_JOINT_ROTOR };
});

// Eyes, body-local: centred on the body height, bulging out past the front face.
const EYE_OFFSETS: Vec3[] = [
    [-0.18 * CREATURE_SCALE, 0, 0.56 * CREATURE_SCALE],
    [0.18 * CREATURE_SCALE, 0, 0.56 * CREATURE_SCALE],
];
const EYE_QUATERNION: Quat = quat.setAxisAngle(quat.create(), [1, 0, 0], -0.15);

/* ---------------- state ---------------- */

type LimbState = {
    def: LimbDef;
    chain: Chain;
    footPlacement: Vec3; // world, legs only
    goal: Vec3; // world
    current: Vec3; // world (interpolated effector)
    stepping: boolean;
    stepProgress: number;
    lastPhase: number; // gait phase last frame (legs only) — to detect the per-cycle step trigger
};

type Eye = {
    current: Vec3;
    prev: Vec3 | undefined;
    velocity: Vec3;
    local: Vec3; // iris offset in eye plane
};

type Creature = {
    agentId: string;
    position: Vec3; // driven from the agent (XZ) + ride height (Y)
    quaternion: Quat; // body yaw — turns to face movement direction
    speed: number; // horizontal speed (world units/s) — drives gait cadence + foot anticipation
    smoothSpeed: number; // low-passed speed — drives the (jitter-free) arm swing amplitude
    armPhase: number; // smoothly-accumulated arm-swing phase (0..1)
    cadence: number; // current gait cycles/sec (used to time step swings)
    stepCycleTime: number;
    bobPhase: number; // body-bob phase (0..1)
    hasTarget: boolean; // whether we're currently steering toward the player (vs stopped)
    lastTarget: Vec3; // the player position last issued as a target (for the REISSUE_DIST gate)
    legs: LimbState[];
    arms: LimbState[];
    eyes: Eye[];
    // BatchedMesh instance ids
    bodyInstance: number;
    legInstances: number[][]; // [leg][segment]
    armInstances: number[][];
    eyeInstances: { white: number; iris: number }[];
};

export type Creatures = {
    mesh: THREE.BatchedMesh;
    eyeMesh: THREE.BatchedMesh; // eyes are a separate mesh so they don't cast shadows
    material: THREE.MeshStandardMaterial;
    geo: { body: number; limb: number; eye: number }; // body/limb ids in `mesh`, eye id in `eyeMesh`
    list: Creature[];
};

/* ---------------- shared temporaries ---------------- */

const UP: Vec3 = [0, 1, 0];
const UNIT_X: Vec3 = [1, 0, 0];
const FORWARD: Vec3 = [0, 0, 1]; // body-local forward (the +Z the creature faces)

const _dir: Vec3 = [0, 0, 0];
const _mid: Vec3 = [0, 0, 0];
const _scaleV: Vec3 = [0, 0, 0];
const _q: Quat = quat.create();
const _m4 = mat4.create();
const _m4three = new THREE.Matrix4(); // transport for BatchedMesh.setMatrixAt
const _targetLocal: Vec3 = [0, 0, 0];
const _eyeWorld: Vec3 = [0, 0, 0];
const _eyeQuat: Quat = quat.create();
const _eyeRight: Vec3 = [0, 0, 0];
const _eyeUp: Vec3 = [0, 0, 0];
const _iris: Vec3 = [0, 0, 0];
const _targetQuat: Quat = quat.create();
const _quatConj: Quat = quat.create();
const _fwd: Vec3 = [0, 0, 0];
const _sample: Vec3 = [0, 0, 0];
const _snapped: Vec3 = [0, 0, 0];
const _bodyColor = new THREE.Color();
const _limbColor = new THREE.Color();
const _stop: Vec3 = [0, 0, 0];

const COLOR_EYE = new THREE.Color(0xffffff);
const COLOR_IRIS = new THREE.Color(0x111111);

const ease = (x: number): number => -(Math.cos(Math.PI * x) - 1) / 2;

// body-local point → world: out = pos + quat·local
function bodyToWorld(out: Vec3, local: Vec3, creature: Creature): Vec3 {
    vec3.transformQuat(out, local, creature.quaternion);
    out[0] += creature.position[0];
    out[1] += creature.position[1];
    out[2] += creature.position[2];
    return out;
}

// world point → body-local: out = quat⁻¹·(world - pos)
function worldToBodyLocal(out: Vec3, world: Vec3, creature: Creature): Vec3 {
    out[0] = world[0] - creature.position[0];
    out[1] = world[1] - creature.position[1];
    out[2] = world[2] - creature.position[2];
    quat.conjugate(_quatConj, creature.quaternion);
    vec3.transformQuat(out, out, _quatConj);
    return out;
}

/* ---------------- construction ---------------- */

function makeChain(def: LimbDef): Chain {
    const chain: Chain = { bones: [] };
    const segmentLength = def.length / def.segments;
    const prev: Vec3 = [0, 0, 0];
    for (let i = 0; i < def.segments; i++) {
        const s: Vec3 = [prev[0], prev[1], prev[2]];
        const e: Vec3 = [prev[0], prev[1] - segmentLength, prev[2]];
        chain.bones.push(bone(s, e, { type: JointConstraintType.BALL, rotor: def.rotor }));
        prev[1] = e[1];
    }
    return chain;
}

function makeLimbState(def: LimbDef): LimbState {
    return {
        def,
        chain: makeChain(def),
        footPlacement: [0, 0, 0],
        goal: [0, 0, 0],
        current: [0, 0, 0],
        stepping: false,
        stepProgress: 1,
        lastPhase: 0,
    };
}

export function initCreatures(scene: THREE.Scene): Creatures {
    const bodyGeo = new THREE.SphereGeometry(1, 16, 12);
    const limbGeo = new THREE.CylinderGeometry(1, 1, 1, 6); // unit radius/height, centred on Y
    const eyeGeo = new THREE.CircleGeometry(1, 20); // flat disc facing +Z

    const material = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });

    // Body + limbs: cast and receive shadows (they self-shadow each other).
    const bodyVerts = bodyGeo.attributes.position.count + limbGeo.attributes.position.count;
    const bodyIndices = (bodyGeo.index?.count ?? 0) + (limbGeo.index?.count ?? 0);
    const mesh = new THREE.BatchedMesh(MAX_CREATURES * BODY_INSTANCES_PER_CREATURE, bodyVerts, bodyIndices, material);
    mesh.perObjectFrustumCulled = false; // instances animate every frame
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Eyes: a separate mesh that never casts shadows — flat-disc shadows look wrong, and
    // the googly pupils shouldn't leave shadow specks on the floor.
    const eyeVerts = eyeGeo.attributes.position.count;
    const eyeIndices = eyeGeo.index?.count ?? 0;
    const eyeMesh = new THREE.BatchedMesh(MAX_CREATURES * EYE_INSTANCES_PER_CREATURE, eyeVerts, eyeIndices, material);
    eyeMesh.perObjectFrustumCulled = false;
    eyeMesh.frustumCulled = false;
    eyeMesh.castShadow = false;
    eyeMesh.receiveShadow = false;
    scene.add(eyeMesh);

    const geo = {
        body: mesh.addGeometry(bodyGeo),
        limb: mesh.addGeometry(limbGeo),
        eye: eyeMesh.addGeometry(eyeGeo),
    };

    return { mesh, eyeMesh, material, geo, list: [] };
}

export function spawnCreatures(creatures: Creatures, navigation: Navigation, count: number, center: Vec3): void {
    const agentParams = makeAgentParams(AGENT_RADIUS, HEIGHT, AGENT_MAX_SPEED);
    const n = Math.min(count, MAX_CREATURES - creatures.list.length);

    for (let i = 0; i < n; i++) {
        // spread the spawns evenly around a ring, then snap onto the navmesh so the crowd
        // agent has a valid poly (skip samples too far from any walkable surface).
        const angle = (i / n) * Math.PI * 2;
        _sample[0] = center[0] + Math.cos(angle) * SPAWN_RADIUS;
        _sample[1] = center[1];
        _sample[2] = center[2] + Math.sin(angle) * SPAWN_RADIUS;
        if (!snapToNavMesh(navigation, _sample, _snapped)) continue;

        // crowd.addAgent stores the position array BY REFERENCE and mutates it each step, so
        // every agent needs its OWN array — a shared scratch would collapse them to one point.
        const spawn: Vec3 = [_snapped[0], _snapped[1], _snapped[2]];
        const agentId = addCrowdAgent(navigation, spawn, agentParams);
        if (!agentId) continue;

        const legs = LEG_DEFS.map(makeLimbState);
        const arms = ARM_DEFS.map(makeLimbState);
        const eyes: Eye[] = Array.from({ length: N_EYES }, () => ({
            current: [0, 0, 0],
            prev: undefined,
            velocity: [0, 0, 0],
            local: [0, 0, 0],
        }));

        // Per-creature colour from the hand-picked palette (round-robin); limbs a touch
        // deeper. Set once here via setColorAt.
        const index = creatures.list.length;
        _bodyColor.setHex(CREATURE_PALETTE[index % CREATURE_PALETTE.length]);
        _limbColor.copy(_bodyColor).multiplyScalar(LIMB_DARKEN);

        const { mesh, eyeMesh, geo } = creatures;
        const bodyInstance = mesh.addInstance(geo.body);
        mesh.setColorAt(bodyInstance, _bodyColor);

        const legInstances = legs.map((leg) =>
            leg.chain.bones.map(() => {
                const id = mesh.addInstance(geo.limb);
                mesh.setColorAt(id, _limbColor);
                return id;
            }),
        );
        const armInstances = arms.map((arm) =>
            arm.chain.bones.map(() => {
                const id = mesh.addInstance(geo.limb);
                mesh.setColorAt(id, _limbColor);
                return id;
            }),
        );
        const eyeInstances = eyes.map(() => {
            const white = eyeMesh.addInstance(geo.eye);
            eyeMesh.setColorAt(white, COLOR_EYE);
            const iris = eyeMesh.addInstance(geo.eye);
            eyeMesh.setColorAt(iris, COLOR_IRIS);
            return { white, iris };
        });

        creatures.list.push({
            agentId,
            position: [_snapped[0], _snapped[1] + HEIGHT, _snapped[2]],
            quaternion: [0, 0, 0, 1],
            speed: 0,
            smoothSpeed: 0,
            armPhase: Math.random(), // desync the swing across creatures
            cadence: STEP_CADENCE_BASE,
            stepCycleTime: Math.random(),
            bobPhase: Math.random(),
            hasTarget: false,
            lastTarget: [Infinity, Infinity, Infinity],
            legs,
            arms,
            eyes,
            bodyInstance,
            legInstances,
            armInstances,
            eyeInstances,
        });
    }
}

/* ---------------- follow behaviour ---------------- */

// Steer every creature toward `target` (the player), gated so they hang back a little and
// don't jitter on top of it: only re-issue a target when the creature is beyond STOP_DISTANCE
// AND the player has moved > REISSUE_DIST since we last pathed to it; otherwise stop the agent.
export function setCreatureTargets(creatures: Creatures, navigation: Navigation, target: Vec3): void {
    for (const creature of creatures.list) {
        const agent = getAgent(navigation, creature.agentId);
        if (!agent) continue;
        const dx = target[0] - agent.position[0];
        const dz = target[2] - agent.position[2];
        const dist = Math.hypot(dx, dz);

        if (dist > STOP_DISTANCE) {
            const mdx = target[0] - creature.lastTarget[0];
            const mdz = target[2] - creature.lastTarget[2];
            if (!creature.hasTarget || Math.hypot(mdx, mdz) > REISSUE_DIST) {
                // aim for a point STOP_DISTANCE short of the player, so agents settle in a
                // loose ring around it rather than crowding the exact centre.
                const inv = 1 / dist;
                _stop[0] = target[0] - dx * inv * STOP_DISTANCE;
                _stop[1] = target[1];
                _stop[2] = target[2] - dz * inv * STOP_DISTANCE;
                if (setAgentTarget(navigation, creature.agentId, _stop)) {
                    creature.hasTarget = true;
                    vec3.copy(creature.lastTarget, target);
                }
            }
        } else if (creature.hasTarget) {
            setAgentVelocity(navigation, creature.agentId, [0, 0, 0]);
            creature.hasTarget = false;
        }
    }
}

/* ---------------- controller ---------------- */

// Read the crowd agent → drive facing (yaw toward travel), speed, the body ride height
// (agent Y + HEIGHT + bob). The feet plant at the agent's navmesh Y (no ground rays).
function driveFromAgent(creature: Creature, navigation: Navigation, dt: number): void {
    const agent = getAgent(navigation, creature.agentId);
    if (!agent) return;

    const ax = agent.position[0];
    const ay = agent.position[1]; // navmesh surface height → our ground
    const az = agent.position[2];

    // Turn to face the direction of travel (yaw around Y), slerping smoothly.
    const vx = agent.velocity[0];
    const vz = agent.velocity[2];
    creature.speed = Math.hypot(vx, vz);
    if (creature.speed > TURN_MIN_SPEED) {
        const yaw = Math.atan2(vx, vz); // angle that rotates forward (+Z) onto (vx,vz)
        quat.setAxisAngle(_targetQuat, UP, yaw);
        quat.slerp(creature.quaternion, creature.quaternion, _targetQuat, Math.min(TURN_RATE * dt, 1));
    }

    // movement bob: rise/dip with the gait, faded in by speed so idle creatures sit still
    const bobStrength = Math.min(creature.smoothSpeed / BOB_FULL_SPEED, 1);
    const bob = Math.sin(creature.bobPhase * Math.PI * 2 * BOB_CYCLES) * BOB_AMP * bobStrength;
    creature.position[0] = ax;
    creature.position[1] = ay + HEIGHT + bob;
    creature.position[2] = az;
}

function footPlacement(creature: Creature, groundY: number): void {
    const pos = creature.position;
    for (const leg of creature.legs) {
        // rest-foot offset (rotated by yaw) + anticipation ahead along travel, so the foot
        // plants where the body is GOING — centres the gait, no trailing.
        vec3.set(_dir, leg.def.restEnd[0], leg.def.restEnd[1], leg.def.restEnd[2]);
        vec3.transformQuat(_dir, _dir, creature.quaternion);
        vec3.transformQuat(_fwd, FORWARD, creature.quaternion);
        // lead the foot by a fraction of the current stride (= speed / cadence), so feet plant
        // AHEAD of the body proportionally at any pace, not lagging behind it.
        const stride = creature.cadence > 0 ? creature.speed / creature.cadence : 0;
        const lead = Math.min(stride * STEP_LEAD_FRACTION, STEP_LEAD_MAX);
        // plant at the agent's navmesh Y (the ground under the body); no ground raycast.
        vec3.set(leg.footPlacement, pos[0] + _dir[0] + _fwd[0] * lead, groundY, pos[2] + _dir[2] + _fwd[2] * lead);
    }
}

function stepping(creature: Creature, dt: number): void {
    for (const leg of creature.legs) {
        // detect this leg's once-per-cycle trigger as a phase wrap (robust to big per-frame
        // phase steps — a window check would miss them).
        const legPhase = (creature.stepCycleTime + leg.def.phaseOffset) % 1;
        const wrapped = legPhase < leg.lastPhase;
        leg.lastPhase = legPhase;

        if (leg.stepping) {
            // swing takes STEP_DURATION_FRAC of a gait cycle, regardless of speed
            leg.stepProgress += (dt * creature.cadence) / STEP_DURATION_FRAC;
            if (leg.stepProgress >= 1) {
                leg.stepProgress = 1;
                leg.stepping = false;
            }
        } else if (wrapped) {
            // new cycle for this leg → step, planting at the anticipated spot. (legs are
            // offset half a cycle apart → they alternate)
            leg.stepping = true;
            leg.stepProgress = 0;
            vec3.copy(leg.goal, leg.footPlacement);
        }

        if (leg.stepping) {
            // chase the LIVE anticipated landing spot (which leads the moving body), so the
            // foot lands ahead — not at a stale, already-behind snapshot.
            vec3.copy(leg.goal, leg.footPlacement);
            vec3.lerp(leg.current, leg.current, leg.goal, leg.stepProgress);
            const eased = ease(leg.stepProgress);
            if (eased > 0 && eased < 1) leg.current[1] += Math.sin(eased * Math.PI) * STEP_ARC_HEIGHT;
        } else {
            // planted: hold the last landing spot (chase gently in case the body drifted)
            vec3.lerp(leg.current, leg.current, leg.footPlacement, Math.min(dt * 6, 1));
        }
    }
}

// Solve the chain to targetLocal. When reset is true, the chain is first re-straightened
// toward restEnd (consistent bend bias — good for legs whose targets jump around). When
// false, FABRIK warm-starts from the current pose for temporal coherence (no elbow-fold
// flips) — used for the idle arms.
function solveLimb(limb: LimbState, targetLocal: Vec3, reset: boolean, iterations: number): void {
    const def = limb.def;

    if (reset) {
        const segmentLength = def.length / def.segments;
        vec3.sub(_dir, def.restEnd, def.attachment);
        vec3.normalize(_dir, _dir);
        vec3.scale(_dir, _dir, segmentLength);

        for (let i = 0; i < limb.chain.bones.length; i++) {
            const b = limb.chain.bones[i];
            const start = i === 0 ? def.attachment : limb.chain.bones[i - 1].end;
            b.start[0] = start[0];
            b.start[1] = start[1];
            b.start[2] = start[2];
            b.end[0] = b.start[0] + _dir[0];
            b.end[1] = b.start[1] + _dir[1];
            b.end[2] = b.start[2] + _dir[2];
        }
    }

    fabrikFixedIterations(limb.chain, def.attachment, targetLocal, iterations);
}

function solveLegs(creature: Creature): void {
    for (const leg of creature.legs) {
        worldToBodyLocal(_targetLocal, leg.current, creature);
        solveLimb(leg, _targetLocal, true, LEG_IK_ITERATIONS); // FABRIK: organic creature-leg bend
    }
}

// The idle arm-swing rest target (body-local), for arm `i`. Aims the hand a near-full-arm-
// length from the shoulder, out + down, swinging fore/aft. Keeping it near full extension
// means the long noodly arm stays taut and just POINTS — no chaotic folding.
function armRestTarget(creature: Creature, i: number, out: Vec3): void {
    const arm = creature.arms[i];
    const side = i === 0 ? -1 : 1;
    const swing = Math.sin((creature.armPhase + i * 0.5) * Math.PI * 2); // −1..1, arms opposite
    const speedFrac = Math.min(creature.smoothSpeed / AGENT_MAX_SPEED, 1);
    // Fade the whole swing out when idle so the arms hang still instead of twitching.
    const idleGate = Math.min(creature.smoothSpeed / IDLE_SPEED, 1);
    const swingAmt = (ARM_SWING_AMP_BASE + ARM_SWING_AMP_GAIN * speedFrac) * idleGate;
    const fore = swing * swingAmt; // fore/aft, bigger when moving
    // 'U' arc: the hand lifts at the fore/aft extremes (swing²) and dips through the centre.
    const lift = ARM_U_LIFT * swing * swing * swingAmt;
    vec3.set(_dir, side * ARM_OUT, -ARM_DOWN + lift, fore);
    vec3.normalize(_dir, _dir);
    const reach = ARM_LENGTH * ARM_EXTEND;
    out[0] = arm.def.attachment[0] + _dir[0] * reach;
    out[1] = arm.def.attachment[1] + _dir[1] * reach;
    out[2] = arm.def.attachment[2] + _dir[2] * reach;
}

function solveArms(creature: Creature): void {
    for (let i = 0; i < creature.arms.length; i++) {
        armRestTarget(creature, i, _targetLocal);
        solveLimb(creature.arms[i], _targetLocal, false, ARM_IK_ITERATIONS); // warm-start → smooth, no fold-flip
    }
}

// Advance both googly pupils. Computes the eye's world facing once so the physics runs in
// the eye's own plane — the pupils droop toward true world-down and swing round as the body
// tilts, not just when it's upright.
function updateEyes(creature: Creature, dt: number): void {
    quat.mul(_eyeQuat, creature.quaternion, EYE_QUATERNION);
    vec3.transformQuat(_eyeRight, UNIT_X, _eyeQuat); // eye-plane +X in world space
    vec3.transformQuat(_eyeUp, UP, _eyeQuat); // eye-plane +Y in world space
    for (let i = 0; i < creature.eyes.length; i++) {
        bodyToWorld(_eyeWorld, EYE_OFFSETS[i], creature);
        updateEye(creature.eyes[i], _eyeWorld, EYE_INERTIA_WALK, EYE_GRAVITY_WALK, EYE_CENTER_WALK, dt);
    }
}

// Googly pupil: a free bead rolling in the eye's 2D plane. Driven by two forces projected
// onto the plane basis (_eyeRight/_eyeUp): world gravity (sags toward the true low point of
// the eye as the head rolls); and a pseudo-force opposite the socket's ACCELERATION, so every
// footfall and turn flings it. A centering spring holds the walking gaze forward. Bounces off
// the rim. All in normalised (eye-radius) units.
function updateEye(eye: Eye, worldPos: Vec3, inertia: number, gravity: number, center: number, dt: number): void {
    if (!eye.prev) {
        // First frame: seed the socket position + velocity, skip (no bogus fling).
        eye.prev = [0, 0, 0];
        vec3.copy(eye.current, worldPos);
        return;
    }
    if (dt <= 0) {
        vec3.copy(eye.current, worldPos);
        return;
    }

    // Socket world velocity this frame, and its change since last frame (acceleration).
    const invDt = 1 / dt;
    const vx = (worldPos[0] - eye.current[0]) * invDt;
    const vy = (worldPos[1] - eye.current[1]) * invDt;
    const vz = (worldPos[2] - eye.current[2]) * invDt;
    const pv = eye.prev;
    const ax = (vx - pv[0]) * invDt;
    const ay = (vy - pv[1]) * invDt;
    const az = (vz - pv[2]) * invDt;
    pv[0] = vx;
    pv[1] = vy;
    pv[2] = vz;
    vec3.copy(eye.current, worldPos);

    // Socket acceleration and world-down gravity, both projected into the eye plane.
    const invR = 1 / EYE_RADIUS;
    const aRight = (ax * _eyeRight[0] + ay * _eyeRight[1] + az * _eyeRight[2]) * invR;
    const aUp = (ax * _eyeUp[0] + ay * _eyeUp[1] + az * _eyeUp[2]) * invR;
    const gRight = -_eyeRight[1];
    const gUp = -_eyeUp[1];

    // gravity pulls toward the low point; a centering spring pulls back to forward;
    // -acceleration flings the pupil (inertia)
    eye.velocity[0] += (gRight * gravity - center * eye.local[0] - aRight * inertia) * dt;
    eye.velocity[1] += (gUp * gravity - center * eye.local[1] - aUp * inertia) * dt;

    const damp = EYE_DAMP ** (dt * 60);
    eye.velocity[0] *= damp;
    eye.velocity[1] *= damp;

    eye.local[0] += eye.velocity[0] * dt;
    eye.local[1] += eye.velocity[1] * dt;
    eye.local[2] = 0;

    // keep the pupil inside the eye, bouncing off the rim
    const dist = Math.hypot(eye.local[0], eye.local[1]);
    if (dist > EYE_MAX) {
        const nx = eye.local[0] / dist;
        const ny = eye.local[1] / dist;
        const d = eye.velocity[0] * nx + eye.velocity[1] * ny;
        eye.velocity[0] = (eye.velocity[0] - 2 * d * nx) * EYE_RESTITUTION;
        eye.velocity[1] = (eye.velocity[1] - 2 * d * ny) * EYE_RESTITUTION;
        eye.local[0] = nx * EYE_MAX;
        eye.local[1] = ny * EYE_MAX;
    }
}

/* ---------------- instance writing ---------------- */

function setInstance(mesh: THREE.BatchedMesh, id: number, position: Vec3, rotation: Quat, scale: Vec3): void {
    mat4.fromRotationTranslationScale(_m4, rotation, position, scale);
    _m4three.fromArray(_m4);
    mesh.setMatrixAt(id, _m4three);
}

function writeLimb(mesh: THREE.BatchedMesh, creature: Creature, chain: Chain, ids: number[], radius: number): void {
    for (let i = 0; i < chain.bones.length; i++) {
        const b = chain.bones[i];
        // bone midpoint (body-local) → world by the body yaw
        _mid[0] = (b.start[0] + b.end[0]) * 0.5;
        _mid[1] = (b.start[1] + b.end[1]) * 0.5;
        _mid[2] = (b.start[2] + b.end[2]) * 0.5;
        bodyToWorld(_mid, _mid, creature);
        // bone direction (body-local) → world by the body yaw
        vec3.sub(_dir, b.end, b.start);
        vec3.transformQuat(_dir, _dir, creature.quaternion);
        vec3.normalize(_dir, _dir);
        quat.rotationTo(_q, UP, _dir);
        vec3.set(_scaleV, radius, b.length, radius);
        setInstance(mesh, ids[i], _mid, _q, _scaleV);
    }
}

function writeCreature(creatures: Creatures, creature: Creature): void {
    const { mesh, eyeMesh } = creatures;
    const pos = creature.position;

    // body
    vec3.set(_scaleV, BODY_RADIUS, BODY_RADIUS, BODY_RADIUS);
    setInstance(mesh, creature.bodyInstance, pos, creature.quaternion, _scaleV);

    // legs + arms
    for (let i = 0; i < creature.legs.length; i++)
        writeLimb(mesh, creature, creature.legs[i].chain, creature.legInstances[i], LEG_RADIUS);
    for (let i = 0; i < creature.arms.length; i++)
        writeLimb(mesh, creature, creature.arms[i].chain, creature.armInstances[i], ARM_RADIUS);

    // eyes — offset + facing rotated by the body yaw
    quat.mul(_eyeQuat, creature.quaternion, EYE_QUATERNION);
    for (let i = 0; i < creature.eyes.length; i++) {
        const inst = creature.eyeInstances[i];
        bodyToWorld(_eyeWorld, EYE_OFFSETS[i], creature);

        vec3.set(_scaleV, EYE_RADIUS, EYE_RADIUS, EYE_RADIUS);
        setInstance(eyeMesh, inst.white, _eyeWorld, _eyeQuat, _scaleV);

        // iris: offset within the eye plane (jiggle) + slightly proud of the surface
        vec3.set(_iris, creature.eyes[i].local[0] * EYE_RADIUS, creature.eyes[i].local[1] * EYE_RADIUS, EYE_RADIUS * 0.15);
        vec3.transformQuat(_iris, _iris, _eyeQuat);
        vec3.add(_iris, _iris, _eyeWorld);
        vec3.set(_scaleV, IRIS_RADIUS, IRIS_RADIUS, IRIS_RADIUS);
        setInstance(eyeMesh, inst.iris, _iris, _eyeQuat, _scaleV);
    }
}

/* ---------------- public update ---------------- */

// Read each agent's position/velocity → drive facing, speed-smoothing, gait/bob/arms/eyes →
// write the BatchedMesh instances. `dt` is the render frame time.
export function updateCreatures(creatures: Creatures, navigation: Navigation, dt: number): void {
    for (const creature of creatures.list) {
        const agent = getAgent(navigation, creature.agentId);
        const groundY = agent ? agent.position[1] : creature.position[1] - HEIGHT;

        driveFromAgent(creature, navigation, dt);

        // cadence rises with speed → quicker steps when running
        const cadence = STEP_CADENCE_BASE + creature.speed * STEP_CADENCE_GAIN;
        creature.cadence = cadence;
        // Freeze the gait cycle when idle so the feet don't shuffle in place; in-progress
        // steps still finish (stepProgress runs on the raw cadence in stepping()).
        const moveGate = Math.min(creature.smoothSpeed / IDLE_SPEED, 1);
        creature.stepCycleTime = (creature.stepCycleTime + dt * cadence * moveGate) % 1;
        // bob advances at the gait cadence but capped, so fast steps don't heave frantically
        creature.bobPhase = (creature.bobPhase + dt * Math.min(cadence, BOB_MAX_CADENCE)) % 1;

        footPlacement(creature, groundY);
        stepping(creature, dt);
        solveLegs(creature);

        // Advance the SMOOTH arm-swing drivers (low-passed speed + accumulated phase) so the
        // swing stays stable even as the crowd velocity / cadence jitters.
        creature.smoothSpeed += (creature.speed - creature.smoothSpeed) * Math.min(dt * ARM_SWING_SMOOTH, 1);
        const armFreq = ARM_SWING_FREQ_BASE + creature.smoothSpeed * ARM_SWING_FREQ_GAIN;
        creature.armPhase = (creature.armPhase + dt * armFreq) % 1;
        solveArms(creature);

        updateEyes(creature, dt);

        writeCreature(creatures, creature);
    }
}
