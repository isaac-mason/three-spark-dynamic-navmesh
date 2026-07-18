import {
    CastRayStatus,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    type Filter,
    filter,
    MotionType,
} from 'crashcat';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CHARACTER_FEET_OFFSET, type Character } from './character';
import type { Physics } from './physics';
import type { Tuning } from './scene';

// Third-person camera + keyboard input. The camera is a damped OrbitControls rig that
// the player drags to look around; each frame it's translated by however far the
// character's feet moved (so it trails the character without fighting the user's orbit)
// and its target is pinned to the character's upper body. A raycast from the target out
// to the camera pulls it in when world geometry would otherwise clip through it.

// Camera-collision feel.
const CAM_MIN_DIST = 1.5; // never pull closer than this to the target
const CAM_PADDING = 0.4; // stop the camera this far in front of the hit surface
const CAM_IN_RATE = 20; // ease rate (1/s) when pulling in — fast, to avoid clipping
const CAM_OUT_RATE = 4; // ease rate (1/s) when letting back out — slow, to avoid popping

// Vertical orbit clamp (polar angle from world-up). ~45° stops a full top-down view; ~94°
// keeps the camera from dropping below the character (and under the floor).
const MIN_POLAR_ANGLE = Math.PI * 0.25;
const MAX_POLAR_ANGLE = Math.PI * 0.52;

export type Controls = {
    orbit: OrbitControls;
    camera: THREE.PerspectiveCamera;
    input: {
        forward: boolean;
        backward: boolean;
        left: boolean;
        right: boolean;
        jump: boolean;
        sprint: boolean;
        /** One-shot trick request (set on the `1` keydown; the loop consumes it). */
        trick: boolean;
    };
    /** Character feet position last frame — used to translate the camera by the delta. */
    prevFeet: THREE.Vector3;
    /** OrbitControls' uncollided camera position — restored each frame so clamping the
     *  collided position doesn't corrupt the orbit radius. */
    desiredPos: THREE.Vector3;
    /** Current (eased) camera distance from the target after collision clamping. */
    dist: number;
    /** Ray filter for camera collision — only static world geometry blocks the camera. */
    cameraFilter: Filter;
};

