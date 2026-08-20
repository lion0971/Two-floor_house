// scene-config.js
const isGitHub = window.location.hostname.includes('github.io');
const basePath = isGitHub ? '/3D_Module_Web/' : './';

export const CONFIG = {
    MODELS: {
        PLANT: `${basePath}models/Plant_Turtle_LOD.glb`,
        BUILDING: `${basePath}models/20260805.glb`,
        HDRI: `${basePath}hdri/studio-0623.hdr`
    },
    ROOM_DATA: {
        "in_door1": "會議室 101",
        "in_door2": "會議室 102",
        "in_door3": "茶水間"
    },
   CAMERA: {
        fov: 60,
        startPos: { x: 1.5, y: 1.5, z: -20.2 },
        lookAtPos: { x: 5.46, y: 2.48, z: -11.12 } // 明確定義看向中心
    }
};