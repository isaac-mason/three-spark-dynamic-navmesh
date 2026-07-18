import {
    addBroadphaseLayer,
    addObjectLayer,
    type BodyId,
    createWorld,
    createWorldSettings,
    enableCollision,
    MotionType,
    type RigidBody,
    registerAll,
    rigidBody,
    type Shape,
    sphere,
    triangleMesh,
    updateWorld,
    type World,
} from 'crashcat';
import type { Vec3 } from 'mathcat';
import { GRAVITY } from './scene';

// Register all shapes & constraints up front. Simplest during development; swap for
// granular registerShapes/registerConstraints later for better tree-shaking.
registerAll();

const settings = createWorldSettings();
settings.gravity = GRAVITY;

export const BROADPHASE_LAYER_NON_MOVING = addBroadphaseLayer(settings);
export const BROADPHASE_LAYER_MOVING = addBroadphaseLayer(settings);

// Static world geometry (the collider trimesh) is NON_MOVING; the character and the
// dynamic reflector balls are MOVING. The character controller (character.ts) casts
// rays against both, and pushes the balls around, so both pairs collide.
export const LAYER_NON_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_NON_MOVING);
export const LAYER_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);

enableCollision(settings, LAYER_NON_MOVING, LAYER_MOVING);
enableCollision(settings, LAYER_MOVING, LAYER_MOVING);

export type Physics = {
    world: World;
};

export function initPhysics(): Physics {
    return { world: createWorld(settings) };
}

// Clamp the frame delta so a long pause (e.g. tab refocus) can't blow up the sim.
const MAX_DELTA = 1 / 30;

export function updatePhysics(physics: Physics, dt: number): void {
    updateWorld(physics.world, undefined, Math.min(dt, MAX_DELTA));
}

/**
 * Add a static triangle-mesh body from a triangle soup (world-space positions +
 * indices). Returns the body so the caller can remove/rebuild it. Don't hold the
 * reference across a removal — bodies are pooled (see crashcat README).
 */
export function createTriangleMeshBody(physics: Physics, positions: number[], indices: number[]): RigidBody {
    const shape: Shape = triangleMesh.create({ positions, indices });
    return rigidBody.create(physics.world, {
        shape,
        motionType: MotionType.STATIC,
        objectLayer: LAYER_NON_MOVING,
    });
}

/** Remove a body previously returned by one of the create* helpers. */
export function removeBody(physics: Physics, body: RigidBody): void {
    rigidBody.remove(physics.world, body);
}

/** Add a dynamic sphere the character can bump into (the reflector balls). */
export function createDynamicSphere(
    physics: Physics,
    position: Vec3,
    radius: number,
    opts: { mass?: number; friction?: number; restitution?: number; linearDamping?: number; angularDamping?: number } = {},
): RigidBody {
    return rigidBody.create(physics.world, {
        shape: sphere.create({ radius }),
        position,
        motionType: MotionType.DYNAMIC,
        objectLayer: LAYER_MOVING,
        mass: opts.mass ?? 1,
        friction: opts.friction ?? 0.4,
        restitution: opts.restitution ?? 0.1,
        linearDamping: opts.linearDamping ?? 0.02,
        angularDamping: opts.angularDamping ?? 0.05,
    });
}

export type { BodyId, RigidBody };
