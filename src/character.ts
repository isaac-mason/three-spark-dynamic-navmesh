import {
    CastRayStatus,
    capsule,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    type Filter,
    filter,
    MotionType,
    type RigidBody,
    rigidBody,
    type Shape,
    type World,
} from 'crashcat';
import { quat, type Vec3, vec3 } from 'mathcat';
import { LAYER_MOVING, type Physics } from './physics';
import { CHARACTER_CAPSULE_HEIGHT, CHARACTER_SPAWN, type Tuning } from './scene';

// A floating (spring-suspended) character controller ported from crashcat's
// example-floating-character-controller, itself modelled on pmndrs/ecctrl. Unlike a
// swept kinematic capsule (KCC), the body is a real DYNAMIC rigid body held a fixed
// float height above the ground by a spring-damper, kept upright by an auto-balance
// torque, and driven by impulses. That's what lets it shove the dynamic reflector
// balls around and ride moving surfaces for free.

// The capsule: total height = cylinder + two radius hemispheres (see scene.ts).
const CAPSULE_RADIUS = 0.55 * 1.5;
const CAPSULE_HALF_HEIGHT = CHARACTER_CAPSULE_HEIGHT / 2 - CAPSULE_RADIUS;
/** Distance from the body centre down to the feet (half-cylinder + bottom hemisphere). */
export const CHARACTER_FEET_OFFSET = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;

export type Character = {
    body: RigidBody;
    shape: Shape;
    filter: Filter;

    // --- configuration ---
    capsuleRadius: number;
    capsuleHalfHeight: number;
    floatHeight: number;
    slopeRayOffset: number;

    // floating spring-damper
    floatSpringK: number;
    floatDampingC: number;

    // movement (maxWalk/maxRun/jump/turn/airControl are synced from Tuning each frame)
    maxWalkSpeed: number;
    maxRunSpeed: number;
    accelerationTime: number;
    turnSpeed: number;
    turnVelMultiplier: number;
    airControlFactor: number;
    rejectVelMult: number;
    dragDampingC: number;
    moveImpulsePointY: number;

    // slope
    maxSlopeAngle: number;
    slopeUpExtraForce: number;
    slopeDownExtraForce: number;

    // auto-balance (keeps the dynamic body upright)
    enableAutoBalance: boolean;
    balanceSpringK: number;
    balanceDampingC: number;
    balanceSpringOnY: number;
    balanceDampingOnY: number;

    // jump
    jumpVelocity: number;
    jumpForceToGroundMult: number;
    slopeJumpMult: number;
    sprintJumpMult: number;

    // gravity
    normalGravityScale: number;
    fallingGravityScale: number;
    maxFallSpeed: number;

    // ray forgiveness
    rayHitForgiveness: number;

    // --- runtime: ground detection ---
    isOnGround: boolean;
    isFalling: boolean;
    canJump: boolean;
    slopeAngle: number;
    actualSlopeNormal: Vec3;
    actualSlopeAngle: number;
    groundBodyId: number | null;
    groundSubShapeId: number;
    groundPosition: Vec3;
    groundDistance: number;

    // --- runtime: moving platforms ---
    isOnMovingObject: boolean;
    massRatio: number;
    movingObjectVelocity: Vec3;

    // --- runtime: facing rotation (drives the visual model's yaw) ---
    facingYaw: number;
    facingComplete: boolean;

    // --- runtime: contact forces ---
    bodyContactForce: Vec3;
    characterMassForce: Vec3;

    // --- input (world-space horizontal move dir + intent) ---
    moveDirection: Vec3;
    wantToRun: boolean;
    wantToJump: boolean;
};

export type MovementInput = {
    /** World-space, camera-relative horizontal move direction (any magnitude). */
    moveDir: Vec3;
    jump: boolean;
    run: boolean;
};

