import * as THREE from 'three';
window.THREE = THREE; // ← 新增這行，方便 console 除錯
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
//import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CONFIG } from './scene-config.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import { getDatabase, ref, onValue, set, remove } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

const fbApp = initializeApp(firebaseConfig);

const db = getDatabase(fbApp);

// ★ 新增：匿名登入
const auth = getAuth(fbApp);

const authReadyPromise = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      console.log('[Firebase Auth] 匿名登入成功，UID:', user.uid);
      resolve();
    }
  });
  signInAnonymously(auth).catch((err) => {
    console.error('[Firebase Auth] 匿名登入失敗', err);
  });
});

const LINE_NOTIFY_ENABLED = true; // ★ 設 false 暫時關閉LINE連結通知，設 true 恢復

// ─────────────────────────────────────────
// 一、全域變數
// ─────────────────────────────────────────
// ── 每次開啟網頁，產生獨立的 session ID，避免多人使用互相干擾 ──
const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);

let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let prevTime = performance.now();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const interactiveDevices = [];
const doorObjects = [];
const doorAnimations = {};
// ── 滑門自動判斷軸向/方向如果不準，可在這裡手動指定特定門的名稱 ──
// 例如：'sliding_door_2': 'z' 代表這扇門強制沿 Z 軸滑動
const SLIDE_AXIS_OVERRIDE = {
  // 'sliding_door_名稱': 'x' 或 'z',
};
const SLIDE_SIGN_OVERRIDE = {
  'kit_sliding_door': 1,  // 預設 -1（往負方向開），需要往正方向開就填 1
};

const cachedSceneMeshes = [];
const flowingPipes = new Map();
const outletObjects = {};   // faucet_outlet / faucet_2_outlet / shower_outlet / shower_2_outlet ...
const waterFlows = {};      // WaterFlow 實例，key 為完整裝置名稱
let isXRayMode = false;
let unlockFromButton = false;

//碰撞宣告head
let collidableObjects = [];
let isNoclipMode = false;
let isStuckInWall = false;
let isMenuAction = false;

const rayDirections = [
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(1, 0, 0)
];
const collisionDistance = 0.5;
//碰撞宣告end

/** 依目前模式回傳管路「非啟動」狀態的透明度 */
function getInactivePipeOpacity() {
  return isXRayMode ? 0.45 : 0.12;
};

function setPipeState(p, state) {
  if (!p || !p.mesh) return;
  const pool = PIPE_MATERIALS[p.colorType];
  if (!pool) return;
  if (state === 'active') {
    p.active = true;
    p.mesh.material = p.isShared ? pool.active_shared : pool.active_own;
  } else {
    p.active = false;
    p.mesh.material = pool.inactive;
  }
}

// ✅ 動態建立，traverse 時自動新增 key（支援多個裝置）
const activeTimers = {};

const drainFlows = {};   // DrainFlow 實例，key 為 drain 物件名稱

// 需要套用烘焙 AO 貼圖的物件（名稱已 lowercase，跟 traverse 裡的 name 對應）
const AO_BAKE_TARGETS = new Set([
  'wall_outside',
  'ceiling',
  'wall_inside_1',
  'wall_inside_2',
  'floor',
]);

// ── 旋轉樓梯設定 ──
const STAIRCASE = {
  center: new THREE.Vector3(10.65, 1.6, -5.78),
  radius: 1.0,          // 樓梯外緣半徑，用來判斷玩家是否靠近樓梯
  walkRadius: 0.6,       // ← 新增：玩家實際走的圓形路徑半徑，建議落在踏板中段，可自行微調
  totalHeight: 3.0,
  stepHeight: 0.2,
  turns: 1,
  radiusMargin: 0.4,
  climbSpeed: 1.0,        // ← 新增：沿樓梯自動移動的速度（公尺/秒），數字越大爬得越快
};

let isOnStairRail = false;  // 是否正處於「樓梯軌道自走模式」
let stairHeight = 0;        // 目前在樓梯上的高度（0 ~ totalHeight）
let stairAngleOffset = 0;   // 進入樓梯當下的角度基準，讓軌道跟實際入口方位對齊

// ── 水池高低差設定 ──
const poolWaterMeshes = [];   // 收集 floor_pool_water 的 mesh
let poolBounds = null;        // 世界座标包围盒（THREE.Box3）

let waterDepthCurrent = 0;    // 目前下沉量（公尺）
let waterDepthTarget = 0;     // 目標下沉量（0 或 0.9）
const WATER_SINK_LERP_SPEED = 6.0;   // 越小 → 沉浮越絲滑緩慢
const WATER_BOB_AMPLITUDE = 0.03;    // 水中上下漂浮幅度（公尺）
const WATER_BOB_SPEED = 0.5;         // 漂浮頻率
let waterBobStrength = 0;            // 漂浮強度淡入淡出用
let appliedWaterOffset = 0;          // 記錄上一幀實際套用在camera.y的偏移，方便下一幀先扣除再重算

// ── 新增：管路配置表（依附件二） ──
const PIPE_CONFIG = {
  // 廚房出水
  'kit_faucet_1': {
    outletKey: 'kit_faucet_1_outlet',
    drainKey: 'kit_faucet_1_drain',
    coldPipes: ['pipe_main', 'pipe_kit', 'pipe_kit_1', 'pipe_kit_faucet_1'],
    drainPipes: ['pipe_main_w', 'pipe_kit_w', 'pipe_kit_faucet_1_w'],
    type: 'faucet',
  },
  'kit_faucet_2': {
    outletKey: 'kit_faucet_2_outlet',
    drainKey: 'kit_faucet_2_drain',
    coldPipes: ['pipe_main', 'pipe_kit', 'pipe_kit_1', 'pipe_kit_faucet_2'],
    drainPipes: ['pipe_main_w', 'pipe_kit_w', 'pipe_kit_faucet_2_w'],
    type: 'faucet',
  },
  // 浴室出水一樓
  'restroom_shower': {
    outletKey: 'restroom_shower_outlet',
    drainKey: 'restroom_shower_drain',
    coldPipes: ['pipe_main', 'pipe_restroom', 'pipe_restroom_1', 'pipe_restroom_st', 'pipe_restroom_shower'],
    drainPipes: ['pipe_main_w', 'pipe_restroom_w', 'pipe_restroom_shower_w'],
    type: 'shower',
  },
  'restroom_toilet': {
    outletKey: 'restroom_toilet_outlet',
    drainKey: 'restroom_toilet_drain',
    drainRadius: 0.10,
    coldPipes: ['pipe_main', 'pipe_restroom', 'pipe_restroom_1', 'pipe_restroom_st', 'pipe_restroom_toilet'],
    drainPipes: ['pipe_restroom_toilet_w'],
    type: 'faucet',
  },
  'restroom_faucet': {
    outletKey: 'restroom_faucet_outlet',
    drainKey: 'restroom_faucet_drain',
    coldPipes: ['pipe_main', 'pipe_restroom', 'pipe_restroom_1', 'pipe_restroom_faucet'],
    drainPipes: ['pipe_main_w', 'pipe_restroom_w', 'pipe_restroom_faucet_w'],
    type: 'faucet',
  },

  // 浴室出水二樓
  'restroom_shower_2': {
    outletKey: 'restroom_shower_outlet_2',
    drainKey: 'restroom_shower_drain_2',
    coldPipes: ['pipe_main', 'pipe_restroom', 'pipe_restroom_2', 'pipe_restroom_st_2', 'pipe_restroom_shower_2'],
    drainPipes: ['pipe_restroom_w_2', 'pipe_restroom_shower_w_2'],
    type: 'shower',
  },
  'restroom_toilet_2': {
    outletKey: 'restroom_toilet_outlet_2',
    drainKey: 'restroom_toilet_drain_2',
    drainRadius: 0.10,
    coldPipes: ['pipe_main', 'pipe_restroom', 'pipe_restroom_2', 'pipe_restroom_st_2', 'pipe_restroom_toilet_2'],
    drainPipes: ['pipe_restroom_toilet_w_2'],
    type: 'faucet',
  },
  'restroom_faucet_2': {
    outletKey: 'restroom_faucet_outlet_2',
    drainKey: 'restroom_faucet_drain_2',
    coldPipes: ['pipe_main', 'pipe_restroom', 'pipe_restroom_2', 'pipe_restroom_faucet_2'],
    drainPipes: ['pipe_restroom_w_2', 'pipe_restroom_faucet_w_2'],
    type: 'faucet',
  },
};

// 共用幹管（會被多個裝置同時使用）
const SHARED_COLD_PIPES = new Set([
  'pipe_main',
  'pipe_kit',
  'pipe_restroom',
  'pipe_restroom_1',   // 一樓三個裝置共用
  'pipe_restroom_st',  // 一樓蓮蓬頭+馬桶共用
  'pipe_restroom_2',   // 二樓三個裝置共用
  'pipe_restroom_st_2',// 二樓蓮蓬頭+馬桶共用
]);
const SHARED_DRAIN_PIPES = new Set(['pipe_main_w', 'pipe_kit_w', 'pipe_restroom_w']);

function makePipeMat(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.FrontSide,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}
const PIPE_MATERIALS = {
  cold: {
    active_shared: makePipeMat(0x00aaff, 0.6),
    active_own: makePipeMat(0x00aaff, 0.75),
    inactive: makePipeMat(0x00aaff, 0.12),
  },
  drain: {
    active_shared: makePipeMat(0xff6600, 0.6),
    active_own: makePipeMat(0xff6600, 0.75),
    inactive: makePipeMat(0xff6600, 0.12),
  },
};

