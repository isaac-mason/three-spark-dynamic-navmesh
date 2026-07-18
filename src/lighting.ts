import * as THREE from 'three';
import type { Tuning } from './scene';

// Scene fill (ambient) + a shadow-casting sun. Splats are self-lit and ignore both; the
// lights exist for the character mesh and the reflector balls, and the sun drives the
// shadow that lands on the collider shadow-catcher. The sun (and its shadow frustum) can
// track the character so the shadow map stays high-res wherever the player is.

export type Lighting = {
    ambient: THREE.AmbientLight;
    sun: THREE.DirectionalLight;
};

export function initLighting(scene: THREE.Scene): Lighting {
    const ambient = new THREE.AmbientLight(0xffffff, 0.38);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffe8c9, 1.62);
    sun.castShadow = true;
    scene.add(sun);
    scene.add(sun.target);

    return { ambient, sun };
}

const _feetTmp = new THREE.Vector3();

export function updateLighting(lighting: Lighting, tuning: Tuning, feet: THREE.Vector3): void {
    const { ambient, sun } = lighting;

    ambient.intensity = tuning.ambientIntensity;
    sun.color.setHex(tuning.sunColor);
    sun.intensity = tuning.sunIntensity;

    // Position the sun (and aim its target) either following the character or fixed.
    if (tuning.sunFollowCharacter) {
        _feetTmp.copy(feet);
        sun.target.position.copy(_feetTmp);
        sun.position.set(_feetTmp.x + tuning.sunOffset[0], _feetTmp.y + tuning.sunOffset[1], _feetTmp.z + tuning.sunOffset[2]);
    } else {
        sun.target.position.set(0, 0, 0);
        sun.position.set(tuning.sunOffset[0], tuning.sunOffset[1], tuning.sunOffset[2]);
    }

    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.near = tuning.shadowCameraNear;
    cam.far = tuning.shadowCameraFar;
    const half = tuning.shadowCameraHalfExtent;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();

    sun.shadow.radius = tuning.shadowRadius;
    sun.shadow.intensity = tuning.shadowIntensity;

    const ms = Math.min(4096, Math.max(256, Math.round(tuning.shadowMapSize / 128) * 128));
    if (sun.shadow.mapSize.width !== ms) {
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
        sun.shadow.mapSize.set(ms, ms);
    }
}