export function initCharacter(physics: Physics): Character {
    const capsuleRadius = CAPSULE_RADIUS;
    const capsuleHalfHeight = CAPSULE_HALF_HEIGHT;
    const enableAutoBalance = true;

    const shape = capsule.create({ halfHeightOfCylinder: capsuleHalfHeight, radius: capsuleRadius });

    const body = rigidBody.create(physics.world, {
        shape,
        motionType: MotionType.DYNAMIC,
        position: [CHARACTER_SPAWN[0], CHARACTER_SPAWN[1] + capsuleHalfHeight + capsuleRadius, CHARACTER_SPAWN[2]],
        objectLayer: LAYER_MOVING,
        friction: 0.5,
        restitution: 0,
        linearDamping: 0,
        angularDamping: 0,
        mass: 1,
        // all six DOF if we auto-balance, else lock rotation (translation only).
        allowedDegreesOfFreedom: enableAutoBalance ? 0b111111 : 0b111000,
    });
    body.motionProperties.gravityFactor = 1;

    return {
        body,
        shape,
        filter: filter.create(physics.world.settings.layers),

        capsuleRadius,
        capsuleHalfHeight,
        floatHeight: 0.3,
        slopeRayOffset: capsuleRadius - 0.03,

        floatSpringK: 1.2,
        floatDampingC: 0.08,

        maxWalkSpeed: 8,
        maxRunSpeed: 13,
        accelerationTime: 8,
        turnSpeed: 40,
        turnVelMultiplier: 0.2,
        airControlFactor: 0.2,
        rejectVelMult: 4,
        dragDampingC: 0.15,
        moveImpulsePointY: 0.5,

        maxSlopeAngle: 1,
        slopeUpExtraForce: 0.1,
        slopeDownExtraForce: 0.2,

        enableAutoBalance,
        balanceSpringK: 0.2,
        balanceDampingC: 0.1,
        balanceSpringOnY: 0.3,
        balanceDampingOnY: 0.05,

        jumpVelocity: 6,
        jumpForceToGroundMult: 5,
        slopeJumpMult: 0.25,
        sprintJumpMult: 1.2,

        normalGravityScale: 1,
        fallingGravityScale: 2.5,
        maxFallSpeed: 20,

        rayHitForgiveness: 0.1,

        isOnGround: false,
        isFalling: false,
        canJump: false,
        slopeAngle: 0,
        actualSlopeNormal: vec3.fromValues(0, 1, 0),
        actualSlopeAngle: 0,
        groundBodyId: null,
        groundSubShapeId: 0,
        groundPosition: vec3.create(),
        groundDistance: 0,

        isOnMovingObject: false,
        massRatio: 1,
        movingObjectVelocity: vec3.create(),

        facingYaw: 0,
        facingComplete: true,

        bodyContactForce: vec3.create(),
        characterMassForce: vec3.create(),

        moveDirection: vec3.create(),
        wantToRun: false,
        wantToJump: false,
    };
}

// --- Scratch vectors — reused each frame to avoid per-frame allocation. ---
const _rayOrigin: Vec3 = vec3.create();
const _forward: Vec3 = vec3.create();
const _slopeRayOrigin: Vec3 = vec3.create();
const _indicatorQuat = quat.create();
const _movingObjInCharDir: Vec3 = vec3.create();
const _balanceForward: Vec3 = vec3.create();
const _crossX: Vec3 = vec3.create();
const _crossY: Vec3 = vec3.create();
const _crossZ: Vec3 = vec3.create();
const _charToObj: Vec3 = vec3.create();
const _angvelToLinvel: Vec3 = vec3.create();
const _velocityDiff: Vec3 = vec3.create();
const _jumpDirection: Vec3 = vec3.create();
const _jumpProjection: Vec3 = vec3.create();
const _moveDir: Vec3 = vec3.create();

const rayCollector = createClosestCastRayCollector();
const raySettings = createDefaultCastRaySettings();

// A body filter that ignores a single body (the character's own body) during ground
// ray casts, chaining any existing filter. Reset after each cast.
const ignoreState = {
    bodyId: -1,
    innerBodyFilter: undefined as ((body: RigidBody) => boolean) | undefined,
};

function ignoreSingleBodyFilter(body: RigidBody): boolean {
    if (body.id === ignoreState.bodyId) return false;
    if (ignoreState.innerBodyFilter) return ignoreState.innerBodyFilter(body);
    return true;
}

function setIgnoreSingleBody(f: Filter, ignoreBodyId: number): void {
    ignoreState.bodyId = ignoreBodyId;
    ignoreState.innerBodyFilter = f.bodyFilter;
    f.bodyFilter = ignoreSingleBodyFilter;
}