export function initControls(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    character: Character,
    physics: Physics,
): Controls {
    const orbit = new OrbitControls(camera, domElement);
    orbit.enableDamping = true;
    // The camera follows the character (we overwrite orbit.target every frame), so panning
    // just drags the target off the character and snaps back — disable it entirely.
    orbit.enablePan = false;

    // Clamp the vertical orbit (polar angle: 0 = straight above, π/2 = level) so you can't
    // swing to a full top-down or drop the camera under the floor.
    orbit.minPolarAngle = MIN_POLAR_ANGLE;
    orbit.maxPolarAngle = MAX_POLAR_ANGLE;

    // OrbitControls treats Shift/Ctrl/Meta + left-drag as pan; Shift is our sprint key, so
    // dragging while sprinting would hit that (now disabled) pan path and do nothing. Force
    // the modifier flags OrbitControls reads to false so left-drag ALWAYS orbits, letting you
    // look around while sprinting. Patches the instance's bound mouse-down handler. Read
    // through to the REAL event (this = target) — native MouseEvent getters throw if invoked
    // with the proxy as the receiver.
    const orbitInternal = orbit as unknown as { _onMouseDown: (event: MouseEvent) => void };
    const originalMouseDown = orbitInternal._onMouseDown;
    orbitInternal._onMouseDown = (event: MouseEvent) => {
        const withoutModifiers = new Proxy(event, {
            get(target, prop) {
                if (prop === 'shiftKey' || prop === 'ctrlKey' || prop === 'metaKey') return false;
                const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
                return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
        });
        originalMouseDown(withoutModifiers);
    };

    const feet = characterFeet(character, new THREE.Vector3());
    orbit.target.copy(feet);
    camera.position.set(feet.x, feet.y + 7, feet.z + 9);
    orbit.update();

    // Only static bodies (the world trimesh) occlude the camera — not the character
    // capsule or the dynamic reflector balls.
    const cameraFilter = filter.create(physics.world.settings.layers);
    cameraFilter.bodyFilter = (body) => body.motionType === MotionType.STATIC;

    const controls: Controls = {
        orbit,
        camera,
        input: { forward: false, backward: false, left: false, right: false, jump: false, sprint: false, trick: false },
        prevFeet: feet.clone(),
        desiredPos: camera.position.clone(),
        dist: camera.position.distanceTo(orbit.target),
        cameraFilter,
    };

    const setKey = (code: string, down: boolean, repeat: boolean): boolean => {
        switch (code) {
            case 'KeyW':
            case 'ArrowUp':
                controls.input.forward = down;
                return true;
            case 'KeyS':
            case 'ArrowDown':
                controls.input.backward = down;
                return true;
            case 'KeyA':
            case 'ArrowLeft':
                controls.input.left = down;
                return true;
            case 'KeyD':
            case 'ArrowRight':
                controls.input.right = down;
                return true;
            case 'Space':
                controls.input.jump = down;
                return true;
            case 'ShiftLeft':
            case 'ShiftRight':
                controls.input.sprint = down;
                return true;
            case 'Digit1':
                if (down && !repeat) controls.input.trick = true;
                return true;
            default:
                return false;
        }
    };

    window.addEventListener('keydown', (e) => {
        if (setKey(e.code, true, e.repeat)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
        setKey(e.code, false, false);
    });

    return controls;
}

/** World-space feet position of the character (body centre minus the capsule half-extent). */
export function characterFeet(character: Character, out: THREE.Vector3): THREE.Vector3 {
    const p = character.body.position;
    return out.set(p[0], p[1] - CHARACTER_FEET_OFFSET, p[2]);
}

const _camQuat = new THREE.Quaternion();

// Build the world-space horizontal move direction from the held keys, relative to where
// the camera is pointing (W = away from camera). Written into `out`.
export function getMoveDirection(controls: Controls, out: THREE.Vector3): THREE.Vector3 {
    const forward = controls.input.forward ? 1 : controls.input.backward ? -1 : 0;
    const right = controls.input.right ? 1 : controls.input.left ? -1 : 0;
    controls.camera.getWorldQuaternion(_camQuat);
    out.set(right, 0, -forward).applyQuaternion(_camQuat);
    out.y = 0;
    if (out.lengthSq() > 1e-8) out.normalize();
    return out;
}

const _delta = new THREE.Vector3();
const _off = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin: Vec3 = [0, 0, 0];
const _rayDir: Vec3 = [0, 0, 0];
const camRayCollector = createClosestCastRayCollector();
const camRaySettings = createDefaultCastRaySettings();
camRaySettings.collideWithBackfaces = true; // stop at any surface, regardless of winding

// Distance from `target` along `dir` to the first static surface within `maxDist`, or −1
// if the view is clear.
function castCameraDistance(
    controls: Controls,
    physics: Physics,
    target: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
): number {
    _origin[0] = target.x;
    _origin[1] = target.y;
    _origin[2] = target.z;
    _rayDir[0] = dir.x;
    _rayDir[1] = dir.y;
    _rayDir[2] = dir.z;
    camRayCollector.reset();
    castRay(physics.world, camRayCollector, camRaySettings, _origin, _rayDir, maxDist, controls.cameraFilter);
    return camRayCollector.hit.status === CastRayStatus.COLLIDING ? camRayCollector.hit.fraction * maxDist : -1;
}

// Trail the camera behind the character: shift it by the feet delta this frame, pin the
// orbit target to the upper body, let OrbitControls apply the user's orbit + damping, then
// pull the camera in (eased) if world geometry occludes it. `feet` is the interpolated
// feet position (see the fixed-step loop in index.ts); `dt` is the real frame time.
export function updateCameraFollow(controls: Controls, physics: Physics, feet: THREE.Vector3, tuning: Tuning, dt: number): void {
    // Restore the uncollided position so OrbitControls derives the true orbit radius (last
    // frame we may have pulled the camera in for rendering).
    controls.camera.position.copy(controls.desiredPos);

    _delta.subVectors(feet, controls.prevFeet);
    controls.camera.position.add(_delta);
    controls.orbit.target.set(feet.x, feet.y + tuning.cameraTargetYOffset, feet.z);
    controls.prevFeet.copy(feet);
    controls.orbit.update();

    // Remember the uncollided position before we clamp it for this frame's render.
    controls.desiredPos.copy(controls.camera.position);

    _off.subVectors(controls.camera.position, controls.orbit.target);
    const desiredDist = _off.length();
    if (desiredDist < 1e-4) return;
    _dir.copy(_off).multiplyScalar(1 / desiredDist);

    const hit = castCameraDistance(controls, physics, controls.orbit.target, _dir, desiredDist);
    const wanted = hit >= 0 ? Math.max(CAM_MIN_DIST, hit - CAM_PADDING) : desiredDist;

    // Ease toward the wanted distance — fast when pulling in (avoid clipping), slow when
    // letting back out (avoid a pop as you round a corner).
    const rate = wanted < controls.dist ? CAM_IN_RATE : CAM_OUT_RATE;
    controls.dist += (wanted - controls.dist) * (1 - Math.exp(-rate * dt));
    controls.camera.position.copy(controls.orbit.target).addScaledVector(_dir, controls.dist);
}
