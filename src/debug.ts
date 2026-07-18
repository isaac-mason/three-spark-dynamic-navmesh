import { debugRenderer } from 'crashcat/three';
import GUI from 'lil-gui';
import type * as THREE from 'three';
import { type Character, resetCharacter } from './character';
import { type CharacterVisuals, relayoutCharacterVisuals } from './character-visuals';
import type { Physics } from './physics';
import type { Tuning } from './scene';

// lil-gui tuning panel + the crashcat wireframe debug renderer. The panel edits the live
// Tuning object the update()s read each frame, so changes take effect immediately; the
// debug renderer draws physics bodies as wireframes when toggled on.

export type Debug = {
    gui: GUI;
    renderer: ReturnType<typeof debugRenderer.init>;
    /** Live player feet position, shown in the panel (updated each frame). */
    playerPos: { x: number; y: number; z: number };
};

export function initDebug(
    scene: THREE.Scene,
    physics: Physics,
    tuning: Tuning,
    character: Character,
    visuals: CharacterVisuals,
): Debug {
    const options = debugRenderer.createDefaultOptions();
    const renderer = debugRenderer.init(options);
    renderer.object3d.visible = false;
    scene.add(renderer.object3d);

    const gui = new GUI({ title: '3rd-Person Character Controller' });

    const move = gui.addFolder('Movement');
    move.add(tuning, 'moveSpeed', 1, 20, 0.5).name('Move speed');
    move.add(tuning, 'sprintMultiplier', 1, 3, 0.05).name('Sprint multiplier');
    move.add(tuning, 'jumpVelocity', 2, 15, 0.5).name('Jump velocity');
    move.add(tuning, 'airControlFactor', 0, 1, 0.05).name('Air control');
    move.add(tuning, 'turnSpeed', 5, 60, 1).name('Turn speed');
    move.close();

    const char = gui.addFolder('Character');
    char.add(tuning, 'characterHeight', 0.5, 8, 0.05)
        .name('Height')
        .onChange(() => relayoutCharacterVisuals(visuals, tuning));
    char.add(tuning, 'characterYawDeg', -180, 180, 1)
        .name('Mesh yaw')
        .onChange(() => relayoutCharacterVisuals(visuals, tuning));
    char.add(tuning, 'walkSpeedThreshold', 0.05, 2, 0.05).name('Walk threshold');
    char.add(tuning, 'walkAnimTimeScale', 0.25, 2.5, 0.05).name('Walk anim speed');
    char.add(tuning, 'animCrossfade', 0.05, 0.8, 0.01).name('Anim crossfade');
    char.close();

    const light = gui.addFolder('Lighting');
    light.add(tuning, 'ambientIntensity', 0, 2, 0.01).name('Ambient');
    light.add(tuning, 'sunIntensity', 0, 3, 0.02).name('Sun intensity');
    light.addColor(tuning, 'sunColor').name('Sun color');
    light.add(tuning, 'sunFollowCharacter').name('Sun follows');
    light.close();

    const shadow = gui.addFolder('Shadows');
    shadow.add(tuning, 'shadowIntensity', 0, 1, 0.01).name('Intensity');
    shadow.add(tuning, 'shadowRadius', 0, 10, 0.1).name('Radius');
    shadow.add(tuning, 'shadowMapSize', 256, 4096, 128).name('Map size');
    shadow.add(tuning, 'shadowCameraHalfExtent', 5, 100, 1).name('Frustum size');
    shadow.add(tuning, 'colliderShadowOpacity', 0, 1, 0.01).name('Floor shadow opacity');
    shadow.close();

    const pp = gui.addFolder('Post-processing');
    pp.add(tuning, 'ppEnabled').name('Enabled');
    pp.add(tuning, 'ppBloomIntensity', 0, 2, 0.01).name('Bloom intensity');
    pp.add(tuning, 'ppBloomThreshold', 0, 1, 0.01).name('Bloom threshold');
    pp.add(tuning, 'ppBrightness', -1, 1, 0.02).name('Brightness');
    pp.add(tuning, 'ppContrast', -1, 1, 0.02).name('Contrast');
    pp.add(tuning, 'ppVignetteDarkness', 0, 1, 0.01).name('Vignette darkness');
    pp.close();

    const dbg = gui.addFolder('Physics debug');
    dbg.add(tuning, 'showPhysicsDebug').name('Wireframes');
    dbg.add(tuning, 'showNavMesh').name('Navmesh');
    dbg.close();

    gui.add({ reset: () => resetCharacter(physics, character) }, 'reset').name('Reset position');

    // Live read-outs. .listen() auto-refreshes the displayed value each frame; .disable()
    // makes them read-only.
    const playerPos = { x: 0, y: 0, z: 0 };
    const info = gui.addFolder('Info');
    info.add(playerPos, 'x').name('player x').listen().disable();
    info.add(playerPos, 'y').name('player y').listen().disable();
    info.add(playerPos, 'z').name('player z').listen().disable();

    return { gui, renderer, playerPos };
}

export function updateDebug(debug: Debug, physics: Physics, tuning: Tuning, playerFeet: THREE.Vector3): void {
    debug.playerPos.x = Math.round(playerFeet.x * 100) / 100;
    debug.playerPos.y = Math.round(playerFeet.y * 100) / 100;
    debug.playerPos.z = Math.round(playerFeet.z * 100) / 100;

    debug.renderer.object3d.visible = tuning.showPhysicsDebug;
    if (tuning.showPhysicsDebug) debugRenderer.update(debug.renderer, physics.world);
}