function resetIgnoreSingleBody(f: Filter): void {
    f.bodyFilter = ignoreState.innerBodyFilter;
    ignoreState.bodyId = -1;
    ignoreState.innerBodyFilter = undefined;
}

function updateGroundDetection(world: World, c: Character): void {
    const p = c.body.position;
    _rayOrigin[0] = p[0];
    _rayOrigin[1] = p[1] - c.capsuleHalfHeight;
    _rayOrigin[2] = p[2];

    const rayLength = c.capsuleRadius + 2;
    setIgnoreSingleBody(c.filter, c.body.id);
    rayCollector.reset();
    castRay(world, rayCollector, raySettings, _rayOrigin, [0, -1, 0], rayLength, c.filter);
    resetIgnoreSingleBody(c.filter);

    const floatingDis = c.capsuleRadius + c.floatHeight;

    if (rayCollector.hit.status === CastRayStatus.COLLIDING) {
        const hitDistance = rayCollector.hit.fraction * rayLength;
        if (hitDistance < floatingDis + c.rayHitForgiveness) {
            c.isOnGround = true;
            c.groundDistance = hitDistance;
            c.groundPosition = [_rayOrigin[0], _rayOrigin[1] - hitDistance, _rayOrigin[2]];
            c.groundBodyId = rayCollector.hit.bodyIdB;
            c.groundSubShapeId = rayCollector.hit.subShapeId;
            return;
        }
    }
    c.isOnGround = false;
    c.canJump = false;
    c.groundBodyId = null;
    c.groundSubShapeId = 0;
    c.groundDistance = 0;
    c.actualSlopeAngle = 0;
}

function updateSlopeDetection(world: World, c: Character): void {
    if (!c.isOnGround) {
        c.slopeAngle = 0;
        c.actualSlopeNormal = [0, 1, 0];
        c.canJump = false;
        return;
    }

    // character forward, offset the slope ray forward from centre.
    _forward[0] = 0;
    _forward[1] = 0;
    _forward[2] = 1;
    vec3.transformQuat(_forward, _forward, c.body.quaternion);

    const p = c.body.position;
    _slopeRayOrigin[0] = p[0] + _forward[0] * c.slopeRayOffset;
    _slopeRayOrigin[1] = p[1] - c.capsuleHalfHeight;
    _slopeRayOrigin[2] = p[2] + _forward[2] * c.slopeRayOffset;

    const rayLength = c.capsuleRadius + 3;
    setIgnoreSingleBody(c.filter, c.body.id);
    rayCollector.reset();
    castRay(world, rayCollector, raySettings, _slopeRayOrigin, [0, -1, 0], rayLength, c.filter);
    resetIgnoreSingleBody(c.filter);

    const floatingDis = c.capsuleRadius + c.floatHeight;

    if (rayCollector.hit.status === CastRayStatus.COLLIDING && rayCollector.hit.fraction * rayLength < floatingDis + 0.5) {
        const slopeRayDistance = rayCollector.hit.fraction * rayLength;
        const slopeAngle = Math.atan((c.groundDistance - slopeRayDistance) / c.slopeRayOffset);
        c.slopeAngle = Number(slopeAngle.toFixed(2));

        if (c.groundBodyId !== null) {
            const groundBody = rigidBody.get(world, c.groundBodyId);
            if (groundBody) {
                rigidBody.getSurfaceNormal(c.actualSlopeNormal, groundBody, c.groundPosition, c.groundSubShapeId);
                c.actualSlopeAngle = Math.acos(Math.max(-1, Math.min(1, vec3.dot(c.actualSlopeNormal, [0, 1, 0] as Vec3))));
                c.canJump = c.actualSlopeAngle < c.maxSlopeAngle;
                return;
            }
        }
    }
    c.slopeAngle = 0;
    c.actualSlopeNormal = [0, 1, 0];
    c.actualSlopeAngle = 0;
    c.canJump = false;
}