// 替換舊的 DEVICE_LABEL
const DEVICE_LABEL = {
  'kit_faucet_1': '廚房水龍頭1',
  'kit_faucet_2': '廚房水龍頭2',
  'restroom_shower': '一樓浴室蓮蓬頭',
  'restroom_toilet': '一樓浴室馬桶',
  'restroom_faucet': '一樓浴室洗手台',
  'restroom_shower_2': '二樓浴室蓮蓬頭',
  'restroom_toilet_2': '二樓浴室馬桶',
  'restroom_faucet_2': '二樓室洗手台',
};

// ─────────────────────────────────────────
// 二、水流粒子系統
// ─────────────────────────────────────────
class WaterFlow {
  constructor(scene, emitPosition, type = 'faucet') {
    this.scene = scene;
    this.emitPosition = emitPosition.clone();
    this.type = type;
    this.active = false;
    this.count = type === 'shower' ? 400 : 200;
    this.velocities = [];
    this.lifetimes = [];
    this._build();
  }

  _build() {
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.count * 3);
    const colors = new Float32Array(this.count * 3);

    for (let i = 0; i < this.count; i++) {
      this.positions[i * 3] = this.emitPosition.x;
      this.positions[i * 3 + 1] = this.emitPosition.y;
      this.positions[i * 3 + 2] = this.emitPosition.z;

      const b = 0.7 + Math.random() * 0.3;
      colors[i * 3] = 0.3 * b;
      colors[i * 3 + 1] = 0.75 * b;
      colors[i * 3 + 2] = 1.0 * b;

      this.lifetimes[i] = Math.random();
      this._resetVelocity(i);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: this.type === 'shower' ? 0.025 : 0.035,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.visible = false;
    this.scene.add(this.points);
  }

  _resetVelocity(i) {
    if (this.type === 'faucet') {
      this.velocities[i] = new THREE.Vector3(
        (Math.random() - 0.5) * 0.015,
        -(0.025 + Math.random() * 0.015),  // 原本 0.04~0.065，改為 0.025~0.04
        (Math.random() - 0.5) * 0.015
      );
    } else {
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.010 + Math.random() * 0.03;
      this.velocities[i] = new THREE.Vector3(
        Math.cos(angle) * radius,
        -(0.02 + Math.random() * 0.02),
        Math.sin(angle) * radius
      );
    }
  }

  _resetParticle(i) {
    const jitter = this.type === 'shower' ? 0.015 : 0.01;
    this.positions[i * 3] = this.emitPosition.x + (Math.random() - 0.5) * jitter;
    this.positions[i * 3 + 1] = this.emitPosition.y;
    this.positions[i * 3 + 2] = this.emitPosition.z + (Math.random() - 0.5) * jitter;
    this.lifetimes[i] = 0;
    this._resetVelocity(i);
  }

  setActive(isActive) {
    this.active = isActive;
    this.points.visible = isActive;
  }

