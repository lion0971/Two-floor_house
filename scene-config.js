// scene-config.js
const isGitHub = window.location.hostname.includes('github.io');
const basePath = isGitHub ? '/Two-floor_house/' : './';

export const CONFIG = {
    MODELS: {
        BUILDING: `${basePath}models/20260805.glb`,
        HDRI: `${basePath}hdri/studio-0623.hdr`
    },
   CAMERA: {
        fov: 60,
        startPos: { x: 1.5, y: 1.5, z: -20.2 },
        lookAtPos: { x: 5.46, y: 2.48, z: -11.12 } // 明確定義看向中心
    }
};