function applyFloatingForce(world: World, c: Character): void {
    if (!c.isOnGround || c.groundBodyId === null) return;
    const groundBody = rigidBody.get(world, c.groundBodyId);
    if (!groundBody) return;

    const floatingDis = c.capsuleRadius + c.floatHeight;
    const displacement = floatingDis - c.groundDistance;
    const verticalVelocity = c.body.motionProperties.linearVelocity[1];

    // spring-damper: F = k·x − c·v, applied as a per-frame impulse.
    const floatingForce = c.floatSpringK * displacement - c.floatDampingC * verticalVelocity;
    rigidBody.addImpulse(world, c.body, [0, floatingForce, 0]);

    c.characterMassForce[0] = 0;
    c.characterMassForce[1] = floatingForce > 0 ? -floatingForce : 0;
    c.characterMassForce[2] = 0;

    // Newton's third law: push back on the ground body (moving platforms / balls).
    if (groundBody.motionType === MotionType.DYNAMIC || groundBody.motionType === MotionType.KINEMATIC) {
        rigidBody.addImpulseAtPosition(world, groundBody, c.characterMassForce, c.groundPosition);
    }
}

function applyMovementForce(world: World, c: Character): void {
    const run = c.wantToRun;
    const maxVelLimit = run ? c.maxRunSpeed : c.maxWalkSpeed;

    // moving direction, tilted along the slope when it's walkable.
    let movingDirection: Vec3 = [0, 0, 1];
    if (c.actualSlopeAngle < c.maxSlopeAngle && Math.abs(c.slopeAngle) > 0.2 && Math.abs(c.slopeAngle) < c.maxSlopeAngle) {
        movingDirection = [0, Math.sin(c.slopeAngle), Math.cos(c.slopeAngle)];
    } else if (c.actualSlopeAngle >= c.maxSlopeAngle) {
        movingDirection = [0, Math.sin(c.slopeAngle) > 0 ? 0 : Math.sin(c.slopeAngle), Math.sin(c.slopeAngle) > 0 ? 0.1 : 1];
    }

    // Steer the movement force by the raw input heading, so movement is INSTANT — the
    // eased c.facingYaw drives only the visual model (see character-visuals.ts), never the
    // physics. (The crashcat example rotated movement by the smoothed indicator instead,
    // which made the character arc toward its new heading; we want a snappy response.)
    const moveYaw = Math.atan2(c.moveDirection[0], c.moveDirection[2]);
    quat.setAxisAngle(_indicatorQuat, [0, 1, 0], moveYaw);
    vec3.transformQuat(movingDirection, movingDirection, _indicatorQuat);

    const currentVel = c.body.motionProperties.linearVelocity;

    const movingObjectDot = vec3.dot(c.movingObjectVelocity, movingDirection);
    vec3.scale(_movingObjInCharDir, movingDirection, movingObjectDot);

    const angleBetween = Math.acos(
        Math.max(
            -1,
            Math.min(
                1,
                vec3.dot(c.movingObjectVelocity, movingDirection) /
                    (vec3.length(c.movingObjectVelocity) * vec3.length(movingDirection) + 0.0001),
            ),
        ),
    );

    // rejection velocity — bleed off motion perpendicular to the wish direction.
    const wantToMoveMag = currentVel[0] * movingDirection[0] + currentVel[2] * movingDirection[2];
    const wantToMoveVel: Vec3 = [movingDirection[0] * wantToMoveMag, 0, movingDirection[2] * wantToMoveMag];
    const rejectVel: Vec3 = [currentVel[0] - wantToMoveVel[0], 0, currentVel[2] - wantToMoveVel[2]];

    // a = Δv/Δt, folding in platform velocity and rejection. F = ma (mass = 1).
    const moveForceNeeded: Vec3 = [
        (movingDirection[0] * (maxVelLimit + _movingObjInCharDir[0]) -
            (currentVel[0] -
                c.movingObjectVelocity[0] * Math.sin(angleBetween) +
                rejectVel[0] * (c.isOnMovingObject ? 0 : c.rejectVelMult))) /
            c.accelerationTime,
        0,
        (movingDirection[2] * (maxVelLimit + _movingObjInCharDir[2]) -
            (currentVel[2] -
                c.movingObjectVelocity[2] * Math.sin(angleBetween) +
                rejectVel[2] * (c.isOnMovingObject ? 0 : c.rejectVelMult))) /
            c.accelerationTime,
    ];

    // Movement is instant (steered by the raw input heading above), so there's no
    // mid-turn control penalty — only the air-control reduction remains.
    const controlMult = 1;
    const airMult = c.canJump ? 1 : c.airControlFactor;

    let slopeImpulseY = 0;
    if (c.slopeAngle !== 0) {
        slopeImpulseY =
            movingDirection[1] *
            (movingDirection[1] > 0 ? c.slopeUpExtraForce : c.slopeDownExtraForce) *
            (run ? c.maxRunSpeed / c.maxWalkSpeed : 1);
    }

    const moveImpulse: Vec3 = [
        moveForceNeeded[0] * controlMult * airMult,
        slopeImpulseY,
        moveForceNeeded[2] * controlMult * airMult,
    ];

    const p = c.body.position;
    rigidBody.addImpulseAtPosition(world, c.body, moveImpulse, [p[0], p[1] + c.moveImpulsePointY, p[2]]);

    // opposite drag on a dynamic platform we're pushing off.
    if (c.isOnMovingObject && c.groundBodyId !== null) {
        const groundBody = rigidBody.get(world, c.groundBodyId);
        if (groundBody && groundBody.motionType === MotionType.DYNAMIC) {
            const drag: Vec3 = [
                -moveImpulse[0] * Math.min(1, 1 / c.massRatio),
                0,
                -moveImpulse[2] * Math.min(1, 1 / c.massRatio),
            ];
            rigidBody.addImpulseAtPosition(world, groundBody, drag, c.groundPosition);
        }
    }
}