  update(delta) {
    if (!this.active) return;
    const gravity = -0.003;
    const maxLife = this.type === 'faucet' ? 0.2 : 0.9;

    for (let i = 0; i < this.count; i++) {
      this.lifetimes[i] += delta;
      if (this.lifetimes[i] > maxLife) { this._resetParticle(i); continue; }
      this.velocities[i].y += gravity * delta * 60;
      this.positions[i * 3] += this.velocities[i].x;
      this.positions[i * 3 + 1] += this.velocities[i].y;
      this.positions[i * 3 + 2] += this.velocities[i].z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.material.opacity = 0.75 + Math.sin(performance.now() * 0.003) * 0.1;
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

// ─────────────────────────────────────────
// DrainFlow：排水口漩渦粒子系統
// ─────────────────────────────────────────
class DrainFlow {
  constructor(scene, drainPosition, radius = 0.6) {
    this.scene = scene;
    this.drainPosition = drainPosition.clone();
    this.radius = radius;
    this.active = false;
    this.count = 500;
    this.particles = [];
    this.fadeOpacity = 0;
    this.fadeDuration = 2.0;
    this.fadeElapsed = 0;
    this._build();
  }

  _build() {
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);

    for (let i = 0; i < this.count; i++) {
      this._initParticle(i, true);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const mat = new THREE.PointsMaterial({
      size: this.radius * 0.038,  // ✅ 跟 radius 連動
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.visible = false;
    this.scene.add(this.points);
  }

  _initParticle(i, randomStart = false) {
    // ✅ 關鍵：pow 指數 > 1 → 大量粒子集中在內圈，外圍自然稀疏
    // pow(rand, 2.5)：外圍極稀，中心極密（類颱風眼牆效果）
    const u = Math.random();
    const r = this.radius * Math.pow(u, 2.5);

    // ✅ 初始角度加上螺旋偏移，讓靜止時就有螺旋臂視覺
    //    r 越大偏移越多 → 產生自然的阿基米德螺線分布
    const spiralOffset = (r / this.radius) * Math.PI * 4;
    const angle = randomStart
      ? Math.random() * Math.PI * 2 - spiralOffset
      : Math.random() * Math.PI * 2 - spiralOffset;

    this.particles[i] = {
      r,
      angle,
      baseSpeed: 0.6 + Math.random() * 0.8,   // 低基礎速度，靠 angularMult 放大
      driftSpeed: 0.0002 + Math.random() * 0.0003, // 極微向心漂移（保持圓面分布）
      life: randomStart ? Math.random() * 3.0 : 0,
      maxLife: 2.0 + Math.random() * 3.0,
    };

    this._updateColor(i);
    this._applyPosition(i);
  }

  // ✅ 依半徑動態更新顏色：中心白藍亮，外圈深藍暗
  _updateColor(i) {
    const p = this.particles[i];
    const t = 1.0 - (p.r / this.radius);   // 0=外圍, 1=中心
    this.colors[i * 3] = 0.25 + t * 0.65;  // R
    this.colors[i * 3 + 1] = 0.60 + t * 0.38;  // G
    this.colors[i * 3 + 2] = 1.0;               // B
  }

  _applyPosition(i) {
    const p = this.particles[i];
    this.positions[i * 3] = this.drainPosition.x + Math.cos(p.angle) * p.r;
    this.positions[i * 3 + 1] = this.drainPosition.y;   // 保持平面，從上看是圓面
    this.positions[i * 3 + 2] = this.drainPosition.z + Math.sin(p.angle) * p.r;
  }

  setActive(isActive) {
    this.active = isActive;
    this.points.visible = isActive;
    if (isActive) {
      this.fadeOpacity = 0;
      this.fadeElapsed = 0;
    }
  }

  update(delta) {
    if (!this.active) return;

    this.fadeElapsed += delta;
    this.fadeOpacity = Math.min(this.fadeElapsed / this.fadeDuration, 1.0);

    for (let i = 0; i < this.count; i++) {
      const p = this.particles[i];

      // ✅ 旋轉速度：內圈速度指數倍放大
      //    外圈（r≈radius）：omega ≈ baseSpeed × 1（慢）
      //    內圈（r≈0）：omega → 爆增（快）
      const omega = p.baseSpeed * Math.pow(this.radius / (p.r + 0.012), 2.2);
      p.angle += omega * delta;

      // ✅ 極微向心漂移：讓粒子緩慢旋入，製造動態感
      //    但不能太強，否則全堆外圈（之前的問題）
      p.r -= p.driftSpeed * this.radius * delta;

      p.life += delta;

      if (p.life >= p.maxLife || p.r < 0.008) {
        // 重生：重新在整個圓面上以中心偏重分布
        this._initParticle(i, false);
      } else {
        this._updateColor(i);   // 移動後更新顏色
        this._applyPosition(i);
      }
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;

    const flicker = 0.78 + Math.sin(performance.now() * 0.004) * 0.15;
    this.points.material.opacity = flicker * this.fadeOpacity;
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
// ─────────────────────────────────────────
// 三、場景、渲染器、後處理
// ─────────────────────────────────────────
const scene = new THREE.Scene();
window.scene = scene; // ← 新增這行，方便 console 除錯，之後可刪掉
const camera = new THREE.PerspectiveCamera(
  CONFIG.CAMERA.fov,
  window.innerWidth / window.innerHeight,
  0.1, 1000
);
camera.position.set(CONFIG.CAMERA.startPos.x, CONFIG.CAMERA.startPos.y, CONFIG.CAMERA.startPos.z);
window.camera = camera; // ← 新增這一行

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  //logarithmicDepthBuffer: true // 環境太大，camera抓不出微小距離差異
});

renderer.debug.checkShaderErrors = false;//  關鍵優化：關閉 Shader 編譯時的錯誤檢查（避免 CPU/GPU 同步阻塞）

window.renderer = renderer;//測試
renderer.info.autoReset = false;   // ← 測試：關閉自動重置，才能抓到完整一幀的統計

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.2, 0.5, 0.85
));

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;width:100%;height:100%';
document.body.appendChild(labelRenderer.domElement);

RectAreaLightUniformsLib.init();//

// ─────────────────────────────────────────
// 四、工具函式
// ─────────────────────────────────────────

/**
 * 從完整裝置名稱取得裝置類型
 * 'faucet' | 'faucet_2' | 'faucet_3' → 'faucet'
 * 'shower' | 'shower_2'              → 'shower'
 */
// 替換舊版（只識別 faucet/shower 前綴）
function getDeviceType(name) {
  const cfg = PIPE_CONFIG[name];
  return cfg ? cfg.type : null;
}

function createConeVolumetricLight(color) {
  const h = 3.2;
  const geo = new THREE.ConeGeometry(0.55, h, 32, 1, true);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uHeight: { value: h }
    },
    vertexShader: `
            varying float vY; varying vec3 vNormal, vViewDir;
            void main() {
                vY = position.y;
                vec4 wp = modelMatrix * vec4(position,1.0);
                vNormal  = normalize(normalMatrix * normal);
                vViewDir = normalize(cameraPosition - wp.xyz);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
            }`,
    fragmentShader: `
            uniform vec3 uColor; uniform float uHeight;
            varying float vY; varying vec3 vNormal, vViewDir;
            void main() {
                float tF = smoothstep(uHeight/2.0, uHeight/2.0-0.6, vY);
                float bF = smoothstep(-uHeight/2.0, -uHeight/2.0+1.8, vY);
                float rF = smoothstep(0.0, 0.4, abs(dot(vNormal,vViewDir)));
                gl_FragColor = vec4(uColor, 0.22*tF*bF*rF);
            }`,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -h / 2;
  return mesh;
}

// ── 徑向漸層光暈貼圖（快取，只建立一次） ──
let _radialGlowTexture = null;
function getRadialGlowTexture() {
  if (_radialGlowTexture) return _radialGlowTexture;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  // 中心最亮最白，往外逐漸轉暖橙、再淡化到全透明，曲線連續無斷層
  gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.12, 'rgba(255,235,200,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,204,136,0.45)');
  gradient.addColorStop(0.65, 'rgba(255,204,136,0.12)');
  gradient.addColorStop(1.0, 'rgba(255,204,136,0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  _radialGlowTexture = new THREE.CanvasTexture(canvas);
  return _radialGlowTexture;
}

//碰撞head
function checkCurrentCollision() {
  if (collidableObjects.length === 0) return false;
  for (const dir of rayDirections) {
    const worldDir = dir.clone().applyQuaternion(camera.quaternion).normalize();
    raycaster.set(camera.position, worldDir);
    const intersects = raycaster.intersectObjects(collidableObjects);
    if (intersects.length > 0 && intersects[0].distance < 0.2) {
      return true;
    }
  }
  return false;
}

function handleMovementAndCollision(moveVelocity) {
  if (isNoclipMode) {
    camera.position.add(moveVelocity);
    return;
  }

  if (isStuckInWall) {
    const stillColliding = checkCurrentCollision();
    if (!stillColliding) {
      isStuckInWall = false;
    }
    camera.position.add(moveVelocity);
    return;
  }

  if (collidableObjects.length > 0 && (moveVelocity.x !== 0 || moveVelocity.z !== 0)) {
    const moveDir = moveVelocity.clone().normalize();
    raycaster.set(camera.position, moveDir);
    const intersects = raycaster.intersectObjects(collidableObjects);
    if (intersects.length > 0 && intersects[0].distance < collisionDistance) {
      const hitNormal = intersects[0].face.normal.clone();
      hitNormal.applyQuaternion(intersects[0].object.quaternion);
      hitNormal.y = 0;
      hitNormal.normalize();
      const dotProduct = moveVelocity.dot(hitNormal);
      moveVelocity.sub(hitNormal.multiplyScalar(dotProduct));
    }
  }

  camera.position.add(moveVelocity);
};
//碰撞end

//水池範圍
function isCameraInPool() {
  if (!poolBounds) return false;
  return (
    camera.position.x >= poolBounds.min.x && camera.position.x <= poolBounds.max.x &&
    camera.position.z >= poolBounds.min.z && camera.position.z <= poolBounds.max.z
  );
}

function setupPipeMaterial(mesh, colorType = 'cold') {
  mesh.material = PIPE_MATERIALS[colorType].inactive;
}

//樓梯每幀更新高度的函式
function updateStaircase(delta) {
  if (isNoclipMode) { isOnStairRail = false; return; }

  const dx = camera.position.x - STAIRCASE.center.x;
  const dz = camera.position.z - STAIRCASE.center.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (!isOnStairRail && dist <= STAIRCASE.radius + STAIRCASE.radiusMargin) {
    isOnStairRail = true;
    const entryAngle = Math.atan2(dz, dx);
    stairHeight = (camera.position.y > STAIRCASE.center.y + STAIRCASE.totalHeight / 2)
      ? STAIRCASE.totalHeight
      : 0;
    // 反向旋转公式：角度 = offset - 比例*2π*turns
    stairAngleOffset = entryAngle + (stairHeight / STAIRCASE.totalHeight) * (Math.PI * 2 * STAIRCASE.turns);
  }

  if (!isOnStairRail) return;

  // ── 依「摄影机面向 + WASD 意图」算出世界座标移动方向，而非死板的 W=上 S=下 ──
  const inputZ = Number(moveForward) - Number(moveBackward);
  const inputX = Number(moveRight) - Number(moveLeft);
  let inputDir = 0;

  if (inputZ !== 0 || inputX !== 0) {
    const localDir = new THREE.Vector3(inputX, 0, -inputZ).normalize(); // ← 加负号
    const worldDir = localDir.applyQuaternion(camera.quaternion);
    worldDir.y = 0;
    worldDir.normalize();

    const angleNow = stairAngleOffset - (stairHeight / STAIRCASE.totalHeight) * (Math.PI * 2 * STAIRCASE.turns);
    const tangentUp = new THREE.Vector3(Math.sin(angleNow), 0, -Math.cos(angleNow));

    inputDir = worldDir.dot(tangentUp);
  }

  stairHeight += inputDir * STAIRCASE.climbSpeed * delta;

  if (stairHeight >= STAIRCASE.totalHeight && inputDir > 0) {
    stairHeight = STAIRCASE.totalHeight;
    isOnStairRail = false;
    return;
  }
  if (stairHeight <= 0 && inputDir < 0) {
    stairHeight = 0;
    isOnStairRail = false;
    return;
  }
  stairHeight = Math.max(0, Math.min(STAIRCASE.totalHeight, stairHeight));

  const angle = stairAngleOffset - (stairHeight / STAIRCASE.totalHeight) * (Math.PI * 2 * STAIRCASE.turns);
  camera.position.x = STAIRCASE.center.x + Math.cos(angle) * STAIRCASE.walkRadius;
  camera.position.z = STAIRCASE.center.z + Math.sin(angle) * STAIRCASE.walkRadius;

  const steppedHeight = Math.round(stairHeight / STAIRCASE.stepHeight) * STAIRCASE.stepHeight;
  const targetY = STAIRCASE.center.y + steppedHeight;
  camera.position.y += (targetY - camera.position.y) * Math.min(delta * 10, 1);
}

/**
 * 為指定裝置建立水流粒子系統
 * @param {string} deviceName 完整裝置名稱，如 'faucet', 'faucet_2', 'shower_2'
 */
function _createWaterFlow(deviceName) {
  const cfg = PIPE_CONFIG[deviceName];
  if (!cfg) {
    return;
  }

  let emitPos;
  if (outletObjects[cfg.outletKey]) {
    emitPos = new THREE.Vector3();
    outletObjects[cfg.outletKey].getWorldPosition(emitPos);
  } else {
    const deviceMesh = interactiveDevices.find(m => m.name.toLowerCase() === deviceName);
    if (!deviceMesh) {
      console.warn(`[WaterFlow] 找不到 ${deviceName}，水流建立失敗`);
      return;
    }
    const box = new THREE.Box3().setFromObject(deviceMesh);
    emitPos = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      box.min.y,
      (box.min.z + box.max.z) / 2
    );
  }

  waterFlows[deviceName] = new WaterFlow(scene, emitPos, cfg.type);
}

// ─────────────────────────────────────────
// 五、Loader 宣告
// ─────────────────────────────────────────
// ✅ 只宣告一次 manager
const manager = new THREE.LoadingManager();

const loadingScreen = document.getElementById('loading-screen');
const instructions = document.getElementById('instructions');

function finishLoading() {
  instructions.classList.add('at-corner');
  loadingScreen.classList.add('fade-out');

  setTimeout(() => {
    document.body.appendChild(instructions);
    loadingScreen.style.display = 'none';
  }, 600);
}

manager.onLoad = finishLoading;

manager.onProgress = (url, loaded, total) => {
  const percent = (loaded / total) * 100;
  const bar = document.getElementById('loader-bar');
  const text = document.getElementById('loader-text');
  if (bar) bar.style.width = percent + '%';
  if (text) text.textContent = `正在載入... ${Math.round(percent)}%`;
};

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

const loader = new GLTFLoader(manager);
loader.setDRACOLoader(dracoLoader);

const rgbeLoader = new RGBELoader(manager);
//const exrLoader = new EXRLoader(manager);

const textureLoader = new THREE.TextureLoader(manager);
const aoMap = textureLoader.load('textures/bake_ao.png');
aoMap.colorSpace = THREE.NoColorSpace; // AO 貼圖是資料貼圖，不能當 sRGB 處理
aoMap.flipY = false; // glTF/GLB 的 UV 原點跟一般圖片不同，通常要關掉，否則貼圖會上下顛倒

// ─────────────────────────────────────────
// 六、載入資源
// ─────────────────────────────────────────
// 背景格線
const gridHelper = new THREE.GridHelper(100, 100, 0xffffff, 0x888888);
gridHelper.material.opacity = 0.3;
gridHelper.material.transparent = true;
scene.add(gridHelper);

scene.add(new THREE.AmbientLight(0xffffff, 0.005));

rgbeLoader.load(CONFIG.MODELS.HDRI, (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = hdr;
  scene.background = hdr;
});
// exrLoader.load(CONFIG.MODELS.HDRI, (hdr) => {
//   hdr.mapping = THREE.EquirectangularReflectionMapping;
//   scene.environment = hdr;
// });

loader.load(CONFIG.MODELS.BUILDING, (gltf) => {
  scene.add(gltf.scene);
  gltf.scene.updateMatrixWorld(true);

  gltf.scene.traverse((obj) => {
    if (obj.isMesh) return;
    const name = obj.name.toLowerCase();
    if (!name.includes('sliding_door')) return;

    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);

    const DOOR_OPEN_MARGIN = 0.1;
    const slideAxis = SLIDE_AXIS_OVERRIDE[name] ?? (size.x >= size.z ? 'x' : 'z');
    const slideDistance = Math.max(0, (slideAxis === 'z' ? size.z : size.x) - DOOR_OPEN_MARGIN);
    const slideSign = SLIDE_SIGN_OVERRIDE[name] ?? -1;

    doorAnimations[name] = {
      mesh: obj,
      isOpen: false,
      progress: 0,
      direction: 0,
      type: 'sliding',
      slideAxis,
      slideSign,
      slideDistance,
      startX: obj.position.x,
      startZ: obj.position.z,
    };

    obj.traverse((child) => {
      if (child.isMesh) doorObjects.push(child);
    });
  });

  // ── 第一遍：收集 outlet 空物件 ────────────────────────────
  gltf.scene.traverse((obj) => {
    const name = obj.name.toLowerCase();
    if (Object.values(PIPE_CONFIG).some(cfg => cfg.outletKey === name)) {
      outletObjects[name] = obj;
    }
  });

  // ✅ 在第二遍 traverse 之前預先建立集合（不要放在 traverse 裡面）
  const allColdPipeNames = new Set(
    Object.values(PIPE_CONFIG).flatMap(cfg => cfg.coldPipes)
  );
  const alldrainPipeNames = new Set(
    Object.values(PIPE_CONFIG).flatMap(cfg => cfg.drainPipes)
  );

  // ── 第二遍：處理 mesh ─────────────────────────────────────
  gltf.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const name = mesh.name.toLowerCase();

    const isBulb = name.includes('bulb');
    const isPipe = allColdPipeNames.has(name) || alldrainPipeNames.has(name);
    const isDevice = !!PIPE_CONFIG[name];
    if (!isBulb && !isPipe && !isDevice) {
      cachedSceneMeshes.push(mesh);
    }

    //水池
    if (name === 'floor_pool_water') {
      poolWaterMeshes.push(mesh);
    }

    // ✅ 套用烘焙 AO 貼圖
    if (AO_BAKE_TARGETS.has(name) && mesh.material) {

      // 1️⃣ 嚴格檢查：只認模型自帶的第三組 uv2 頂點屬性，排除 automap (uv1) 的干擾
      if (mesh.geometry.attributes.uv2) {

        // 防止多個物件共用同一個材質球，導致大家的陰影互相覆蓋、錯位
        mesh.material = mesh.material.clone();

        if (aoMap) {
          // 🌟 依照你指定的 Three.js 新版對應規則：0=uv, 1=uv1, 2=uv2
          // 強制將貼圖通道綁定在第三組 UV（uv2）上
          aoMap.channel = 2;
        }

        // 正式將烘焙好的陰影貼圖掛載上去
        mesh.material.aoMap = aoMap;
        mesh.material.aoMapIntensity = 0.4; // 依你調整的舒適深淺度 0.5
        mesh.material.needsUpdate = true;

        console.log(`[AO] ${name} 已成功套用烘焙陰影 (確認綁定 channel = 2)`);
      } else {
        // 萬一 Blender 導出漏勾，直接噴警告，明確指出是缺少第三組 uv2
        console.warn(`[AO 錯誤] ${name} 缺少真正的 uv2 通道，無法套用 AO 貼圖，請檢查 Blender 的 UV Maps 列表第三軌`);
      }
    }

    // 燈泡
    if (name.includes('bulb')) {
      const isLineBulb = name.includes('line_bulb');
      const isBallBulb = name.includes('ball_bulb');
      const isRecBulb = name.includes('rec_bulb');

      if (isLineBulb) {
        if (mesh.material) {
          mesh.material.emissive = new THREE.Color(0xffcc66);
          mesh.material.emissiveIntensity = 3;
          if (mesh.material.map) mesh.material.color.setHex(0x888866);
        }

        // ── 用 geometry 的本地包圍盒，避免世界座標轉換問題 ──
        mesh.geometry.computeBoundingBox();
        const localBox = mesh.geometry.boundingBox;  // 本地座標，不受 mesh 位置影響
        const localSize = new THREE.Vector3();
        localBox.getSize(localSize);
        const localCenterGeo = new THREE.Vector3();
        localBox.getCenter(localCenterGeo);  // geometry 在本地空間的中心

        // 判斷主軸（geometry 本地空間）
        let axis = new THREE.Vector3(0, 1, 0);
        if (localSize.x >= localSize.y && localSize.x >= localSize.z) {
          axis.set(1, 0, 0);
        } else if (localSize.z >= localSize.x && localSize.z >= localSize.y) {
          axis.set(0, 0, 1);
        }

        const axisLength = Math.max(localSize.x, localSize.y, localSize.z);
        const lp = new THREE.PointLight(0xffcc66, 0.5, 3.0, 1.5);
        lp.position.copy(localCenterGeo);
        mesh.add(lp);

        // ── 光暈圓柱（geometry 本地空間對齊）──
        const glowLen = axisLength * 1.02;
        const glowGeo = new THREE.CylinderGeometry(0.03, 0.03, glowLen, 8, 1, true);

        // CylinderGeometry 預設長軸是 Y，需旋轉對齊實際主軸
        if (axis.x === 1) glowGeo.rotateZ(Math.PI / 2);
        else if (axis.z === 1) glowGeo.rotateX(Math.PI / 2);

        const glowMesh = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
          color: 0xffcc66,
          transparent: true,
          opacity: 0.1,
          side: THREE.BackSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }));
        glowMesh.position.copy(localCenterGeo);
        mesh.add(glowMesh);

        const outerGlowGeo = new THREE.CylinderGeometry(0.09, 0.09, glowLen, 8, 1, true);
        if (axis.x === 1) outerGlowGeo.rotateZ(Math.PI / 2);
        else if (axis.z === 1) outerGlowGeo.rotateX(Math.PI / 2);

        const outerGlowMesh = new THREE.Mesh(outerGlowGeo, new THREE.MeshBasicMaterial({
          color: 0xffaa33,
          transparent: true,
          opacity: 0.03,
          side: THREE.BackSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }));
        outerGlowMesh.position.copy(localCenterGeo);
        mesh.add(outerGlowMesh);
      }
      else if (isBallBulb) {
        // ── 球型燈泡 ──
        if (mesh.material) {
          mesh.material.emissive = new THREE.Color(0xffcc88);
          mesh.material.emissiveIntensity = 12;
          if (mesh.material.map) mesh.material.color.setHex(0x888866);
        }

        mesh.geometry.computeBoundingBox();
        const localBox = mesh.geometry.boundingBox;
        const localSize = new THREE.Vector3();
        localBox.getSize(localSize);
        const localCenterGeo = new THREE.Vector3();
        localBox.getCenter(localCenterGeo);

        const baseRadius = Math.max(localSize.x, localSize.y, localSize.z) * 0.5;

        const pt = new THREE.PointLight(0xffcc88, 4.0, 8.0, 2);
        pt.position.copy(localCenterGeo);
        mesh.add(pt);

        // 💡 改用單張徑向漸層 Sprite 取代 7 層離散球殼
        // 優點：漸層連續無斷層、永遠面向鏡頭、效能更省
        const glowTexture = getRadialGlowTexture();
        const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTexture,
          color: 0xffcc88,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }));

        // 光暈整體大小，數字越大範圍越廣，可依實際場景微調
        const glowScale = baseRadius * 9;
        glowSprite.scale.set(glowScale, glowScale, 1);
        glowSprite.position.copy(localCenterGeo);
        glowSprite.userData.isBallBulbGlow = true;
        glowSprite.material.userData._baseOpacity = 0.85;
        mesh.add(glowSprite);

      } else if (isRecBulb) {
        // rec_bulb：只保留材質自發光，不再產生錐體光柱與聚光燈
        if (mesh.material) {
          mesh.material.emissive = new THREE.Color(0xffaa44);
          mesh.material.emissiveIntensity = 10;
          if (mesh.material.map) mesh.material.color.setHex(0x444444);
        }
      }
      else {
        // 一般燈泡（不含 line_bulb / ball_bulb / rec_bulb）：
        // 圓錐體光柱 + 聚光燈效果移到這裡
        if (mesh.material) {
          mesh.material.emissive = new THREE.Color(0xffaa44);
          mesh.material.emissiveIntensity = 10;
          if (mesh.material.map) mesh.material.color.setHex(0x444444);
        }
        const cone = createConeVolumetricLight(0xffaa44);
        cone.position.y = 0.2;
        mesh.add(cone);
        // const spot = new THREE.SpotLight(0xffaa44, 3, 5, Math.PI / 3.5, 0.6, 2);
        // mesh.add(spot);
        // mesh.add(spot.target);
        // spot.target.position.set(0, -10, 0);
      }
    }

    // ✅ 設備識別
    if (PIPE_CONFIG[name]) {
      interactiveDevices.push(mesh);
      activeTimers[name] = { startTime: null, alerted: false };
    }

    // ✅ 管路識別（放在 traverse 裡，name 已存在）
    const isColdPipe = allColdPipeNames.has(name);
    const isdrainPipe = alldrainPipeNames.has(name);

    if (isColdPipe) {
      setupPipeMaterial(mesh, 'cold');                // 藍色
      flowingPipes.set(name, {
        mesh,
        active: false,
        colorType: 'cold',
        isShared: SHARED_COLD_PIPES.has(name),
      });
    }
    if (isdrainPipe) {
      setupPipeMaterial(mesh, 'drain');               // 橘色
      flowingPipes.set(name, {
        mesh,
        active: false,
        colorType: 'drain',
        isShared: SHARED_DRAIN_PIPES.has(name),
      });
    }

    // 碰撞
    if (name.includes('wall') || name.includes('floor') || name.includes('door') || name.includes('stairs')) {
      collidableObjects.push(mesh);
    }

    // traverse 裡收集門
    // traverse 裡的門收集邏輯，取代原本的區塊
    if (name.includes('door_')) {
      doorObjects.push(mesh);
      doorAnimations[name] = {
        mesh,
        isOpen: false,
        progress: 0,
        direction: 0,
        type: 'swing',          // ← 原本旋轉門也標記類型，方便 animate() 判斷
      };
    }

    // ✅ drain 識別
    if (Object.values(PIPE_CONFIG).some(cfg => cfg.drainKey === name)) {
      const worldPos = new THREE.Vector3();
      mesh.getWorldPosition(worldPos);
      if (mesh.material) {
        mesh.material = new THREE.MeshStandardMaterial({
          color: 0xff9d1a, transparent: true, opacity: 0.25,
          roughness: 0.1, metalness: 0.6, depthWrite: false,
        });
      }
      const drainRadius = name.includes('shower') ? 0.6 : 0.25;
      drainFlows[name] = new DrainFlow(scene, worldPos, drainRadius);
    }
    // 新增：靜態物件關閉 autoUpdate，省下每幀對幾百個 Mesh 重新算矩陣的負擔
    const isDoor = name.includes('door') || Object.keys(doorAnimations).includes(name);
    if (!isDoor && !isPipe) {
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
    }
  });

  if (poolWaterMeshes.length > 0) {
    poolBounds = new THREE.Box3();
    poolWaterMeshes.forEach(m => poolBounds.union(new THREE.Box3().setFromObject(m)));
  }

  // ✅ 建立水流
  interactiveDevices.forEach(mesh => {
    _createWaterFlow(mesh.name.toLowerCase());
  });
});

