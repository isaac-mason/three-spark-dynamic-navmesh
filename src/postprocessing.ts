import { BloomEffect, BrightnessContrastEffect, EffectComposer, EffectPass, RenderPass, VignetteEffect } from 'postprocessing';
import type * as THREE from 'three';
import type { Tuning } from './scene';

// pmndrs/postprocessing pass: bloom + brightness/contrast + vignette, composited over the
// scene render. `render()` replaces renderer.render() in the loop; when disabled in the
// panel the effects are zeroed rather than bypassed, so the render path stays constant.

export type PostProcessing = {
    composer: EffectComposer;
    bloom: BloomEffect;
    brightnessContrast: BrightnessContrastEffect;
    vignette: VignetteEffect;
};

export function initPostProcessing(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    tuning: Tuning,
): PostProcessing {
    const brightnessContrast = new BrightnessContrastEffect({ brightness: tuning.ppBrightness, contrast: tuning.ppContrast });
    const bloom = new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: tuning.ppBloomThreshold,
        luminanceSmoothing: tuning.ppBloomSmoothing,
        intensity: tuning.ppBloomIntensity,
        radius: 0.55,
    });
    const vignette = new VignetteEffect({ darkness: tuning.ppVignetteDarkness, offset: tuning.ppVignetteOffset });

    const composer = new EffectComposer(renderer, { depthBuffer: true, stencilBuffer: false });
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new EffectPass(camera, brightnessContrast, bloom, vignette));
    composer.setSize(window.innerWidth, window.innerHeight);

    return { composer, bloom, brightnessContrast, vignette };
}

export function updatePostProcessing(pp: PostProcessing, tuning: Tuning): void {
    if (!tuning.ppEnabled) {
        pp.bloom.intensity = 0;
        pp.brightnessContrast.brightness = 0;
        pp.brightnessContrast.contrast = 0;
        pp.vignette.darkness = 0;
        return;
    }
    pp.bloom.intensity = tuning.ppBloomIntensity;
    pp.bloom.luminanceMaterial.threshold = tuning.ppBloomThreshold;
    pp.bloom.luminanceMaterial.smoothing = tuning.ppBloomSmoothing;
    pp.brightnessContrast.brightness = tuning.ppBrightness;
    pp.brightnessContrast.contrast = tuning.ppContrast;
    pp.vignette.darkness = tuning.ppVignetteDarkness;
    pp.vignette.offset = tuning.ppVignetteOffset;
}

export function resizePostProcessing(pp: PostProcessing, width: number, height: number): void {
    pp.composer.setSize(width, height);
}

export function renderPostProcessing(pp: PostProcessing, dt: number): void {
    pp.composer.render(dt);
}
