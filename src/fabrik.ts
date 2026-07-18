// FABRIK (Forward And Backward Reaching Inverse Kinematics).
// Ported from the-boiler-room (which ported it from the crawler sketch). Operates in
// place on plain mathcat Vec3 arrays.
import { type Vec3, vec3 } from 'mathcat';

export type Bone = {
    start: Vec3;
    end: Vec3;
    length: number;
    jointConstraint: JointConstraint;
};

const _difference: Vec3 = [0, 0, 0];

export const JointConstraintType = { NONE: 0, BALL: 1 } as const;
export type JointConstraintType = (typeof JointConstraintType)[keyof typeof JointConstraintType];

export type JointConstraint =
    | { type: typeof JointConstraintType.NONE }
    | { type: typeof JointConstraintType.BALL; rotor: number };

export const bone = (start: Vec3, end: Vec3, jointConstraint: JointConstraint = { type: JointConstraintType.NONE }): Bone => {
    vec3.sub(_difference, end, start);
    const length = vec3.length(_difference);
    return { start, end, length, jointConstraint };
};

export type Chain = {
    bones: Bone[];
};

const _outerBoneOuterToInnerUV: Vec3 = [0, 0, 0];
const _outerToInnerUV: Vec3 = [0, 0, 0];
const _innerToOuterUV: Vec3 = [0, 0, 0];
const _prevBoneInnerToOuterUV: Vec3 = [0, 0, 0];
const _offset: Vec3 = [0, 0, 0];

// currentDir/referenceDir are unit vectors, so their dot product is cos(angle). We only
// need to know if angle > rotor, which is dot < cos(rotor) — this avoids acos + sqrts on
// the always-run check. When exceeded, clamp currentDir to exactly `rotor` from
// referenceDir via Rodrigues (axis ⟂ referenceDir, so it reduces to ref·cos + (axis×ref)·sin).
function applyBallConstraint(currentDir: Vec3, referenceDir: Vec3, rotor: number) {
    const rx = referenceDir[0];
    const ry = referenceDir[1];
    const rz = referenceDir[2];
    const cx = currentDir[0];
    const cy = currentDir[1];
    const cz = currentDir[2];

    const cosAngle = rx * cx + ry * cy + rz * cz;
    const cosRotor = Math.cos(rotor);
    if (cosAngle >= cosRotor) return; // within limit

    // axis = normalize(referenceDir × currentDir) — perpendicular to referenceDir
    let ax = ry * cz - rz * cy;
    let ay = rz * cx - rx * cz;
    let az = rx * cy - ry * cx;
    const axisLen = Math.hypot(ax, ay, az);
    if (axisLen < 1e-8) return; // (near-)parallel: nothing well-defined to clamp
    const invLen = 1 / axisLen;
    ax *= invLen;
    ay *= invLen;
    az *= invLen;

    const sinRotor = Math.sin(rotor);
    // axis × referenceDir
    const px = ay * rz - az * ry;
    const py = az * rx - ax * rz;
    const pz = ax * ry - ay * rx;

    currentDir[0] = rx * cosRotor + px * sinRotor;
    currentDir[1] = ry * cosRotor + py * sinRotor;
    currentDir[2] = rz * cosRotor + pz * sinRotor;
}

export const fabrik = (chain: Chain, base: Vec3, target: Vec3) => {
    /* forward pass from end effector to base */
    for (let i = chain.bones.length - 1; i >= 0; i--) {
        const bone = chain.bones[i];

        if (i === chain.bones.length - 1) {
            // end effector: snap end to target
            vec3.copy(bone.end, target);

            const outerToInnerUV = _outerToInnerUV;
            vec3.sub(_outerToInnerUV, bone.start, bone.end);
            vec3.normalize(outerToInnerUV, outerToInnerUV);

            vec3.add(bone.start, bone.end, vec3.scale(_offset, outerToInnerUV, bone.length));

            if (i > 0) {
                const prevBone = chain.bones[i - 1];
                vec3.copy(prevBone.end, bone.start);
            }
        } else {
            const nextBone = chain.bones[i + 1];
            const outerBoneOuterToInnerUV = _outerBoneOuterToInnerUV;
            vec3.sub(outerBoneOuterToInnerUV, nextBone.start, nextBone.end);
            vec3.normalize(outerBoneOuterToInnerUV, outerBoneOuterToInnerUV);

            const outerToInnerUV = _outerToInnerUV;
            vec3.sub(outerToInnerUV, bone.start, bone.end);
            vec3.normalize(outerToInnerUV, outerToInnerUV);

            if (bone.jointConstraint.type === JointConstraintType.BALL) {
                applyBallConstraint(outerToInnerUV, outerBoneOuterToInnerUV, bone.jointConstraint.rotor);
            }

            vec3.add(bone.start, bone.end, vec3.scale(_offset, outerToInnerUV, bone.length));

            if (i > 0) {
                const prevBone = chain.bones[i - 1];
                vec3.copy(prevBone.end, bone.start);
            }
        }
    }

    /* backward pass from base to end effector */
    for (let i = 0; i < chain.bones.length; i++) {
        const bone = chain.bones[i];

        if (i === 0) {
            vec3.copy(bone.start, base);

            const innerToOuterUV = _innerToOuterUV;
            vec3.sub(innerToOuterUV, bone.end, bone.start);
            vec3.normalize(innerToOuterUV, innerToOuterUV);

            vec3.add(bone.end, bone.start, vec3.scale(_offset, innerToOuterUV, bone.length));

            if (i < chain.bones.length - 1) {
                const nextBone = chain.bones[i + 1];
                vec3.copy(nextBone.start, bone.end);
            }
        } else {
            const innerToOuterUV = _innerToOuterUV;
            vec3.sub(innerToOuterUV, bone.end, bone.start);
            vec3.normalize(innerToOuterUV, innerToOuterUV);

            const prevBone = chain.bones[i - 1];
            const prevBoneInnerToOuterUV = _prevBoneInnerToOuterUV;
            vec3.sub(prevBoneInnerToOuterUV, prevBone.end, prevBone.start);
            vec3.normalize(prevBoneInnerToOuterUV, prevBoneInnerToOuterUV);

            if (bone.jointConstraint.type === JointConstraintType.BALL) {
                applyBallConstraint(innerToOuterUV, prevBoneInnerToOuterUV, bone.jointConstraint.rotor);
            }

            vec3.add(bone.end, bone.start, vec3.scale(_offset, innerToOuterUV, bone.length));

            if (i < chain.bones.length - 1) {
                const nextBone = chain.bones[i + 1];
                vec3.copy(nextBone.start, bone.end);
            }
        }
    }
};

export const fabrikFixedIterations = (chain: Chain, base: Vec3, target: Vec3, iterations: number) => {
    for (let i = 0; i < iterations; i++) {
        fabrik(chain, base, target);
    }
};