if (AO_BAKE_TARGETS.has(name)) {
  console.log(name, mesh.geometry.attributes);
}


// ── 太陽平行光（右前方斜上 45°）──
// ── 太陽平行光（位置由 applyDayNight 動態設定）──
const sunLight = new THREE.DirectionalLight(0xfff5e0, 0);
scene.add(sunLight);
scene.add(sunLight.target);  // target 預設原點

// 太陽視覺球體
const sunMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1.8, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffee88 })
);
scene.add(sunMesh);

const sunGlow = new THREE.Mesh(
  new THREE.SphereGeometry(3.2, 16, 16),
  new THREE.MeshBasicMaterial({
    color: 0xffcc33, transparent: true,
    opacity: 0.18, side: THREE.BackSide, depthWrite: false,
  })
);
sunMesh.add(sunGlow);
// ─────────────────────────────────────────
// 七、UI
// ─────────────────────────────────────────

// ── 中央選單面板 ──
const menuPanel = document.createElement('div');
Object.assign(menuPanel.style, {
  display: 'none',
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'rgba(0, 0, 0, 0.75)',
  backdropFilter: 'blur(8px)',
  border: '1px solid rgba(0,255,255,0.4)',
  borderRadius: '12px',
  padding: '24px 36px',
  zIndex: '200',
  display: 'none',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '12px',
  minWidth: '220px',
  pointerEvents: 'auto',
});
document.body.appendChild(menuPanel);