function applyAutoBalanceTorque(world: World, c: Character): void {
    if (!c.enableAutoBalance) return;

    const bodyUp: Vec3 = [0, 1, 0];
    vec3.transformQuat(bodyUp, bodyUp, c.body.quaternion);
    const bodyForward: Vec3 = [0, 0, 1];
    vec3.transformQuat(bodyForward, bodyForward, c.body.quaternion);

    const desiredUp: Vec3 = [0, 1, 0];
    if (vec3.length(c.moveDirection) > 0.001) vec3.normalize(_balanceForward, c.moveDirection);
    else vec3.copy(_balanceForward, bodyForward);

    const bodyBalanceOnX: Vec3 = [0, bodyUp[1], bodyUp[2]];
    const bodyBalanceOnZ: Vec3 = [bodyUp[0], bodyUp[1], 0];
    const bodyFacingOnY: Vec3 = [bodyForward[0], 0, bodyForward[2]];

    vec3.cross(_crossX, desiredUp, bodyBalanceOnX);
    vec3.cross(_crossY, _balanceForward, bodyFacingOnY);
    vec3.cross(_crossZ, desiredUp, bodyBalanceOnZ);

    const angVel = c.body.motionProperties.angularVelocity;
    const angleX = Math.acos(Math.max(-1, Math.min(1, vec3.dot(bodyBalanceOnX, desiredUp))));
    const angleY = Math.acos(Math.max(-1, Math.min(1, vec3.dot(bodyFacingOnY, _balanceForward))));
    const angleZ = Math.acos(Math.max(-1, Math.min(1, vec3.dot(bodyBalanceOnZ, desiredUp))));

    const torque: Vec3 = [
        (_crossX[0] < 0 ? 1 : -1) * c.balanceSpringK * angleX - angVel[0] * c.balanceDampingC,
        (_crossY[1] < 0 ? 1 : -1) * c.balanceSpringOnY * angleY - angVel[1] * c.balanceDampingOnY,
        (_crossZ[2] < 0 ? 1 : -1) * c.balanceSpringK * angleZ - angVel[2] * c.balanceDampingC,
    ];
    rigidBody.addAngularImpulse(world, c.body, torque);
}