const menuTitle = document.createElement('div');
menuTitle.innerText = '選單';
Object.assign(menuTitle.style, {
  color: 'rgba(255,255,255,0.6)',
  fontSize: '13px',
  marginBottom: '4px',
  letterSpacing: '2px',
});
menuPanel.appendChild(menuTitle);

const xrayBtn = document.createElement('button');
xrayBtn.innerText = '開啟管路透視模式';
Object.assign(xrayBtn.style, {
  padding: '10px 20px',
  cursor: 'pointer',
  background: 'rgba(0,255,255,0.2)',
  color: 'white',
  border: '1px solid cyan',
  borderRadius: '6px',
  fontSize: '15px',
  width: '100%',
});
xrayBtn.onclick = (e) => {
  e.stopPropagation();
  unlockFromButton = true;
  isXRayMode = !isXRayMode;
  xrayBtn.innerText = isXRayMode ? '關閉管路透視模式' : '開啟管路透視模式';
  xrayBtn.style.background = isXRayMode
    ? 'rgba(0,255,255,0.5)'
    : 'rgba(0,255,255,0.2)';
  toggleXRayMode(isXRayMode);
  menuPanel.style.display = 'none';
  setTimeout(() => {
    unlockFromButton = false;
    controls.lock();
  }, 80);
};
menuPanel.appendChild(xrayBtn);

// ── 面板開關函式 ──
function openMenu() {
  if (controls.isLocked) controls.unlock();
  menuPanel.style.display = 'flex';
}

function closeMenu() {
  unlockFromButton = true;
  menuPanel.style.display = 'none';
  setTimeout(() => {
    unlockFromButton = false;
    controls.lock();
  }, 80);
}

// ── 補回這個函式 ──
function toggleXRayMode(enable) {

  //碰撞head
  isNoclipMode = enable;

  if (!enable) {
    // 關閉透視模式時檢查是否卡牆
    isStuckInWall = checkCurrentCollision();
  }
  //碰撞end

  // ── 管路透視模式：鎖定亮度在預設值，並隱藏日夜滑桿 ──
  if (enable) {
    daySliderValueBeforeXRay = daySlider.value;
    daySlider.value = String(DEFAULT_DAY_VALUE);
    applyDayNight(DEFAULT_DAY_VALUE);
    sliderWrap.style.opacity = '0';
    sliderWrap.style.pointerEvents = 'none';
  } else {
    if (daySliderValueBeforeXRay !== null) {
      daySlider.value = daySliderValueBeforeXRay;
      applyDayNight(parseFloat(daySliderValueBeforeXRay));
      daySliderValueBeforeXRay = null;
    }
  }

  // ── 開啟管路透視模式下關閉太陽 ──
  if (enable) {
    sunLight.userData._xray_intensity = sunLight.intensity;
    sunLight.intensity = 0;
    sunMesh.visible = false;
  } else {
    sunLight.intensity = sunLight.userData._xray_intensity ?? sunLight.intensity;
    sunMesh.visible = true;
  };

  // ── 管路透視模式下背景切換 ──
  if (enable) {
    scene.userData._origBackground = scene.background;
    scene.background = new THREE.Color(0x000000);  // 純黑背景
  } else {
    scene.background = scene.userData._origBackground ?? null;
  }

  // ── 環境貼圖切換（避免 HDR 反射讓管路發亮）──
  // if (enable) {
  //   scene.userData._origEnvironment = scene.environment;
  //   scene.environment = null;
  // } else {
  //   scene.environment = scene.userData._origEnvironment ?? null;
  // }

  // ── 燈泡：用 bulbMeshes 快取 ──
  // ── 燈泡：用 bulbMeshes 快取 ──
  bulbMeshes.forEach(({ mesh }) => {
    if (mesh.material) {
      if (enable) {
        mesh.material.userData._xray_emissive = mesh.material.emissiveIntensity;
        mesh.material.emissiveIntensity = 0;
      }
      mesh.material.needsUpdate = true;
    }
    mesh.children.forEach(c => {
      if (c.isLight) {
        if (enable) {
          c.userData._xray_intensity = c.intensity;
          c.intensity = 0;
        } else {
          c.intensity = c.userData._xray_intensity ?? c.intensity;
        }
      }
      if ((c.isMesh || c.isSprite) && (c.userData.isLineBulbGlow || c.userData.isBallBulbGlow)) {
        c.visible = !enable;
      }
    });
  });
  if (!enable) {
    applyBulbStrength(currentBulbStrength);
  }

  // ── 一般物件：用 cachedSceneMeshes 快取 ──
  const processedMaterials = new Set();
  cachedSceneMeshes.forEach((obj) => {
    const mat = obj.material;
    if (!mat || processedMaterials.has(mat)) return;
    processedMaterials.add(mat);
    if (enable) {
      mat.userData._origOpacity = mat.opacity;
      mat.userData._origTransparent = mat.transparent;
      mat.userData._origDepthWrite = mat.depthWrite;
      mat.transparent = true;
      mat.opacity = 0.15;
      mat.depthWrite = false;
    } else {
      mat.opacity = mat.userData._origOpacity ?? 1.0;
      mat.transparent = mat.userData._origTransparent ?? false;
      mat.depthWrite = mat.userData._origDepthWrite ?? true;
    }
    mat.needsUpdate = true;
  });

  // ── 管路：用 flowingPipes 快取 ──
  PIPE_MATERIALS.cold.inactive.opacity = enable ? 0.45 : 0.12;
  PIPE_MATERIALS.drain.inactive.opacity = enable ? 0.45 : 0.12;
}

// ── 右鍵開選單 ──
// 取代原本的 contextmenu 監聽
renderer.domElement.addEventListener('dblclick', () => {
  openMenu();
});

// ── 警告彈窗 ──────────────────────────────────────────────────
const warningModal = document.createElement('div');
Object.assign(warningModal.style, {
  display: 'none',
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'rgba(180, 40, 0, 0.93)',
  color: 'white',
  padding: '28px 40px',
  borderRadius: '12px',
  fontSize: '20px',
  fontWeight: 'bold',
  textAlign: 'center',
  zIndex: '999',
  boxShadow: '0 0 30px rgba(255,100,0,0.8)',
  border: '2px solid orange',
  minWidth: '300px',
  lineHeight: '1.6',
  pointerEvents: 'auto',
});
document.body.appendChild(warningModal);

const warningText = document.createElement('div');
warningModal.appendChild(warningText);