function updateMovingPlatform(world: World, c: Character, isMoving: boolean): void {
    if (!c.canJump || c.groundBodyId === null) {
        c.massRatio = 1;
        c.isOnMovingObject = false;
        vec3.set(c.movingObjectVelocity, 0, 0, 0);
        vec3.set(c.bodyContactForce, 0, 0, 0);
        return;
    }

    const groundBody = rigidBody.get(world, c.groundBodyId);
    if (!groundBody) {
        c.massRatio = 1;
        c.isOnMovingObject = false;
        vec3.set(c.movingObjectVelocity, 0, 0, 0);
        return;
    }

    const type = groundBody.motionType;
    if (type === MotionType.DYNAMIC || type === MotionType.KINEMATIC) {
        c.isOnMovingObject = true;
        c.massRatio = c.body.massProperties.mass / groundBody.massProperties.mass;

        const cp = c.body.position;
        const gp = groundBody.position;
        _charToObj[0] = cp[0] - gp[0];
        _charToObj[1] = cp[1] - gp[1];
        _charToObj[2] = cp[2] - gp[2];

        const groundLinvel = groundBody.motionProperties?.linearVelocity || vec3.create();
        const groundAngvel = groundBody.motionProperties?.angularVelocity || vec3.create();

        vec3.cross(_angvelToLinvel, groundAngvel, _charToObj);
        vec3.set(
            c.movingObjectVelocity,
            groundLinvel[0] + _angvelToLinvel[0],
            groundLinvel[1],
            groundLinvel[2] + _angvelToLinvel[2],
        );
        vec3.scale(c.movingObjectVelocity, c.movingObjectVelocity, Math.min(1, 1 / c.massRatio));

        const currentVel = c.body.motionProperties.linearVelocity;
        _velocityDiff[0] = c.movingObjectVelocity[0] - currentVel[0];
        _velocityDiff[1] = c.movingObjectVelocity[1] - currentVel[1];
        _velocityDiff[2] = c.movingObjectVelocity[2] - currentVel[2];
        if (vec3.length(_velocityDiff) > 30) {
            vec3.scale(c.movingObjectVelocity, c.movingObjectVelocity, 1 / vec3.length(_velocityDiff));
        }

        if (type === MotionType.DYNAMIC && !isMoving && vec3.squaredLength(c.moveDirection) < 0.001) {
            const drag: Vec3 = [
                -c.bodyContactForce[0] * Math.min(1, 1 / c.massRatio),
                -c.bodyContactForce[1] * Math.min(1, 1 / c.massRatio),
                -c.bodyContactForce[2] * Math.min(1, 1 / c.massRatio),
            ];
            rigidBody.addImpulseAtPosition(world, groundBody, drag, c.groundPosition);
            vec3.set(c.bodyContactForce, 0, 0, 0);
        }
    } else {
        c.massRatio = 1;
        c.isOnMovingObject = false;
        vec3.set(c.movingObjectVelocity, 0, 0, 0);
        vec3.set(c.bodyContactForce, 0, 0, 0);
    }
}

function updateGravityScale(c: Character): void {
    const verticalVel = c.body.motionProperties.linearVelocity[1];
    c.isFalling = verticalVel < 0 && !c.canJump;

    if (verticalVel < -c.maxFallSpeed) c.body.motionProperties.gravityFactor = 0;
    else if (c.isFalling) c.body.motionProperties.gravityFactor = c.fallingGravityScale;
    else c.body.motionProperties.gravityFactor = c.normalGravityScale;
}

function handleJump(world: World, c: Character): void {
    if (!c.wantToJump || !c.canJump) return;

    const currentVel = c.body.motionProperties.linearVelocity;
    const jumpVel = c.wantToRun ? c.sprintJumpMult * c.jumpVelocity : c.jumpVelocity;
    const jumpVelocityVec: Vec3 = [currentVel[0], jumpVel, currentVel[2]];

    // project part of the jump along the slope normal.
    _jumpDirection[0] = 0;
    _jumpDirection[1] = jumpVel * c.slopeJumpMult;
    _jumpDirection[2] = 0;
    const normalLength = vec3.length(c.actualSlopeNormal);
    if (normalLength > 0.0001) {
        const dot = vec3.dot(_jumpDirection, c.actualSlopeNormal);
        vec3.scale(_jumpProjection, c.actualSlopeNormal, dot / (normalLength * normalLength));
        vec3.copy(_jumpDirection, _jumpProjection);
    }
    vec3.add(jumpVelocityVec, jumpVelocityVec, _jumpDirection);
    rigidBody.setLinearVelocity(world, c.body, jumpVelocityVec);

    if (c.groundBodyId !== null) {
        const groundBody = rigidBody.get(world, c.groundBodyId);
        if (groundBody && (groundBody.motionType === MotionType.DYNAMIC || groundBody.motionType === MotionType.KINEMATIC)) {
            const jumpForceToGround: Vec3 = [
                c.characterMassForce[0],
                c.characterMassForce[1] * c.jumpForceToGroundMult,
                c.characterMassForce[2],
            ];
            rigidBody.addImpulseAtPosition(world, groundBody, jumpForceToGround, c.groundPosition);
        }
    }
}