const warningCloseBtn = document.createElement('button');
warningCloseBtn.innerText = '我知道了';
Object.assign(warningCloseBtn.style, {
  padding: '8px 24px',
  cursor: 'pointer',
  background: 'white',
  color: '#c03000',
  border: 'none',
  borderRadius: '6px',
  fontWeight: 'bold',
  fontSize: '15px',
  display: 'block',
  margin: '16px auto 0',
});
warningCloseBtn.onclick = () => {
  const deviceName = warningCloseBtn.dataset.device;

  for (const key in activeTimers) {
    if (activeTimers[key].startTime) activeTimers[key].startTime = Date.now();
    activeTimers[key].alerted = false;
  }

  dismissCurrentWarning(deviceName); // ★ 移除目前這個，並自動顯示佇列裡的下一個

  // 選單仍開著就不鎖定，讓游標保持可見；佇列還有其他警告要顯示時也不要鎖定
  if (menuPanel.style.display !== 'flex' && warningQueue.length === 0) {
    setTimeout(() => controls.lock(), 80);
  }
};
warningModal.appendChild(warningCloseBtn);

const warningOffBtn = document.createElement('button');
warningOffBtn.innerText = '關閉水流';
Object.assign(warningOffBtn.style, {
  padding: '8px 24px',
  cursor: 'pointer',
  background: '#c03000',
  color: 'white',
  border: 'none',
  borderRadius: '6px',
  fontWeight: 'bold',
  fontSize: '15px',
  display: 'block',
  margin: '10px auto 0',
});

// ★ 新增：把「關閉水流」的實際邏輯抽成獨立函式，
//    這樣「按鈕手動關閉」跟「LINE 遠端關閉」都能共用同一套邏輯
function closeDeviceWater(deviceName) {
  const cfg = PIPE_CONFIG[deviceName];
  if (!cfg) return;

  cfg.coldPipes.forEach(pipeName => {
    const p = flowingPipes.get(pipeName);
    if (!p) return;
    const stillUsed = Object.entries(PIPE_CONFIG).some(([dName, dCfg]) => {
      if (dName === deviceName) return false;
      if (!dCfg.coldPipes.includes(pipeName)) return false;
      const endPipe = flowingPipes.get(dCfg.coldPipes[dCfg.coldPipes.length - 1]);
      return endPipe?.active ?? false;
    });
    if (!stillUsed) {
      setPipeState(p, 'inactive');
    }
  });

  cfg.drainPipes.forEach(pipeName => {
    const p = flowingPipes.get(pipeName);
    if (!p) return;
    const stillUsed = Object.entries(PIPE_CONFIG).some(([dName, dCfg]) => {
      if (dName === deviceName) return false;
      if (!dCfg.drainPipes.includes(pipeName)) return false;
      const endPipe = flowingPipes.get(dCfg.coldPipes[dCfg.coldPipes.length - 1]);
      return endPipe?.active ?? false;
    });
    if (!stillUsed) {
      p.active = false;
      p.mesh.material.opacity = getInactivePipeOpacity();
    }
  });

  waterFlows[deviceName]?.setActive(false);
  drainFlows[cfg.drainKey]?.setActive(false);

  if (activeTimers[deviceName]) {
    activeTimers[deviceName].startTime = null;
    activeTimers[deviceName].alerted = false;
  }
}

warningOffBtn.onclick = () => {
  const deviceName = warningOffBtn.dataset.device;

  closeDeviceWater(deviceName);
  stopPollingRemoteClose(deviceName);

  dismissCurrentWarning(deviceName); // ★ 移除目前這個，並自動顯示佇列裡的下一個

  if (menuPanel.style.display !== 'flex' && warningQueue.length === 0) {
    setTimeout(() => controls.lock(), 80);
  }
};
warningModal.appendChild(warningOffBtn);

/**
 * 顯示出水超時警告
 * @param {string} deviceName 完整裝置名稱，如 'faucet', 'faucet_2', 'shower_2'
 */
// ── Google Apps Script 網址（僅用於發送 LINE 通知） ──


const currentWarningToken = {};

async function markTimeoutAlert(deviceName, token) {

  if (!LINE_NOTIFY_ENABLED) return; // ★ 關閉line連結時，直接跳過，不寫入 Firebase
  await authReadyPromise; // ★ 確保匿名登入完成才寫入

  const path = `sessions/${token}/${deviceName}`;
  try {
    await set(ref(db, path), {
      status: 'timeout_alert',
      notified: false,
      timestamp: Date.now()
    });
  } catch (err) {
    console.warn('[Firebase] 寫入超時警告失敗', err);
  }
}

const activeListeners = {}; // 取代原本的 pollingIntervals，存放各裝置的 Firebase 監聽解除函式

async function startPollingRemoteClose(deviceName, token) {

  await authReadyPromise; // ★ 確保匿名登入完成才監聽
  stopPollingRemoteClose(deviceName);

  const path = `sessions/${token}/${deviceName}`;
  const nodeRef = ref(db, path);

  activeListeners[deviceName] = onValue(nodeRef, (snapshot) => {
    const data = snapshot.val();
    if (data && data.shouldClose) {
      closeDeviceWater(deviceName);
      stopPollingRemoteClose(deviceName);
      dismissCurrentWarning(deviceName);
      remove(nodeRef); // 讀取後刪除，避免殘留
    }
  }, (err) => {
    console.warn('[Firebase] 監聽失敗', err);
  });
}

function stopPollingRemoteClose(deviceName) {
  if (activeListeners[deviceName]) {
    activeListeners[deviceName](); // onValue 回傳的 unsubscribe 函式
    delete activeListeners[deviceName];
  }
}

const warningQueue = []; // 待顯示的裝置警告佇列

function showWarning(deviceName) {
  if (warningQueue.includes(deviceName)) return;
  warningQueue.push(deviceName);

  const token = sessionId + '_' + Date.now();
  currentWarningToken[deviceName] = token;

  markTimeoutAlert(deviceName, token);       // ★ 原本是 sendLineNotification(deviceName, token)
  if (LINE_NOTIFY_ENABLED) {           // ★ 關閉line連結時就不需要監聽了
    startPollingRemoteClose(deviceName, token);
  }

  if (warningQueue.length === 1) {
    displayNextWarning();
  }
}

function displayNextWarning() {
  if (warningQueue.length === 0) {
    warningModal.style.display = 'none';
    return;
  }
  const deviceName = warningQueue[0];
  const label = DEVICE_LABEL[deviceName] ?? deviceName;
  warningText.innerHTML =
    `⚠️ 警告<br>
        <span style="color:#ffdd00;font-size:22px">${label}</span><br>
        已持續出水超過 <span style="color:#ffdd00">1 分鐘</span>！<br>
        請確認是否忘記關閉。`;
  warningModal.style.display = 'block';
  warningCloseBtn.dataset.device = deviceName;
  warningOffBtn.dataset.device = deviceName;
  controls.unlock();
}

// 每個按鈕處理完自己的裝置後，都要呼叫：
function dismissCurrentWarning(deviceName) {
  const idx = warningQueue.indexOf(deviceName);
  if (idx !== -1) warningQueue.splice(idx, 1);
  displayNextWarning(); // 換下一個
}

// ─────────────────────────────────────────
// 日夜滑桿（ESC 顯示 / 左鍵鎖定後隱藏）
// ─────────────────────────────────────────
let targetBulbStrength = 1.0;
let currentBulbStrength = 1.0;
const BULB_LERP_SPEED = 30.0;
const bulbMeshes = [];

function collectBulbs() {
  scene.traverse((obj) => {
    if (!obj.isMesh || !obj.name.toLowerCase().includes('bulb')) return;
    const name = obj.name.toLowerCase();
    const isLineBulb = /line_+bulb/.test(name);
    const isBallBulb = name.includes('ball_bulb');
    const isRecBulb = name.includes('rec_bulb');

    if (isLineBulb) {
      const lights = obj.children.filter(c => c.isPointLight);
      bulbMeshes.push({ mesh: obj, spot: null, lineLights: lights, ballLight: null, rectLight: null });
    } else if (isBallBulb) {
      const pt = obj.children.find(c => c.isPointLight) ?? null;
      bulbMeshes.push({ mesh: obj, spot: null, lineLights: null, ballLight: pt, rectLight: null });
    } else if (isRecBulb) {
      const rl = obj.children.find(c => c.isRectAreaLight) ?? null;
      bulbMeshes.push({ mesh: obj, spot: null, lineLights: null, ballLight: null, rectLight: rl });
    } else {
      const spot = obj.children.find(c => c.isSpotLight) ?? null;
      bulbMeshes.push({ mesh: obj, spot, lineLights: null, ballLight: null, rectLight: null });
    }
  });
};

// 掛在 manager.onLoad 之後執行
const _origOnLoad = manager.onLoad;
manager.onLoad = () => {
  _origOnLoad?.();
  collectBulbs();
  applyDayNight(parseFloat(daySlider.value));
  currentBulbStrength = targetBulbStrength;
  applyBulbStrength(currentBulbStrength);
};

// ── 滑桿容器（預設隱藏）──
const sliderWrap = document.createElement('div');
Object.assign(sliderWrap.style, {
  position: 'fixed',
  bottom: '28px',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  background: 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(6px)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '40px',
  padding: '10px 22px',
  zIndex: '300',
  pointerEvents: 'none',       // ← 預設不可互動
  userSelect: 'none',
  opacity: '0',          // ← 預設透明
  transition: 'opacity 0.3s ease',
});
document.body.appendChild(sliderWrap);

sliderWrap.appendChild(Object.assign(document.createElement('span'), {
  textContent: '🌙', style: 'font-size:22px'
}));

const daySlider = document.createElement('input');
Object.assign(daySlider, { type: 'range', min: '0', max: '100', value: '50' });
Object.assign(daySlider.style, { width: '200px', cursor: 'pointer', accentColor: '#ffd97a' });
sliderWrap.appendChild(daySlider);

// ── 管路透視模式：記錄進入前的日夜滑桿數值，用於還原 ──
const DEFAULT_DAY_VALUE = 50;
let daySliderValueBeforeXRay = null;

sliderWrap.appendChild(Object.assign(document.createElement('span'), {
  textContent: '☀️', style: 'font-size:22px'
}));

// ── 核心日夜函式 ──
function applyDayNight(t) {
  const n = t / 100;   // 0 = 地平線, 1 = 45° 仰角

  // ── 1. 太陽仰角（0° → 45°）及位置 ──────────────────────
  const elevation = n * (Math.PI / 4);     // 0 → π/4 (45°)
  const azimuth = Math.PI / 4;           // 固定右前方 45° 方位角
  const dist = 60;

  const sx = Math.cos(elevation) * Math.sin(azimuth) * dist;
  const sy = Math.sin(elevation) * dist;
  const sz = +Math.cos(elevation) * Math.cos(azimuth) * dist;// 第一個-Math改成+Math，右前方移到右後方

  sunLight.position.set(sx, sy, sz);
  sunMesh.position.set(sx, sy, sz);

  // ── 2. 太陽光強度：sin(仰角)，地平線時幾乎為 0 ──────────
  const sinElev = Math.sin(elevation);         // 0 → 0.707
  sunLight.intensity = sinElev * 3.6;

  // ── 3. 太陽色溫：地平線橙紅 → 高空暖白 ──────────────────
  const dawnColor = new THREE.Color(0xffd0a0);
  const noonColor = new THREE.Color(0xfff5e0);
  const sunColor = dawnColor.clone().lerp(noonColor, n);
  sunLight.color.copy(sunColor);
  sunMesh.material.color.copy(sunColor);

  // ── 4. 渲染曝光：地平線暗 → 高空亮 ──────────────────────
  renderer.toneMappingExposure = 0.2 + n * 1.0;   // 0.2 → 1.2

  // ── 5. 環境光：隨仰角增強 ────────────────────────────────
  const ambLight = scene.children.find(o => o.isAmbientLight);
  if (ambLight) ambLight.intensity = 0.005 + n * 0.5;

  // ── 6. 天空色：暗橙（地平線）→ 淺藍（高空）─────────────
  if (scene.background instanceof THREE.Color) {
    scene.background.lerpColors(
      new THREE.Color(0x0d0503),   // 近黑暗橙
      new THREE.Color(0x87ceeb),   // 晴天藍
      n
    );
  }

  // ── 7. 室內燈泡：太陽低時維持開燈，超過 55 即滅 ─────────
  // ── 7. 室內燈泡：固定原始亮度，超過 55 即滅 ──
  if (n <= 0.5) {
    const refExp = 1.8;
    const curExp = 1.3 + n;
    targetBulbStrength = Math.min(refExp / curExp, 3.0);
  } else if (n <= 0.55) {
    targetBulbStrength = 1.0
  } else {
    targetBulbStrength = 0.0;
  }

  // ❌ 舊的（有補償，會越來越亮）：
  // if (n <= 0.5) {
  //     const refExp = 0.2 + 0.5 * 1.0;
  //     const curExp = 0.1 + n * 0.6;
  //     targetBulbStrength = Math.min(refExp / curExp, 3.0);
  // } else if (n <= 0.55) {
  //     targetBulbStrength = 0.70;
  // } else {
  //     targetBulbStrength = 0.0;
  // }

  // ✅ 新的（固定原始亮度）：
  //targetBulbStrength = n <= 0.50 ? 1.0 : 0.0;
};

function applyBulbStrength(s) {
  // 管路透視模式下燈泡強制鎖定關閉，避免 animate() 裡的 lerp 動畫把燈又點亮
  if (isXRayMode) return;
  bulbMeshes.forEach(({ mesh, spot, lineLights, ballLight, rectLight }) => {
    if (mesh.material) {
      if (lineLights) mesh.material.emissiveIntensity = s * 3;
      else if (ballLight) mesh.material.emissiveIntensity = s * 12;
      else if (rectLight) mesh.material.emissiveIntensity = s * 3;
      else mesh.material.emissiveIntensity = s * 10;
    }
    if (spot) spot.intensity = s * 3;
    if (ballLight) ballLight.intensity = s * 4.0;
    if (rectLight) rectLight.intensity = s * 3;
    if (lineLights) lineLights.forEach(l => l.intensity = s * 0.3);

    mesh.children.forEach(c => {
      if (!c.isMesh && !c.isSprite) return;
      if (c.userData.isLineBulbGlow || c.userData.isBallBulbGlow || c.userData.isRecBulbGlow) {
        const base = c.material.userData._baseOpacity ?? 0.1;
        c.material.opacity = s > 0.05 ? base : 0;
        c.material.needsUpdate = true;
      }
    });
  });
};

daySlider.addEventListener('input', () => {
  if (isXRayMode) return; // 管路透視模式下亮度鎖定，不回應滑桿
  applyDayNight(parseFloat(daySlider.value));
});
daySlider.addEventListener('mousedown', e => e.stopPropagation());
daySlider.addEventListener('click', e => e.stopPropagation());
// ─────────────────────────────────────────
// 八、控制與互動
// ─────────────────────────────────────────
//十字鎖住控制
const controls = new PointerLockControls(camera, renderer.domElement);

// ── 鎖定/解鎖時切換滑桿顯示 ──
controls.addEventListener('lock', () => {
  sliderWrap.style.opacity = '0';
  sliderWrap.style.pointerEvents = 'none';
});

controls.addEventListener('unlock', () => {
  if (warningModal.style.display !== 'block') {
    if (!isXRayMode) {
      sliderWrap.style.opacity = '1';
      sliderWrap.style.pointerEvents = 'auto';
    }
    if (!unlockFromButton) {
      menuPanel.style.display = 'flex';
    }
  }
});