function updateFacing(c: Character, moveDirection: Vec3, dt: number): void {
    if (vec3.length(moveDirection) > 0.001) {
        const targetY = Math.atan2(moveDirection[0], moveDirection[2]);
        let delta = targetY - c.facingYaw;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        // Exponential ease toward the target (frame-rate independent), instead of the
        // crashcat example's linear clamp — the clamp at a high turnSpeed snaps almost
        // instantly, whereas this glides. facingYaw also gets interpolated per render
        // frame in the loop, so the visible turn is smooth at any refresh rate.
        c.facingYaw += delta * (1 - Math.exp(-c.turnSpeed * dt));
        c.facingComplete = Math.abs(delta) < 0.01;
    } else {
        c.facingComplete = true;
    }
}

function applyDragForce(world: World, c: Character): void {
    if (!c.canJump) return;
    const currentVel = c.body.motionProperties.linearVelocity;
    if (!c.isOnMovingObject) {
        rigidBody.addImpulse(world, c.body, [-currentVel[0] * c.dragDampingC, 0, -currentVel[2] * c.dragDampingC]);
    } else {
        rigidBody.addImpulse(world, c.body, [
            (c.movingObjectVelocity[0] - currentVel[0]) * c.dragDampingC,
            0,
            (c.movingObjectVelocity[2] - currentVel[2]) * c.dragDampingC,
        ]);
    }
}

/** Advance the floating character controller one physics tick. */
export function updateCharacter(physics: Physics, c: Character, input: MovementInput, tuning: Tuning, dt: number): void {
    if (dt > 1) dt = dt % 1;

    // Sync the handful of live-tunable knobs from the debug panel.
    c.maxWalkSpeed = tuning.moveSpeed;
    c.maxRunSpeed = tuning.moveSpeed * tuning.sprintMultiplier;
    c.jumpVelocity = tuning.jumpVelocity;
    c.turnSpeed = tuning.turnSpeed;
    c.airControlFactor = tuning.airControlFactor;

    c.wantToRun = input.run;
    c.wantToJump = input.jump;

    // horizontal, normalized move direction (already camera-relative from controls.ts).
    vec3.copy(_moveDir, input.moveDir);
    _moveDir[1] = 0;
    if (vec3.length(_moveDir) > 0.001) vec3.normalize(_moveDir, _moveDir);
    vec3.copy(c.moveDirection, _moveDir);
    const isMoving = vec3.length(_moveDir) > 0.001;

    updateFacing(c, _moveDir, dt);

    const world = physics.world;
    updateGroundDetection(world, c);
    updateSlopeDetection(world, c);
    updateMovingPlatform(world, c, isMoving);

    if (isMoving) applyMovementForce(world, c);
    else applyDragForce(world, c);

    applyFloatingForce(world, c);
    applyAutoBalanceTorque(world, c);
    handleJump(world, c);
    updateGravityScale(c);
}

/** Reset the character to the spawn point (used by the debug panel's reset button). */
export function resetCharacter(physics: Physics, c: Character): void {
    const spawn: Vec3 = [CHARACTER_SPAWN[0], CHARACTER_SPAWN[1] + c.capsuleHalfHeight + c.capsuleRadius, CHARACTER_SPAWN[2]];
    rigidBody.setPosition(physics.world, c.body, spawn, true);
    rigidBody.setLinearVelocity(physics.world, c.body, [0, 0, 0]);
    c.body.motionProperties.angularVelocity = [0, 0, 0];
    c.body.quaternion = [0, 0, 0, 1];
}