// 已鎖定 → 正常 raycaster 互動
renderer.domElement.addEventListener('click', () => {
  // 選單開著 → 左鍵關選單
  if (menuPanel.style.display === 'flex') {
    closeMenu();
    return;
  }

  // 未鎖定 → 左鍵鎖定
  if (!controls.isLocked) {
    controls.lock();
    return;
  }

  // 已鎖定 → raycaster 互動
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

  // 門 click 事件
  const doorIntersects = raycaster.intersectObjects(doorObjects);
  if (doorIntersects.length) {
    let obj = doorIntersects[0].object;
    while (obj && !obj.name.toLowerCase().includes('sliding_door') && !obj.name.toLowerCase().includes('door_')) {
      obj = obj.parent;
    }
    const doorName = obj?.name.toLowerCase();
    const anim = doorAnimations[doorName];
    if (anim) {
      anim.direction = anim.isOpen ? -1 : 1;
      anim.isOpen = !anim.isOpen;
    }
    return;
  }


  const intersects = raycaster.intersectObjects(interactiveDevices);
  if (!intersects.length) return;

  const targetName = intersects[0].object.name.toLowerCase();
  const cfg = PIPE_CONFIG[targetName];
  if (!cfg) return;

  const firstColdKey = cfg.coldPipes[cfg.coldPipes.length - 1];
  const firstColdPipe = flowingPipes.get(firstColdKey);
  if (!firstColdPipe) {
    console.warn(`[Click] 找不到管路 ${firstColdKey}`);
    return;
  }

  const isNowActive = !firstColdPipe.active;

  cfg.coldPipes.forEach(pipeName => {
    const p = flowingPipes.get(pipeName);
    if (!p) return;
    if (isNowActive) {
      setPipeState(p, 'active');
    } else {
      const stillUsed = Object.entries(PIPE_CONFIG).some(([dName, dCfg]) => {
        if (dName === targetName) return false;
        if (!dCfg.coldPipes.includes(pipeName)) return false;
        const endPipe = flowingPipes.get(dCfg.coldPipes[dCfg.coldPipes.length - 1]);
        return endPipe?.active ?? false;
      });
      if (!stillUsed) {
        setPipeState(p, 'inactive');
      }
    }
  });

  cfg.drainPipes.forEach(pipeName => {
    const p = flowingPipes.get(pipeName);
    if (!p) return;
    if (isNowActive) {
      setPipeState(p, 'active');
    } else {
      const stillUsed = Object.entries(PIPE_CONFIG).some(([dName, dCfg]) => {
        if (dName === targetName) return false;
        if (!dCfg.drainPipes.includes(pipeName)) return false;
        const endPipe = flowingPipes.get(dCfg.coldPipes[dCfg.coldPipes.length - 1]);
        return endPipe?.active ?? false;
      });
      if (!stillUsed) {
        setPipeState(p, 'inactive');
      }
    }
  });

  waterFlows[targetName]?.setActive(isNowActive);
  drainFlows[cfg.drainKey]?.setActive(isNowActive);

  if (activeTimers[targetName]) {
    if (isNowActive) {
      activeTimers[targetName].startTime = Date.now();
      activeTimers[targetName].alerted = false;
    } else {
      activeTimers[targetName].startTime = null;
      stopPollingRemoteClose(targetName); // 本機手動關閉/開啟後，停掉舊的輪詢
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyW' || e.code === 'ArrowUp') moveForward = true;
  if (e.code === 'KeyS' || e.code === 'ArrowDown') moveBackward = true;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') moveLeft = true;
  if (e.code === 'KeyD' || e.code === 'ArrowRight') moveRight = true;
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'KeyW' || e.code === 'ArrowUp') moveForward = false;
  if (e.code === 'KeyS' || e.code === 'ArrowDown') moveBackward = false;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') moveLeft = false;
  if (e.code === 'KeyD' || e.code === 'ArrowRight') moveRight = false;
});

// ─────────────────────────────────────────
// 九、動畫迴圈
// ─────────────────────────────────────────
const WARNING_MS = 10 * 1000; // 60 秒

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now() / 1000;
  const delta = Math.min(time - prevTime, 0.1);

  // 門開關動畫
  for (const key in doorAnimations) {
    const anim = doorAnimations[key];
    if (anim.direction === 0) continue;

    anim.progress += anim.direction * delta * 1.5;
    anim.progress = Math.max(0, Math.min(1, anim.progress));

    const eased = anim.progress < 0.5
      ? 2 * anim.progress * anim.progress
      : 1 - Math.pow(-2 * anim.progress + 2, 2) / 2;

    if (anim.type === 'sliding') {
      // 依每扇門各自記錄的滑動軸向(X或Z)與方向(+1/-1)套用位移
      const offset = anim.slideSign * eased * anim.slideDistance;
      if (anim.slideAxis === 'z') {
        anim.mesh.position.z = anim.startZ + offset;
      } else {
        anim.mesh.position.x = anim.startX + offset;
      }
    } else {
      anim.mesh.rotation.y = -eased * Math.PI / 2;
    }

    if (anim.progress === 0 || anim.progress === 1) {
      anim.direction = 0;
    }
  }

  // 水流粒子
  for (const key in waterFlows) waterFlows[key].update(delta);
  // 排水漩渦粒子更新
  for (const key in drainFlows) drainFlows[key].update(delta);

  // 管路 emissive 波動
  // 優化：僅針對啟動中的管路或透視模式下做三角函數運算，非必要的靜態管路不重複賦值
  if (isXRayMode) {
    const activeOpacity = 0.5 + Math.sin(time * 10) * 0.3;
    const inactiveOpacity = 0.35 + Math.sin(time * 1.5) * 0.1;
    PIPE_MATERIALS.cold.active_shared.opacity = activeOpacity;
    PIPE_MATERIALS.cold.active_own.opacity = activeOpacity;
    PIPE_MATERIALS.drain.active_shared.opacity = activeOpacity;
    PIPE_MATERIALS.drain.active_own.opacity = activeOpacity;
    PIPE_MATERIALS.cold.inactive.opacity = inactiveOpacity;
    PIPE_MATERIALS.drain.inactive.opacity = inactiveOpacity;
  };

  // 內部計時 → 超過 60 秒跳警告
  for (const key in activeTimers) {
    const timer = activeTimers[key];
    if (timer.startTime && !timer.alerted) {
      if (Date.now() - timer.startTime >= WARNING_MS) {
        timer.alerted = true;
        showWarning(key);
      }
    }
  }

  // 移動
  if (controls.isLocked) {
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    direction.z = Number(moveForward) - Number(moveBackward);
    direction.x = Number(moveRight) - Number(moveLeft);
    direction.normalize();
    if (moveForward || moveBackward) velocity.z -= direction.z * 40.0 * delta;
    if (moveLeft || moveRight) velocity.x -= direction.x * 40.0 * delta;

    if (isHoldWalking && !isTouchMoving) {
      velocity.z -= 3.0;
    }

    const moveVelocity = new THREE.Vector3(
      velocity.x * delta,
      0,
      velocity.z * delta
    );
    moveVelocity.applyQuaternion(camera.quaternion);
    moveVelocity.y = 0;

    if (!isOnStairRail) {              // ← 新增判斷：在軌道模式時不要再套用自由移動
      handleMovementAndCollision(moveVelocity);
    }

    updateStaircase(delta);
  }

  //水池載浮載沉效果
  // ── 水池效果：進入 floor_pool_water 範圍時絲滑下沉 + 漂浮 ──
  const inPool = !isNoclipMode && isCameraInPool();
  waterDepthTarget = inPool ? 1.1 : 0;

  camera.position.y += appliedWaterOffset;   // 先抵銷上一幀套用的下沉量

  waterDepthCurrent += (waterDepthTarget - waterDepthCurrent) * Math.min(WATER_SINK_LERP_SPEED * delta, 1.0);

  if (inPool) {
    waterBobStrength += (1.0 - waterBobStrength) * Math.min(3.0 * delta, 1.0);
  } else {
    waterBobStrength = 0;
  }
  const bobOffset = Math.sin(time * WATER_BOB_SPEED * Math.PI * 2) * WATER_BOB_AMPLITUDE * waterBobStrength;

  appliedWaterOffset = waterDepthCurrent + bobOffset;
  camera.position.y -= appliedWaterOffset;   // 套用新的下沉量，視線降低

  // ── 燈泡平滑 lerp ──
  if (Math.abs(currentBulbStrength - targetBulbStrength) > 0.001) {
    currentBulbStrength += (targetBulbStrength - currentBulbStrength)
      * Math.min(BULB_LERP_SPEED * delta, 1.0);
    applyBulbStrength(currentBulbStrength);
  }

  prevTime = time;
  composer.render();

  // ⚡ 除錯用：每 60 幀印一次完整的 draw calls / triangles，避免洗版
  if (!window._frameLogCounter) window._frameLogCounter = 0;
  window._frameLogCounter++;
  if (window._frameLogCounter % 60 === 0) {
    console.log('draw calls：', renderer.info.render.calls, '｜三角形數：', renderer.info.render.triangles);
  }
  renderer.info.reset();   // ← 讀完之後手動重置，準備算下一幀

  labelRenderer.render(scene, camera);
}
animate();

// ─────────────────────────────────────────
// 十、視窗調整
// ─────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  labelRenderer.setSize(w, h);
});

// ─────────────────────────────────────────
// 十一、手機觸控支援
// ─────────────────────────────────────────

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let isTouchMoving = false;
let isHoldWalking = false;
let holdTimer = null;

if (isMobile) {
  let lastTapTime = 0;
  let tapTimer = null;
  let touchStartX = 0, touchStartY = 0;
  let lastTouchX = 0, lastTouchY = 0;
  let isMobileLocked = false; // 模擬 PointerLock 的鎖定狀態

  const DOUBLE_TAP_MS = 300;   // 雙點間隔上限
  const MOVE_THRESHOLD = 8;    // 超過這個 px 就算滑動，不算點擊
  const TOUCH_SENSITIVITY = 0.003; // 視角靈敏度

  // ── 模擬鎖定狀態（手機不支援 PointerLock）──
  function mobileLock() {
    if (isMobileLocked) return;
    isMobileLocked = true;
    // 觸發 controls 的 lock 事件讓 UI 同步（隱藏滑桿）
    sliderWrap.style.opacity = '0';
    sliderWrap.style.pointerEvents = 'none';
  }

  function mobileUnlock() {
    if (!isMobileLocked) return;
    isMobileLocked = false;
    if (warningModal.style.display !== 'block' && !isXRayMode) {
      sliderWrap.style.opacity = '1';
      sliderWrap.style.pointerEvents = 'auto';
    }
  }

  // ── 複寫 controls.isLocked，讓原本邏輯正常運作 ──
  Object.defineProperty(controls, 'isLocked', {
    get: () => isMobileLocked,
    configurable: true,
  });

  // ── 視角旋轉（拖曳）──
  renderer.domElement.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;
    isTouchMoving = false;

    // ── 長按計時 ──
    holdTimer = setTimeout(() => {
      if (!isTouchMoving) isHoldWalking = true; // 沒有在滑動才啟動前進
    }, 300);
  }, { passive: true });

  renderer.domElement.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - lastTouchX;
    const dy = t.clientY - lastTouchY;
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;

    const totalDx = Math.abs(t.clientX - touchStartX);
    const totalDy = Math.abs(t.clientY - touchStartY);
    if (totalDx > MOVE_THRESHOLD || totalDy > MOVE_THRESHOLD) {
      isTouchMoving = true;
    }

    if (isMobileLocked) {
      // 水平 → 左右轉頭（yaw）
      camera.rotation.y -= dx * TOUCH_SENSITIVITY * 2;
      // 垂直 → 上下看（pitch），限制角度避免翻轉
      camera.rotation.x -= dy * TOUCH_SENSITIVITY * 2;
      camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, camera.rotation.x));
    }
  }, { passive: true });

  renderer.domElement.addEventListener('touchend', (e) => {
    // 長按停止
    clearTimeout(holdTimer);
    isHoldWalking = false;
    renderer.domElement._prevAvgY = null;

    if (isTouchMoving) return; // 滑動不算點擊

    const now = Date.now();
    const diff = now - lastTapTime;

    if (diff < DOUBLE_TAP_MS && diff > 0) {
      clearTimeout(tapTimer);
      lastTapTime = 0;
      mobileUnlock();
      openMenu();
    } else {
      lastTapTime = now;
      tapTimer = setTimeout(() => {
        if (menuPanel.style.display === 'flex') {
          closeMenu();
          mobileLock();
          return;
        }
        if (!isMobileLocked) {
          mobileLock();
          return;
        }
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const intersects = raycaster.intersectObjects(interactiveDevices);
        if (!intersects.length) return;
        const clickEvent = new MouseEvent('click', { bubbles: false });
        renderer.domElement.dispatchEvent(clickEvent);
      }, DOUBLE_TAP_MS);
    }
  }, { passive: true });

  // ── 移動（虛擬搖桿區域）──
  // 手指雙指觸控：兩指同時滑動 → 前後移動
  renderer.domElement.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2) return;
    // 雙指向上 → 前進，向下 → 後退
    const avgY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (!renderer.domElement._prevAvgY) {
      renderer.domElement._prevAvgY = avgY;
      return;
    }
    const dy = renderer.domElement._prevAvgY - avgY;
    renderer.domElement._prevAvgY = avgY;
    if (Math.abs(dy) > 1) {
      controls.moveForward(dy * 0.02);
    }
  }, { passive: true });

  renderer.domElement.addEventListener('touchcancel', () => {
    clearTimeout(holdTimer);
    isHoldWalking = false;
  }, { passive: true });
}