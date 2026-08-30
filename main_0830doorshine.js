import * as THREE from 'three';
window.THREE = THREE; // ← 新增這行，方便 console 除錯
// ⚡ 效能優化：three-mesh-bvh 讓 raycaster.intersectObjects() 對高面數的牆壁/地板
// 用 BVH（樹狀包圍盒）加速，取代逐三角形線性掃描。
// 需要先執行：npm install three-mesh-bvh
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
//import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CONFIG } from './scene-config.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import { getDatabase, ref, onValue, get, set, remove, update, increment } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDjEAOsrsDNzukTyacscnc6Bt71_2HVkXg",
  authDomain: "water-alert-system-79dfa.firebaseapp.com",
  databaseURL: "https://water-alert-system-79dfa-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "water-alert-system-79dfa",
};

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
// ★ 濾心用量是否要持久化存到 Firebase（跟 LINE_NOTIFY_ENABLED 分開，互不影響）：
// 設 false 時，濾心用量只會在本機記憶體裡暫時計算，重新整理頁面就會歸零重算；
// 設 true 才會真的讀取/寫入 Firebase，讓濾心壽命能跨 session、跨裝置持久累積。
// 之所以要獨立出來，是因為之前 LINE_NOTIFY_ENABLED 拿來測試「先關掉LINE通知」時，
// 會連帶把濾心的雲端存檔也一起關掉，兩件事其實沒有必然關聯，應該各自控制。
const FILTER_PERSIST_ENABLED = true;

// ─────────────────────────────────────────
// 一、全域變數
// ─────────────────────────────────────────
// ── 每次開啟網頁，產生獨立的 session ID，避免多人使用互相干擾 ──
const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);

let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let prevTime = performance.now() / 1000;
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

// ── 旋轉開門（swing door）方向如果不對，可在這裡指定特定門反方向開 ──
// 預設所有旋轉門都是往 -90 度方向開（原本寫死的行為）；
// 需要「從右邊打開」（往反方向開）的門，填 1 即可。
const SWING_SIGN_OVERRIDE = {
  'door_restroom_2': 1,
};

// ── 上掀式門（turn_up_door，繞 X 軸往上掀開 60 度）方向如果不對，可在這裡指定特定門反方向掀 ──
// 預設往上掀開的方向是 -1，若實際掀開後方向相反（往下掀），填 1 即可。
const TURN_UP_SIGN_OVERRIDE = {
  // 'turn_up_door_名稱': 1,
};
const TURN_UP_OPEN_ANGLE = THREE.MathUtils.degToRad(60); // 上掀式門開啟角度：60 度
// ⚡ 上掀式門預設繞「本地 X 軸」旋轉。如果在 Blender 裡移動 origin/pivot 後
// 物件的本地座標軸方向跟著跑掉（例如變成水平旋轉），可以在這裡指定該扇門
// 改繞 'y' 或 'z' 軸，不用回 Blender 重新調整就能先測試哪一軸才正確。
const TURN_UP_AXIS_OVERRIDE = {
  // 'turn_up_door_名稱': 'z',  // 例如這扇門實際要繞 Z 軸才對
};

// ── 連動門設定：同一組裡的門，點擊其中一扇會連帶開/關其他扇 ──
// 例如雙開大門，兩片門各自獨立的 mesh，但希望點任何一片都能一起開關。
const DOOR_GROUPS = [
  ['door_livingroom', 'door_livingroom_1'],
];
const DOOR_PARTNER_MAP = {};
DOOR_GROUPS.forEach(group => {
  group.forEach(name => {
    DOOR_PARTNER_MAP[name] = group.filter(n => n !== name);
  });
});

const cachedSceneMeshes = [];
const flowingPipes = new Map();
const outletObjects = {};   // faucet_outlet / faucet_2_outlet / shower_outlet / shower_2_outlet ...
const drainObjects = {};    // ⚡ 跟 outletObjects 同一套邏輯：drain 現在也只是純定位用的空物件（Plain Axes），不需要 mesh.material，因此比照outlet 放進「不限制型別」的第一遍 traverse 收集
const waterFlows = {};      // WaterFlow 實例，key 為完整裝置名稱
let isXRayMode = false;
let unlockFromButton = false;
let sceneRenderEnabled = false; // 黑幕蓋著時先不渲染 3D 場景，避免浪費算力跟葉子動畫搶執行緒時間

//碰撞宣告head
let collidableObjects = [];
// ⚡ collidableObjects / strictCollidableObjects 各自對應的世界座標包圍球清單
// （中心點+半徑），在 GLTF 載入完成後由 loader.load() 的 callback 填入，
// 供 checkCurrentCollision() / resolveCollisionSlide() 做「距離篩選」用，
// 詳見填入的地方的註解說明。
let collidableSpheres = [];
let strictCollidableSpheres = [];

let isNoclipMode = false;
let isStuckInWall = false;
let isMenuAction = false;

// ⚡ 透視模式（noclip）下「仍然需要碰撞」的例外名單。
// 一般牆壁/管路在透視模式下可以自由穿過方便觀察，
// 但這幾片外牆即使在透視模式下也要擋住玩家，避免走到半空中。
// 名稱請用「小寫」比對（跟 traverse 迴圈裡 name.toLowerCase() 對應）。
const STRICT_COLLISION_NAMES = new Set([
  'wall_outside_2',
  'tearoom_big_w_f_2_wall',
  'tearoom_big_w_2_wall',
  'balcony_big_w_f_2_wall',
  'balcony_big_w_2_wall',
]);
let strictCollidableObjects = [];
window.strictCollidableObjects = strictCollidableObjects; // ← 新增這行，方便 console 除錯

const rayDirections = [
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(1, 0, 0)
];
const collisionDistance = 0.5;
// ⚡ 碰撞偵測高度設定：原本只在「攝影機視線高度」打一條射線，
// 如果牆壁在該高度剛好是窗戶鏤空範圍就會直接穿過去。
// 這裡改成同時檢查多個相對高度（相對攝影機的 Y 偏移量），
// 只要其中任一高度偵測到碰撞就阻擋移動。可依實際窗戶位置調整這些數字。
// ⚡ 修正：原本用陣列索引 COLLISION_HEIGHT_OFFSETS[2] 去抓「膝蓋高度」，
// 一旦有人調整/精簡這個陣列的元素數量，索引位置就會跟著跑掉，
// 抓到 undefined，導致 raycaster 原點 y 座標變成 NaN，整組偵測射線失效
// （這正是刪掉陣列元素後矮牆能直接穿過去的真正原因）。
// 改成獨立命名常數，不再有任何隱藏的位置依賴。
const COLLISION_EYE_HEIGHT_OFFSET = 0;        // 視線高度，正中央偵測用
const COLLISION_LATERAL_HEIGHT_OFFSET = -1.1; // 膝蓋附近，左右肩寬偵測用

// 保留給 checkCurrentCollision() 用的高度清單（目前只用視線高度做正中央偵測，
// 膝蓋高度已經改用 COLLISION_LATERAL_HEIGHT_OFFSET 獨立處理左右肩寬點）
const COLLISION_HEIGHT_OFFSETS = [COLLISION_EYE_HEIGHT_OFFSET];
// ⚡ 人體半寬（公尺）：模型接縫處難免會有極小縫隙（例如牆與窗交接處），
// 單點射線剛好對齊縫隙時就會直接穿過去。與其針對「這個縫隙」的實際寬度
// 去調整偏移量（不同縫隙寬度不一致，treat 起來很脆弱），改用「一個人肩膀
// 大概多寬」這個通用值，在移動方向左右各開一個偵測點：只要縫隙比人窄，
// 左右兩點裡至少會有一個打中實心的牆，一律視為擋住；縫隙如果真的比人寬，
// 那本來就是合理可通過的開口，不應該擋。
const PLAYER_HALF_WIDTH = 0.2;
//碰撞宣告end

// ⚡ 新增：把碰撞偵測相關的常數掛到 window，方便之後在 console 直接讀取目前實際數值除錯，
// 不用每次都回頭翻程式碼確認 PLAYER_HALF_WIDTH / collisionDistance 現在設多少。
window.collisionDistance = collisionDistance;
window.COLLISION_HEIGHT_OFFSETS = COLLISION_HEIGHT_OFFSETS;
window.COLLISION_LATERAL_HEIGHT_OFFSET = COLLISION_LATERAL_HEIGHT_OFFSET;
window.PLAYER_HALF_WIDTH = PLAYER_HALF_WIDTH;

// ⚡ 效能優化：碰撞偵測每幀都會用到的暫存向量，全部重複使用、不再 new/clone()，
// 減少每幀產生大量暫時物件造成的 GC 壓力（對應 profiler 裡的 [unattributed] 時間）
const _tmpWorldDir = new THREE.Vector3();
const _tmpOrigin = new THREE.Vector3();
const _tmpMoveDir = new THREE.Vector3();
const _tmpHitNormal = new THREE.Vector3();
const _tmpLateral = new THREE.Vector3(); // ⚡ 新增：垂直於移動方向的水平向量，用來算左右偵測點

// ⚡ 樓梯移動方向計算專用：從 camera.quaternion 用正確的 'YXZ' 順序反推出
// 純水平朝向（yaw）。不能直接讀 camera.rotation.y —— 那是用 three.js
// Object3D 預設的 'XYZ' 順序分解出來的角度，跟 PointerLockControls
// 實際組合旋轉用的 'YXZ' 順序不一致，抬頭/低頭角度越大誤差越明顯，
// 甚至會讓算出來的水平移動方向趨近於零向量，導致「頭朝下走樓梯時
// 卡在樓梯底部，怎麼走都出不去」的 bug（詳見 updateStaircase()）。
const _stairYawEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _stairUpAxis = new THREE.Vector3(0, 1, 0);

/** 依目前模式回傳管路「非啟動」狀態的透明度 */
function getInactivePipeOpacity() {
  return isXRayMode ? 0.45 : 0.12;
};

/**
 * 切換單一管路的視覺狀態（改指派共用材質參照，而非各自修改 opacity）
 * @param {object} p flowingPipes.get() 取回的物件（含 mesh/colorType/isShared）
 * @param {'active'|'inactive'} state
 */
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
  'ceiling',
  'wall_inside_1',
  'wall_inside_2',
  'wall_inside_2_1',
  'wall_inside_2_2',
  'fwall_inside_2_3',
  'floor',
  'kitchen_carpet',
  'Cube082_1',
  'Cube082_2',
  'floor_2',
  'girl_carpet',
]);

// ── 旋轉樓梯設定 ──
const STAIRCASE = {
  center: new THREE.Vector3(10.65, 1.6, -5.78),
  radius: 1.0,          // 樓梯外緣半徑，用來判斷玩家是否靠近樓梯
  walkRadius: 0.6,       // ← 新增：玩家實際走的圓形路徑半徑，建議落在踏板中段，可自行微調
  totalHeight: 3.4,
  stepHeight: 0.2,
  turns: 1,
  radiusMargin: 0.4,
  climbSpeed: 1.0,        // ← 新增：沿樓梯自動移動的速度（公尺/秒），數字越大爬得越快
  // ⚡ 新增：真正入口的方位角（用 console 量到的 109.7° 換算成弧度），
  // 只有從這個角度附近靠近樓梯才會被吸進「軌道自走模式」，
  // 避免玩家從欄杆縫隙鑽進去，卻用錯誤角度反推出跟樓上出口對不上的軌道。
  //
  // ⚡ 拆成「樓下入口」跟「樓上入口」兩組獨立角度/容差：
  // 理論上 turns:1（轉一圈360度）代表樓上出口跟樓下入口的方位角
  // 應該完全相同，但實際3D模型裡樓上/樓下的牆面、走道、欄杆開口
  // 位置是各自單獨建模的，常會有些微誤差——同一個角度值對樓下剛好準，
  // 對樓上卻會偏差一點，導致「樓上要下樓時要橫移一小段才能進入」。
  // 拆開後可以各自微調到最順的角度，不用強迫共用同一個值。
  // 如果之後實測發現需要微調，可以在 updateStaircase() 開頭暫時加一行
  // console.log(THREE.MathUtils.radToDeg(Math.atan2(dz, dx))) 印出
  // 「玩家目前方位角」，站在樓上正對入口的位置量出實際角度，
  // 再填回 entranceAngleTop 即可。
  entranceAngle: THREE.MathUtils.degToRad(109.7),           // 樓下入口方位角
  entranceAngleTolerance: THREE.MathUtils.degToRad(50),     // 樓下入口角度容差
  entranceAngleTop: THREE.MathUtils.degToRad(25),        // 樓上入口方位角，暫時跟樓下共用同一值（詳見下方量測注意事項），待更精準量測後再調整
  entranceAngleToleranceTop: THREE.MathUtils.degToRad(50),  // 樓上入口角度容差，可獨立調整
};
window.STAIRCASE = STAIRCASE; // ⚡ 新增：掛到 window，方便在 console 直接讀取/除錯（例如量測入口角度）

// ⚡ 依玩家目前高度（在樓梯中點以上或以下），決定該用「樓上」還是
// 「樓下」那一組入口角度/容差。resolveStaircaseCylinderCollision() 跟
// updateStaircase() 的入口判定都改呼叫這個函式，確保兩處邏輯一致。
const STAIR_MID_Y = STAIRCASE.center.y + STAIRCASE.totalHeight / 2;
function getStairEntranceConfig(cameraY) {
  const isUpperApproach = cameraY > STAIR_MID_Y;
  return isUpperApproach
    ? { angle: STAIRCASE.entranceAngleTop, tolerance: STAIRCASE.entranceAngleToleranceTop }
    : { angle: STAIRCASE.entranceAngle, tolerance: STAIRCASE.entranceAngleTolerance };
}

let isOnStairRail = false;  // 是否正處於「樓梯軌道自走模式」
let stairHeight = 0;        // 目前在樓梯上的高度（0 ~ totalHeight）
let stairAngleOffset = 0;   // 進入樓梯當下的角度基準，讓軌道跟實際入口方位對齊
let stairEntryHeight = 0;   // ⚡ 新增：本次是從哪一端進入的（0=樓下，totalHeight=樓上），
                             // 給 getStairAngleAtHeight() 判斷該往哪個目標角度做修正

// ⚡ 修正「爬到樓梯另一端時，出口跟真正入口方位角對不上」的問題：
// 理論上 turns 圈數應該讓終點剛好落在另一端真正的入口角度上，但實際
// 3D模型的樓上/樓下開口是各自獨立建模的，跟 turns*360° 算出來的理論
// 角度會有落差（目前實測落差約 109.7°-25°=84.7°），導致爬到底時人
// 卡在原地，要偏一段角度才能真的走出欄杆開口。
// 解法：不直接用 turns 算出的「理論角度」當終點，而是依爬行進度
// （0=剛進入，1=走到底）線性地把角度從「理論值」修正到「另一端真正
// 的入口角度」——起點完全不變（不會有感的跳動），終點精準對齊真實
// 開口，跟 turns 值準不準完全無關，也不用重新量測、調整 turns。
function getStairAngleAtHeight(height) {
  const rawAngle = stairAngleOffset - (height / STAIRCASE.totalHeight) * (Math.PI * 2 * STAIRCASE.turns);

  // 這趟是從樓下(0)爬向樓上(totalHeight)，還是反過來？
  const enteredFromBottom = stairEntryHeight <= STAIRCASE.totalHeight / 2;
  const farHeight = enteredFromBottom ? STAIRCASE.totalHeight : 0;
  const farTargetAngle = enteredFromBottom ? STAIRCASE.entranceAngleTop : STAIRCASE.entranceAngle;

  // 理論公式在「終點」算出來的角度
  const rawFarAngle = stairAngleOffset - (farHeight / STAIRCASE.totalHeight) * (Math.PI * 2 * STAIRCASE.turns);

  // 終點需要修正多少角度，取最短路徑（避免繞一大圈跳動）
  const rawDelta = farTargetAngle - rawFarAngle;
  const delta = Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta)); // 正規化到 -π ~ π

  // 目前爬行進度：0=剛進入，1=走到底端
  const progress = Math.min(1, Math.abs(height - stairEntryHeight) / STAIRCASE.totalHeight);

  return rawAngle + delta * progress;
}
// ⚡ 新增：是否已經「真正踏上」樓梯（離開過入口那個邊界一小段距離），
// 用來區分「剛從入口走進來，還在往中心走」跟「已經爬過一段、現在回到
// 邊界想離開」這兩種情況——只有後者才套用下面寬鬆的90度離開容差，
// 避免剛進入樓梯的那一瞬間就被誤判成「想離開」而彈出去。
let stairCommitted = false;

// ⚡ 計算兩個角度之間的最短差值，結果落在 -PI ~ PI 之間
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ── 水池高低差設定 ──
const poolWaterMeshes = [];   // 收集 floor_pool_water 的 mesh
let poolBounds = null;        // 世界座标包围盒（THREE.Box3）

let waterDepthCurrent = 0;    // 目前下沉量（公尺）
let waterDepthTarget = 0;     // 目標下沉量（0 或 WATER_SINK_DEPTH）
const WATER_SINK_DEPTH = 1.1;        // 泡在水裡時穩定停留的下沉深度（公尺）
const WATER_SINK_LERP_SPEED = 6.0;   // 越小 → 沉浮越絲滑緩慢
const WATER_BOB_AMPLITUDE = 0.03;    // 水中上下漂浮幅度（公尺）
const WATER_BOB_SPEED = 0.5;         // 漂浮頻率
let waterBobStrength = 0;            // 漂浮強度淡入淡出用
let appliedWaterOffset = 0;          // 記錄上一幀實際套用在camera.y的偏移，方便下一幀先扣除再重算
let wasInPool = false;               // 上一幀是否在水池範圍內，用來偵測「剛進水」「剛出水」的瞬間
// ⚡ 入水/出水的一次性動作幅度，可依實際手感自行調整：
const WATER_ENTRY_OVERSHOOT = 0.4;   // 剛入水那一刻，比穩定深度多下沉的量（先下墜再浮起）數字越大 → 下墜越深）
const WATER_EXIT_JUMP = 0.5;        // 剛出水那一刻，比地面高度多躍起的量（先躍起再落地）數字越大 → 躍起越高
// ⚡ 這兩個是「回彈」速度，跟 WATER_SINK_LERP_SPEED 分開控制：
// 數字越小 → 下墜/躍起停留的時間越久、感覺越明顯；數字越大 → 回彈越快、感覺越輕微
const WATER_ENTRY_RECOVER_SPEED = 3.0;   // 下墜後浮回穩定深度的速度
const WATER_EXIT_RECOVER_SPEED = 4.0;    // 躍起後落回地面的速度

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
    coldPipes: ['pipe_main', 'pipe_kit', 'pipe_kit', 'pipe_kit_1', 'pipe_kit_faucet_2'],
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
    drainRadius: 0.18,
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
const SHARED_WASTE_PIPES = new Set(['pipe_main_w', 'pipe_kit_w', 'pipe_restroom_w']);

// ⚡ 效能優化：管路共用材質池
// 原本每根管路 mesh 都各自 new 一個獨立材質實例，即使顏色/透明度相同，
// three.js 仍會視為不同材質，導致每畫一根管路都要重新綁定一次 shader（setProgram）。
// 改成「同一種狀態只建立 1 份材質，所有符合條件的管路 mesh 共用同一個參照」，
// 這樣不管管路有幾十根，GPU 端只需要認得這 6 份材質，切換次數大幅下降。
function makePipeMat(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.FrontSide,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,   // ⚡ 新增：不受 renderer.toneMappingExposure 影響， 讓管路顏色/亮度固定，不會因為透視模式調暗環境而跟著變不清楚
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

// 出水中的管路改用疊加混合，做出「發光穿透」的效果；
// 未出水的 inactive 維持原本的 NormalBlending，看起來像隱約可見的管線輪廓
PIPE_MATERIALS.cold.active_shared.blending = THREE.AdditiveBlending;
PIPE_MATERIALS.cold.active_own.blending = THREE.AdditiveBlending;
PIPE_MATERIALS.drain.active_shared.blending = THREE.AdditiveBlending;
PIPE_MATERIALS.drain.active_own.blending = THREE.AdditiveBlending;

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
// 濾心壽命設定（濾心剩餘百分比 UI + 剩餘5%警告 + LINE通知）
// ─────────────────────────────────────────
// 只有這幾個「水龍頭」裝置需要顯示濾心，可自行增減
// （例如要幫蓮蓬頭也加濾心，就把 'restroom_shower' 加進來）
const FILTER_DEVICES = ['kit_faucet_1', 'kit_faucet_2', 'restroom_faucet', 'restroom_faucet_2'];
const FILTER_LIFETIME_HOURS = 2000;
const FILTER_LIFETIME_SECONDS = FILTER_LIFETIME_HOURS * 3600; // 7,200,000 秒
const FILTER_LOW_RATIO = 0.05; // 剩餘 5% 時跳警告 + LINE 通知
// ⚡ 效能考量：濾心壽命是以「小時」為單位變化的量，每秒只消耗
// 1 / 7,200,000 ≈ 0.000014% 的壽命，肉眼完全看不出差異。
// 完全不需要每一幀（animate() 每秒跑 60 次）都重算圓環或寫入 Firebase，
// 這裡拆成兩種節流頻率：
// 1. UI（圓環＋文字）：每 FILTER_UI_UPDATE_INTERVAL 秒才重算一次視覺，成本可忽略。
// 2. Firebase 寫入：每 FILTER_SAVE_INTERVAL 秒才寫入一次，
//    避免逐幀/逐秒寫入造成大量不必要的網路請求與 Firebase 讀寫額度消耗。
//    水龍頭真正關閉的那一刻，會額外補存一次，確保不會漏記。
//    ⚡ 這個定時存檔只在「裝置正在出水」的期間才會生效，不是整個網頁
//    生命週期都在跑，所以即使縮短間隔，成本依然可忽略。它存在的目的
//    是當作安全網：萬一使用者是在水還開著的狀態下直接關閉分頁/當機，
//    beforeunload 這種「離開前補存」的做法不保證能送出去，
//    真正可靠的保障是「每隔一段時間就先存一次」，這樣最多只會漏記
//    這個間隔的時間，不會漏記整段使用時間。原本設 20 秒，這裡縮短成
//    10 秒，把最大漏記時間再壓低一半，換來的網路請求量仍然微不足道。
const FILTER_UI_UPDATE_INTERVAL = 1.0;
const FILTER_SAVE_INTERVAL = 10.0;

// { [device]: { usedSeconds, isActive, uiElapsed, saveElapsed, alerted, ready } }
// usedSeconds 是「跨所有 session 累積」的用量，一定要存在 Firebase 裡，
// 不能像 activeTimers 那樣每次關水就重置——濾心壽命要記 2000 小時（約83天），
// 光靠網頁自己的變數，重新整理頁面或換裝置開網頁就會全部消失。
const filterState = {};
FILTER_DEVICES.forEach(name => {
  filterState[name] = {
    usedSeconds: 0,     // 顯示用：remoteTotal + pendingDelta 合計，給UI圓環讀取
    remoteTotal: 0,     // ⚡ 新增：從 Firebase 同步到的「已確定」總量
    pendingDelta: 0,    // ⚡ 新增：本機累積、還沒送出給 Firebase 的秒數
    isActive: false,
    uiElapsed: 0,
    saveElapsed: 0,
    alerted: false,
    ready: false,
  };
});

// ── 網頁載入時，只讀一次每個裝置目前累積用量（之後全部在本機累加，不會逐幀讀取）──
async function subscribeFilterUsage() {
  if (!FILTER_PERSIST_ENABLED) {
    FILTER_DEVICES.forEach(name => { filterState[name].ready = true; });
    return;
  }
  await authReadyPromise;
  FILTER_DEVICES.forEach(name => {
    const nodeRef = ref(db, `filters/${name}`);
    // ⚡ 持續監聽，不只是載入時讀一次：任何分頁/裝置寫入後，
    // 這裡都會自動收到最新的 remoteTotal，顯示才會即時同步。
    onValue(nodeRef, (snap) => {
      const data = snap.exists() ? snap.val() : null;
      const st = filterState[name];
      st.remoteTotal = data?.usedSeconds ?? 0;
      // 如果別的分頁已經觸發過低量警告，本機也同步跟上，避免各自各跳一次
      if (data?.alerted) st.alerted = true;
      st.usedSeconds = Math.min(st.remoteTotal + st.pendingDelta, FILTER_LIFETIME_SECONDS);
      st.ready = true;
      updateFilterUI(name);
    }, (err) => {
      console.warn(`[Filter] 監聽 ${name} 濾心用量失敗`, err);
      st.ready = true; // 監聽失敗也要放行，不然本機永遠卡在0不會開始計算
    });
  });
}
subscribeFilterUsage();

// ── 節流寫入：每 FILTER_SAVE_INTERVAL 秒 或 關閉水龍頭時才呼叫一次 ──
async function saveFilterUsage(device) {
  if (!FILTER_PERSIST_ENABLED) return;
  const st = filterState[device];
  const deltaToFlush = st.pendingDelta;
  if (deltaToFlush <= 0) return; // 沒有新增量就不用浪費一次網路請求

  try {
    // ⚡ 用 increment()：不管幾個分頁同時送出，Firebase 都會正確加總，不會互相覆蓋
    await update(ref(db, `filters/${device}`), {
      usedSeconds: increment(deltaToFlush),
      alerted: st.alerted,
      updatedAt: Date.now(),
    });
    // 只扣掉「這次成功送出的量」，如果 await 期間又累加了新的 delta，會留給下一次補送
    st.pendingDelta -= deltaToFlush;
  } catch (err) {
    console.warn(`[Filter] 寫入 ${device} 濾心用量失敗`, err);
    // 失敗時不清空 pendingDelta，保留下次繼續補送，不會漏記
  }
}

// ── 更換濾心後呼叫：重新計時並清除警告旗標 ──
function resetFilterUsage(device) {
  const st = filterState[device];
  // ⚡ 換濾心是「重設成0」，不是增量，這裡要用 set() 直接覆蓋整個節點才對，
  // 不能用 increment()（那是用來累加，不是用來清零的）。
  st.usedSeconds = 0;
  st.remoteTotal = 0;
  st.pendingDelta = 0;
  st.alerted = false;
  if (FILTER_PERSIST_ENABLED) {
    set(ref(db, `filters/${device}`), {
      usedSeconds: 0,
      alerted: false,
      updatedAt: Date.now(),
    }).catch(err => console.warn(`[Filter] 重設 ${device} 濾心失敗`, err));
  }
  updateFilterUI(device);
}

// ── 裝置開/關水時呼叫，切換該裝置是否正在累加濾心用量 ──
function setFilterActive(device, isActive) {
  if (!filterState[device]) return; // 這個裝置沒有配置濾心（例如馬桶、蓮蓬頭），直接跳過
  filterState[device].isActive = isActive;
  if (!isActive) {
    // 關閉的瞬間立刻補存一次，避免累積的用量還沒到 FILTER_SAVE_INTERVAL 就被中斷（例如關頁面）
    filterState[device].saveElapsed = 0;
    saveFilterUsage(device);
  }
  updateFilterUIVisibility();
}

// ─────────────────────────────────────────
// 二、水流粒子系統
// ─────────────────────────────────────────
class WaterFlow {
  constructor(scene, emitPosition, type = 'faucet') {
    this.scene = scene;
    this.emitPosition = emitPosition.clone();
    this.type = type;
    this.active = false;
    // ⚡ 效能優化：降低粒子數量，減少每幀更新成本
    this.count = type === 'shower' ? 150 : 80;  // 400→150, 200→80
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
    this.points.renderOrder = 10; // 同上，避免被牆壁的透明排序蓋過去
    // ⚡ 跟管路同樣道理，水流粒子也是 depthWrite:false 的半透明物件，
    // 給它跟管路一樣的高 renderOrder，避免在透視模式下被牆壁蓋過去。
    this.points.renderOrder = 10;
    // ⚡ 修正「站在蓮蓬頭下方看不到水滴動畫」的 bug：
    // geometry.boundingSphere 只在第一次渲染時算過一次，當時所有粒子
    // 還堆疊在出水口那一點，外接球極小。之後粒子雖然持續飄落擴散，
    // 但 boundingSphere 從未重新計算，Three.js 做 frustum culling 判斷時
    // 用的還是那顆貼著出水口的小球——如果攝影機站得很近（例如正下方），
    // 這顆小球很容易被誤判為落在視野/近裁切面之外，導致整組粒子系統
    // （包含早已飄遠、原本該看得到的水滴）整包被跳過不渲染。
    // 粒子數量不多（最多 400 個），直接關閉 frustum culling 讓它永遠渲染，
    // 效能成本可忽略，比每幀重算 boundingSphere 更簡單直接。
    this.points.frustumCulled = false;
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
    // ⚡ 效能優化：降低粒子數量
    this.count = 200;  // 500→200
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
    // ⚡ 跟 WaterFlow 出水口一樣的道理：boundingSphere 只算一次，之後粒子
    // 持續繞排水口旋轉擴散，攝影機靠太近時可能被誤判視野外整包不渲染，
    // 直接關閉 frustum culling 保險。
    this.points.frustumCulled = false;
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
// ⚡ 新增：套用起始朝向。lookAtPos 原本只是設定檔裡的死資料，沒有任何地方讀取它，
// 這裡補上 camera.lookAt()，讓進場那一刻的視角朝向真正對齊設定檔指定的目標點。
// 注意：PointerLockControls 是靠滑鼠即時改變 camera 朝向，玩家一移動滑鼠這個朝向就會被覆蓋，
// 所以這行只在「載入完畫面、玩家還沒動滑鼠」的那一瞬間有效果。
if (CONFIG.CAMERA.lookAtPos) {
  camera.lookAt(
    CONFIG.CAMERA.lookAtPos.x,
    CONFIG.CAMERA.lookAtPos.y,
    CONFIG.CAMERA.lookAtPos.z
  );
}
window.camera = camera; // ← 新增這一行

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  //logarithmicDepthBuffer: true // 環境太大，camera抓不出微小距離差異
});

renderer.debug.checkShaderErrors = false;//  關鍵優化：關閉 Shader 編譯時的錯誤檢查（避免 CPU/GPU 同步阻塞）

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth * 0.2, window.innerHeight * 0.2), // 解析度減半
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
// ⚡ 修正：原本只用攝影機中心單點判斷「是否卡牆」，跟 resolveCollisionSlide()
// 用的「肩寬+視線高度多點」標準不一致——牆的破口剛好只在某個高度、或剛好
// 偏一點肩寬位置時，單點容易誤判「沒卡住」，導致 isStuckInWall 太早解除，
// 切回一般模式後又立刻被夾住。這裡改成跟 resolveCollisionSlide() 同一套邏輯：
// 每個方向都檢查「視線高度中央」+「膝蓋高度左肩」+「膝蓋高度右肩」共 3 個點，
// 4 個方向 × 3 點＝12 條射線，只要任何一條打中 0.2m 內的東西，就視為還卡著。
function checkCurrentCollision() {
  // ⚡ 新增：切回一般模式時，除了檢查一般牆壁碰撞，也要檢查玩家目前
  // 是否位在樓梯的「除入口外禁止穿越」圓柱範圍內、且角度不在容許的
  // 入口範圍——這種情況下即使沒撞到任何牆壁 mesh，一般模式的
  // resolveStaircaseCylinderCollision() 還是會判定「撞到樓梯圓柱牆面」
  // 而持續把玩家推回去、動彈不得，但這個情況原本完全沒被本函式涵蓋到，
  // 導致 isStuckInWall 誤判成 false，玩家實際上仍然卡住。
  if (!isOnStairRail) {
    const yLow = STAIRCASE.center.y - 0.3;
    const yHigh = STAIRCASE.center.y + STAIRCASE_COLLISION_HEIGHT;
    if (camera.position.y >= yLow && camera.position.y <= yHigh) {
      const dx = camera.position.x - STAIRCASE.center.x;
      const dz = camera.position.z - STAIRCASE.center.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= STAIRCASE.radius) {
        const approachAngle = Math.atan2(dz, dx);
        // ⚡ 改用 getStairEntranceConfig()：跟另外兩處入口角度判定
        // （resolveStaircaseCylinderCollision / updateStaircase）用同一套
        // 「依高度分樓上/樓下」設定，三處保持一致。
        const { angle: entranceAngleForHeight, tolerance: entranceToleranceForHeight } =
          getStairEntranceConfig(camera.position.y);
        const diffFromEntrance = Math.abs(angleDiff(approachAngle, entranceAngleForHeight));
        if (diffFromEntrance > entranceToleranceForHeight) {
          return true; // 卡在樓梯圓柱範圍內、且不是從入口角度進來，視為卡住
        }
      }
    }
  }

  if (collidableObjects.length === 0) return false;
  // ⚡ 效能優化：先篩出附近的牆壁，這個frame內的所有射線檢測共用同一份，
  // 不用每個方向、每個偏移點都重新篩一次。
  const nearby = getNearbyCollidables(collidableObjects, collidableSpheres);
  for (const dir of rayDirections) {
    _tmpWorldDir.copy(dir).applyQuaternion(camera.quaternion).normalize();

    _tmpOrigin.copy(camera.position);
    _tmpOrigin.y += COLLISION_EYE_HEIGHT_OFFSET;
    raycaster.set(_tmpOrigin, _tmpWorldDir);
    let intersects = raycaster.intersectObjects(nearby);
    if (intersects.length > 0 && intersects[0].distance < 0.2) return true;

    _tmpLateral.set(-_tmpWorldDir.z, 0, _tmpWorldDir.x).normalize();
    for (const lateralOffset of [-PLAYER_HALF_WIDTH, PLAYER_HALF_WIDTH]) {
      _tmpOrigin.copy(camera.position);
      _tmpOrigin.y += COLLISION_LATERAL_HEIGHT_OFFSET;
      _tmpOrigin.x += _tmpLateral.x * lateralOffset;
      _tmpOrigin.z += _tmpLateral.z * lateralOffset;
      raycaster.set(_tmpOrigin, _tmpWorldDir);
      intersects = raycaster.intersectObjects(nearby);
      if (intersects.length > 0 && intersects[0].distance < 0.2) return true;
    }
  }
  return false;
}

/**
 * 共用的碰撞判斷：在「膝蓋附近高度」（COLLISION_LATERAL_HEIGHT_OFFSET，
 * 即 COLLISION_HEIGHT_OFFSETS 三個高度裡最下面那個）左右各開一個肩寬偵測點，
 * 再加上「視線高度」（COLLISION_HEIGHT_OFFSETS[0]）正中央一條偵測線，
 * 共 3 條射線。這組偵測點打射線，若擋到就修改 moveVelocity（沿牆滑動）。
 * 一般模式跟透視模式都呼叫這個函式，只差在傳入的物件清單不同，
 * 確保「偵測點邏輯」永遠只有一套，不會分岔成兩份。
 *
 * ⚠️ 取捨提醒（歷史紀錄，2 次來回）：
 * 1. 一開始只有單高度（視線高度），發現牆壁在該高度剛好是窗戶鏤空範圍時會穿牆，
 *    改成 COLLISION_HEIGHT_OFFSETS 三高度 × 左右 2 點＝6 條射線。
 * 2. 之後又試過精簡回「只用膝蓋高度」，但實測發現有些牆體的破口剛好只存在於
 *    膝蓋這個高度（視線/腰部高度反而是實心的），單一高度會漏掉這種情況，
 *    於是還原回三高度版本，用效能換取正確性。
 * 3.（目前這版）再次改回只用膝蓋高度左右 2 點。如果之後又發現某處牆能走過去，
 *    很可能是第 2 點提到的舊 bug 重新出現——把下面 `yOffset` 那行換回
 *    `for (const yOffset of COLLISION_HEIGHT_OFFSETS) {` 即可還原成三高度版本。
 */
// ⚡ 轉角穿牆修正：同一幀內最多迭代幾次「偵測→沿牆滑動修正」。
// 舊版只修正一次就直接套用 moveVelocity，若修正後的滑行方向剛好指向
// 交界處的另一面牆，那面牆完全沒被檢查到，久而久之（連續幾幀之後）
// 就會被推穿過去。迭代版本會在同一幀內把「修正後的新方向」重新拿去
// 檢測其他牆面，直到不再碰撞或迭代次數用完為止。
const MAX_SLIDE_ITERATIONS = 3;

// ⚡ 效能優化：距離篩選，只挑出玩家「附近」的牆壁 mesh 給後面的射線檢測用，
// 不用每一幀都對整棟房子的牆壁打射線。用「兩點距離」這種很便宜的算術
// 先做初步篩選，比對每一片牆都打射線便宜非常多。
//
// NEARBY_COLLISION_RADIUS：篩選半徑（公尺）。這個數字要比「房間對角線
// 最大長度」大一些，確保玩家站在房間任何角落，該房間所有牆壁都還在
// 篩選範圍內，不會漏檢查；但也不能設太大，否則篩選效果不明顯。
// 如果之後發現「明明看得到牆卻穿過去」，優先檢查是不是這個半徑設太小。
const NEARBY_COLLISION_RADIUS = 8;
// 篩選時用「兩點距離 <= NEARBY_COLLISION_RADIUS + 該牆包圍球半徑」判斷，
// 等同於用平方距離比較（避免每次呼叫 Math.sqrt，更省效能）：
// distSq <= (NEARBY_COLLISION_RADIUS + sphere.radius)^2
const _nearbyFilterResult = []; // ⚡ 重複使用同一個陣列，避免每次篩選都 new 一個新陣列

/**
 * 從 sourceObjects（+ 對應的 sourceSpheres 包圍球清單）裡，篩選出
 * 距離玩家目前位置 NEARBY_COLLISION_RADIUS 公尺內的 mesh，回傳
 * （重複使用的）陣列，供 raycaster.intersectObjects() 使用。
 * sourceObjects 跟 sourceSpheres 必須是一一對應、長度相同的兩個陣列
 * （分別對應 collidableObjects/collidableSpheres 或
 * strictCollidableObjects/strictCollidableSpheres）。
 */
function getNearbyCollidables(sourceObjects, sourceSpheres) {
  _nearbyFilterResult.length = 0;
  for (let i = 0; i < sourceObjects.length; i++) {
    const sphere = sourceSpheres[i];
    if (!sphere) continue; // 保險：包圍球清單還沒建好時（理論上不會發生）就跳過
    const dx = sphere.center.x - camera.position.x;
    const dy = sphere.center.y - camera.position.y;
    const dz = sphere.center.z - camera.position.z;
    const maxDist = NEARBY_COLLISION_RADIUS + sphere.radius;
    if (dx * dx + dy * dy + dz * dz <= maxDist * maxDist) {
      _nearbyFilterResult.push(sourceObjects[i]);
    }
  }
  return _nearbyFilterResult;
}

function resolveCollisionSlide(moveVelocity, targetObjects, targetSpheres) {
  if (targetObjects.length === 0 || (moveVelocity.x === 0 && moveVelocity.z === 0)) return;

  // 保留一份原始輸入方向，如果下面疊代用完仍卡住（被夾在轉角/夾縫），
  // 用這份原始值算「退回」的方向，而不是把速度歸零讓人卡死不動。
  const originalX = moveVelocity.x;
  const originalZ = moveVelocity.z;

  // ⚡ 效能優化：先篩出附近的牆壁，這一次呼叫（最多 MAX_SLIDE_ITERATIONS 輪
  // 疊代）都共用同一份篩選結果，不用每輪疊代都重新篩一次。
  const nearby = getNearbyCollidables(targetObjects, targetSpheres);
  if (nearby.length === 0) return;

  for (let iter = 0; iter < MAX_SLIDE_ITERATIONS; iter++) {
    if (moveVelocity.x === 0 && moveVelocity.z === 0) return;

    // 原本：moveVelocity.clone().normalize() 每次都會 new 一個 Vector3
    _tmpMoveDir.copy(moveVelocity).normalize();
    // 垂直於移動方向的水平向量（把移動方向繞 Y 軸轉 90 度），用來算左右肩偵測點
    _tmpLateral.set(-_tmpMoveDir.z, 0, _tmpMoveDir.x);

    let closestHit = null;

    // ⚡ 膝蓋附近高度（COLLISION_LATERAL_HEIGHT_OFFSET）左右各開一個肩寬偵測點，
    // 共 2 條射線（原本是 3 個高度 × 左右 2 點＝6 條）。
    for (const lateralOffset of [-PLAYER_HALF_WIDTH, PLAYER_HALF_WIDTH]) {
      // 原本：camera.position.clone() 每個偵測點都會 new 一個 Vector3
      _tmpOrigin.copy(camera.position);
      _tmpOrigin.y += COLLISION_LATERAL_HEIGHT_OFFSET;
      _tmpOrigin.x += _tmpLateral.x * lateralOffset;
      _tmpOrigin.z += _tmpLateral.z * lateralOffset;
      raycaster.set(_tmpOrigin, _tmpMoveDir);
      const intersects = raycaster.intersectObjects(nearby);
      if (intersects.length > 0 && intersects[0].distance < collisionDistance) {
        if (!closestHit || intersects[0].distance < closestHit.distance) {
          closestHit = intersects[0];
        }
      }
    }

    // ⚡ 左右兩點都在膝蓋高度，如果牆壁的破口（窗戶鏤空等）剛好只在
    // 膝蓋高度、視線高度反而是實心的，左右兩點會一起漏掉。這裡在正中央
    // （不做左右偏移）額外補一條「視線高度」（COLLISION_EYE_HEIGHT_OFFSET，
    // 偏移量 0）的偵測線，補到左右兩點中間、視線高度這個位置。
    _tmpOrigin.copy(camera.position);
    _tmpOrigin.y += COLLISION_EYE_HEIGHT_OFFSET; // ← 改用獨立常數，不再靠索引 0
    raycaster.set(_tmpOrigin, _tmpMoveDir);
    const centerIntersects = raycaster.intersectObjects(nearby);
    if (centerIntersects.length > 0 && centerIntersects[0].distance < collisionDistance) {
      if (!closestHit || centerIntersects[0].distance < closestHit.distance) {
        closestHit = centerIntersects[0];
      }
    }

    // 這一輪沒撞到任何東西了 → 修正完成，收工
    if (!closestHit) return;

    // 原本：closestHit.face.normal.clone()
    _tmpHitNormal.copy(closestHit.face.normal);
    _tmpHitNormal.applyQuaternion(closestHit.object.quaternion);
    _tmpHitNormal.y = 0;
    _tmpHitNormal.normalize();

    const dotProduct = moveVelocity.dot(_tmpHitNormal);
    // 只有「還在朝牆面移動」時才需要扣掉法線分量；
    // 如果已經是平行/背離牆面，這一面牆已經處理完了，換下一輪檢查其他牆面。
    if (dotProduct < 0) {
      moveVelocity.sub(_tmpHitNormal.multiplyScalar(dotProduct));
    }
  }

  // 迭代次數用完仍持續碰撞：通常代表被夾在兩面牆（或牆+樓梯）的轉角/接縫處，
  // 殘留的滑動速度很可能同時朝著兩個面推擠。比起直接歸零讓玩家卡死不動，
  // 這裡改成直接往「原始輸入方向的反方向」退回——符合直覺：走不過去就退回，
  // 不用等待、也不會放行穿牆。退回的速度大小跟原本想走的速度一致，
  // 下一幀會重新正常碰撞判斷（退回方向通常已經離開夾角，不會連續退回卡死）。
  moveVelocity.x = -originalX;
  moveVelocity.z = -originalZ;
}

// ⚡ 樓梯「除入口外禁止穿越」的虛擬圓柱碰撞
// 樓梯欄杆是一根根分開的直桿，中間有空隙，raycaster 沿著射線方向偵測時
// 很容易剛好從縫隙間穿過去，導致玩家從入口以外的角度直接走進/穿越樓梯。
// 這裡不依賴 mesh 碰撞，而是用「玩家與樓梯中心的水平距離 + 角度」直接判斷，
// 只要不是從 STAIRCASE.entranceAngle 附近進來，且高度落在樓梯範圍內，
// 一律視為撞到牆，沿圓柱表面滑動，徹底杜絕縫隙穿越的問題。
const STAIRCASE_COLLISION_HEIGHT = 5.5; // 由樓梯底部（center.y）往上算，需要阻擋的高度範圍（公尺）

function resolveStaircaseCylinderCollision(moveVelocity) {
  if (isOnStairRail) return; // 已經在軌道自走模式，不需要這層額外碰撞
  if (moveVelocity.x === 0 && moveVelocity.z === 0) return;

  // 高度範圍檢查：只在樓梯本體高度區間內生效（一樓到往上 2.5m）
  const yLow = STAIRCASE.center.y - 0.3;   // 留一點餘裕，避免樓梯正下方誤判
  const yHigh = STAIRCASE.center.y + STAIRCASE_COLLISION_HEIGHT;
  if (camera.position.y < yLow || camera.position.y > yHigh) return;

  const curDx = camera.position.x - STAIRCASE.center.x;
  const curDz = camera.position.z - STAIRCASE.center.z;
  const curDist = Math.sqrt(curDx * curDx + curDz * curDz);

  // 玩家目前已經在圓柱範圍內（例如正走在樓梯本體上）就不需要這層碰撞，
  // 交給既有的樓梯 mesh / 軌道系統處理，避免互相干擾。
  // ⚡ 曾經試過把這個半徑放大成 STAIRCASE.radius + STAIRCASE.radiusMargin，
  // 想跟 updateStaircase() 的「直接放行進入軌道」判定範圍對齊，
  // 但這樣會讓樓梯圓柱碰撞的判定圈跟樓梯欄杆/牆面的一般碰撞範圍重疊，
  // 兩套碰撞系統（這裡的切線滑動 vs. resolveCollisionSlide 的牆壁推擠）
  // 互相頂住，導致完全卡死、動彈不得，比原本「要橫移才能下樓」更嚴重。
  // 因此改回原本的 STAIRCASE.radius，只在下面放寬角度容許度來解決
  // 「容易被擋、要橫移一段才能下樓」的問題，不再更動碰撞邊界位置。
  if (curDist <= STAIRCASE.radius) return;

  const nextDx = (camera.position.x + moveVelocity.x) - STAIRCASE.center.x;
  const nextDz = (camera.position.z + moveVelocity.z) - STAIRCASE.center.z;
  const nextDist = Math.sqrt(nextDx * nextDx + nextDz * nextDz);

  // 下一步不會進入圓柱範圍，不需要阻擋
  if (nextDist > STAIRCASE.radius) return;

  // 檢查是否從真正入口角度靠近；是的話放行，讓 updateStaircase() 接手判斷
  // ⚡ 改用 getStairEntranceConfig()：樓上/樓下各自用獨立的入口角度與容差，
  // 不再共用同一組，避免「理論上該對齊、實際模型有誤差」造成的偏移問題。
  const approachAngle = Math.atan2(curDz, curDx);
  const { angle: entranceAngleForHeight, tolerance: entranceToleranceForHeight } =
    getStairEntranceConfig(camera.position.y);
  const diffFromEntrance = Math.abs(angleDiff(approachAngle, entranceAngleForHeight));
  if (diffFromEntrance <= entranceToleranceForHeight) return;

  // 非入口角度 → 視為撞到圓柱牆面，沿切線方向滑動（法向量＝由中心指向玩家）
  const nx = curDx / curDist;
  const nz = curDz / curDist;
  const dot = moveVelocity.x * nx + moveVelocity.z * nz;
  if (dot < 0) {
    moveVelocity.x -= dot * nx;
    moveVelocity.z -= dot * nz;
  }
}

function handleMovementAndCollision(moveVelocity) {
  // ⚡ 效能優化：如果沒有移動速度，直接跳過碰撞檢測
  if (moveVelocity.lengthSq() < 0.000001) {
    return;
  }

  if (isNoclipMode) {
    resolveCollisionSlide(moveVelocity, strictCollidableObjects, strictCollidableSpheres);
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

  for (let i = 0; i < MAX_SLIDE_ITERATIONS; i++) {
    const beforeX = moveVelocity.x;
    const beforeZ = moveVelocity.z;
    resolveCollisionSlide(moveVelocity, collidableObjects, collidableSpheres);
    resolveStaircaseCylinderCollision(moveVelocity);
    if (moveVelocity.x === beforeX && moveVelocity.z === beforeZ) break;
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
  // colorType: 'cold'（藍色冷水管）或 'drain'（橘色排水管）
  // 初始狀態一律是「未啟動」，套用共用的 inactive 材質參照
  mesh.material = PIPE_MATERIALS[colorType].inactive;

  // ⚡ 管路是細長條狀 geometry，Three.js 用來做 frustum culling 判斷的
  // geometry.boundingSphere 對這種形狀特別容易算不準，導致轉動視角時
  // 明明部分管子還在畫面裡，卻被誤判成整條在視野外而消失。
  // 管路數量不多，直接關閉 frustum culling，效能成本可忽略。
  mesh.frustumCulled = false;

  // ⚡ 修正「管路在透視模式下忽隱忽現」的根本原因：透視模式開啟時
  // cachedSceneMeshes（牆/地板/家具）全部被設成 transparent + depthWrite:false，
  // 跟管路一起加入同一組半透明排序競賽，物件一多排序就容易算錯，
  // 導致管路被牆壁的排序結果蓋過去。給管路明確更高的 renderOrder，
  // 保證一律排在牆壁之後繪製，不再依賴容易出錯的距離排序。
  mesh.renderOrder = 10;
}

//樓梯每幀更新高度的函式
function updateStaircase(delta) {
  // ⚡ 透視模式（noclip）下，樓梯軌道系統維持正常運作，
  // 避免在二樓透視模式下走上樓梯後浮在半空中。
  // if (isNoclipMode) { isOnStairRail = false; return; }

  const dx = camera.position.x - STAIRCASE.center.x;
  const dz = camera.position.z - STAIRCASE.center.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (!isOnStairRail && dist <= STAIRCASE.radius + STAIRCASE.radiusMargin) {
    const entryAngle = Math.atan2(dz, dx);

    // ⚡ 新增：只有靠近角度落在「真正入口」附近（entranceAngle ± tolerance）
    // 才允許進入軌道自走模式，避免從欄杆縫隙鑽入時用錯誤角度反推出
    // 跟樓上出口對不上的軌道基準，導致上樓後卡在欄杆裡走不出去。
    // ⚡ 改用 getStairEntranceConfig()：跟 resolveStaircaseCylinderCollision()
    // 用同一套「依高度分樓上/樓下」的角度與容差，兩處判定才會一致。
    const { angle: entranceAngleForHeight, tolerance: entranceToleranceForHeight } =
      getStairEntranceConfig(camera.position.y);
    const diffFromEntrance = Math.abs(angleDiff(entryAngle, entranceAngleForHeight));

    if (diffFromEntrance <= entranceToleranceForHeight) {
      isOnStairRail = true;
      stairCommitted = false; // ⚡ 每次重新進入樓梯，都要重新累積「真正踏上樓梯」的判定
      stairHeight = (camera.position.y > STAIRCASE.center.y + STAIRCASE.totalHeight / 2)
        ? STAIRCASE.totalHeight
        : 0;
      stairEntryHeight = stairHeight; // ⚡ 記錄這次是從哪一端進入，供 getStairAngleAtHeight() 判斷修正方向
      // 反向旋转公式：角度 = offset - 比例*2π*turns
      stairAngleOffset = entryAngle + (stairHeight / STAIRCASE.totalHeight) * (Math.PI * 2 * STAIRCASE.turns);
    }
  }

  if (!isOnStairRail) return;

  // ── 依「摄影机面向 + WASD 意图」算出世界座标移动方向，而非死板的 W=上 S=下 ──
  const inputZ = Number(moveForward) - Number(moveBackward);
  const inputX = Number(moveRight) - Number(moveLeft);
  let inputDir = 0;
  let outwardAmount = 0; // ⚡ 新增：玩家移動方向裡「朝樓梯中心以外走」的分量，見下方放行條件說明

  if (inputZ !== 0 || inputX !== 0) {
    const localDir = new THREE.Vector3(inputX, 0, -inputZ).normalize(); // ← 加负号

    // ⚡ 修正「頭朝下走樓梯會卡在底部出不去」的 bug：
    // 原本直接用 camera.quaternion（含 pitch 上下仰角）去轉換移動方向，
    // 頭朝下時 camera 前方向量幾乎垂直朝下，水平分量趨近於 0，
    // 強制 worldDir.y=0 後再 normalize()，方向資訊消失或變得極不穩定，
    // 導致 inputDir 算不出來、stairHeight 卡住不動、isOnStairRail
    // 一直是 true，玩家被鎖在樓梯圓形軌道上出不去。
    // 改成用 'YXZ' 順序（跟 PointerLockControls 內部一致）從
    // camera.quaternion 反推出純水平朝向（yaw），再用這個 yaw 去旋轉
    // localDir。這樣不管玩家頭抬多高、低多低，算出來的水平移動方向
    // 永遠穩定、正確，不受視角俯仰角度干擾。
    _stairYawEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    const worldDir = localDir.applyAxisAngle(_stairUpAxis, _stairYawEuler.y);
    worldDir.y = 0; // 理論上必為0，保留只是保險
    worldDir.normalize();

    const angleNow = getStairAngleAtHeight(stairHeight); // ⚡ 改用有終點修正的版本，避免離開判斷用到錯誤的理論角度
    const tangentUp = new THREE.Vector3(Math.sin(angleNow), 0, -Math.cos(angleNow));

    inputDir = worldDir.dot(tangentUp);

    // ⚡ 修正「靠樓梯邊緣持續平滑滑到底部卻出不去」的 bug：
    // 原本到頂/到底要放行離開，只看 inputDir（跟當下螺旋切線方向的內積）
    // 正負號對不對——但切線方向會隨高度/角度不斷旋轉，玩家在底部那個瞬間
    // 實際按的方向不一定剛好對齊當下切線，內積可能接近0或正負號不對，
    // 導致卡在原地出不去，非得刻意轉個特定角度才能觸發離開。
    // 這裡額外算一個「玩家移動方向」跟「樓梯中心指向玩家的徑向方向」的
    // 內積：只要玩家移動方向落在「正對外」左右各90度內就算通過，
    // 概念上跟進入樓梯時用的角度容差是同一招，只是換成用在離開判斷上
    // （實際套用邏輯見下方 stairCommitted 三元判斷）。
    const outDx = camera.position.x - STAIRCASE.center.x;
    const outDz = camera.position.z - STAIRCASE.center.z;
    const outLen = Math.hypot(outDx, outDz) || 1;
    outwardAmount = worldDir.x * (outDx / outLen) + worldDir.z * (outDz / outLen);
  }

  stairHeight += inputDir * STAIRCASE.climbSpeed * delta;

  // ⚡ 一旦離開過入口邊界一小段距離，代表玩家已經「真正踏上」樓梯，
  // 之後回到邊界時就可以套用寬鬆的離開容差，不用再等剛進入的那一瞬間。
  const STAIR_COMMIT_MARGIN = 0.15; // 公尺，離開邊界超過這個距離才算「真正踏上」
  if (stairHeight > STAIR_COMMIT_MARGIN && stairHeight < STAIRCASE.totalHeight - STAIR_COMMIT_MARGIN) {
    stairCommitted = true;
  }

  // ⚡ 離開樓梯的角度容差：outwardAmount 是玩家移動方向跟「樓梯中心指向玩家」
  // 徑向方向的內積（-1~1），outwardAmount > 0 代表移動方向落在「正對外」
  // 左右各90度的半圓範圍內（cos(90°)=0），跟入口用的角度容差是同一種概念，
  // 只是這裡直接用90度全開。只有 stairCommitted 為 true（已經真正踏上過
  // 樓梯）才套用這個寬鬆判斷，避免剛進入樓梯、還在往中心走的那一瞬間
  // 就被誤判成「想離開」而彈出去——那個階段仍然只看 inputDir 的正負號。
  const canLeaveTop = stairCommitted ? outwardAmount > 0 : inputDir > 0;
  const canLeaveBottom = stairCommitted ? outwardAmount > 0 : inputDir < 0;

  if (stairHeight >= STAIRCASE.totalHeight && canLeaveTop) {
    stairHeight = STAIRCASE.totalHeight;
    isOnStairRail = false;
    return;
  }
  if (stairHeight <= 0 && canLeaveBottom) {
    stairHeight = 0;
    isOnStairRail = false;
    return;
  }
  stairHeight = Math.max(0, Math.min(STAIRCASE.totalHeight, stairHeight));

  const angle = getStairAngleAtHeight(stairHeight); // ⚡ 改用有終點修正的版本，爬到底時會精準對齊另一端真正的入口角度
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
instructions.style.display = 'none'; // ← 新增：下載/載入階段先強制隱藏，避免太早出現

// ⚡ 兩個條件都成立才顯示點擊提示：載入動畫完成 + 首頁遮罩已關閉。
// 不用輪詢，只在「任一條件剛好達成」的那一刻檢查一次，成本可忽略。
function finishLoading() {
  loadingScreen.classList.add('fade-out');

  setTimeout(() => {
    document.body.appendChild(instructions);
    loadingScreen.style.display = 'none';
    instructions.style.display = ''; // ← 新增：解除隱藏，恢復成 CSS 原本的顯示方式
    instructions.classList.add('at-corner');

    composer.render();
    labelRenderer.render(scene, camera);

    setTimeout(showTapPrompt, 5); // 150 → 50
  }, 300); // 600 → 300（前提：不小於 CSS .fade-out 的轉場秒數）
}

manager.onLoad = finishLoading;

// ⚡ 回傳一條三次貝茲曲線的 4 個控制點，描述葉子從畫面外飄入到定點(0,0)的路徑。
// P0=起點(畫面外) → P1、P2=控制點(決定S型彎曲的方向與幅度) → P3=終點(0,0，也就是最終定點)
function computeLeafEntry() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const distance = Math.max(w, h) * 0.42 + 140;

  const angleDeg = -150 + Math.random() * 120;
  const rad = angleDeg * Math.PI / 180;

  const p0x = Math.cos(rad) * distance;
  const p0y = Math.sin(rad) * distance;
  const p3x = 0;
  const p3y = 0;

  // 垂直於「起點→終點」方向的單位向量，用來把控制點往兩側推，做出彎曲弧度
  const mag = Math.hypot(p0x, p0y) || 1;
  const perpX = -p0y / mag;
  const perpY = p0x / mag;

  // 兩個控制點分別往垂直方向的「相反側」偏移，是形成 S 型（而非單純弧形）的關鍵：
  // P1 靠近起點附近先往一側彎，P2 靠近終點附近往另一側彎回來
  const swayMagnitude = mag * 0.32;

  const p1x = p0x * 0.66 + perpX * swayMagnitude;
  const p1y = p0y * 0.66 + perpY * swayMagnitude;

  const p2x = p0x * 0.28 - perpX * swayMagnitude * 0.8;
  const p2y = p0y * 0.28 - perpY * swayMagnitude * 0.8;

  return { p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y };
}

// ⚡ 三次貝茲曲線公式：給定 4 個控制點與進度 t(0~1)，算出當下座標
function cubicBezier(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return (
    mt * mt * mt * p0 +
    3 * mt * mt * t * p1 +
    3 * mt * t * t * p2 +
    t * t * t * p3
  );
}

let leafFlightRafId = null; // 保存目前執行中的 rAF id，方便中途取消（例如快速重複點擊觸發時）

function animateLeafFlight(points, duration) {
  if (leafFlightRafId !== null) {
    cancelAnimationFrame(leafFlightRafId);
    leafFlightRafId = null;
  }

  const { p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y } = points;
  const start = performance.now();
  const SCALE_START = 1.6;
  const SCALE_END = 0.34;

  let rippleTriggered = false; // ⚡ 新增：這次飛行水波紋是否已提早觸發過
  const RIPPLE_TRIGGER_RATIO = 0.85; // ⚡ 新增：飛行進度到這個比例(0~1)就提早播水波紋，數字越小越早出現

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function frame(now) {
    const elapsed = now - start;
    const rawT = Math.min(elapsed / duration, 1);

    // ⚡ 偵測幀間隔：放在 rawT 計算完成之後才能讀取它，
    // 且要放在所有後面的動畫邏輯「之前」，確保卡頓當下就能立刻記錄到
    if (frame._lastNow) {
      const gap = now - frame._lastNow;
      if (gap > 30) {
        console.warn('[葉子動畫] 幀間隔異常：', gap.toFixed(1), 'ms，發生在 rawT=', rawT.toFixed(2));
      }
    }
    frame._lastNow = now;


    const t = easeInOutCubic(rawT);

    const x = cubicBezier(t, p0x, p1x, p2x, p3x);
    const y = cubicBezier(t, p0y, p1y, p2y, p3y);
    leafStage.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;

    // ⚡ 縮放也在同一個迴圈、用同一個 t 計算，跟位移完全同步，
    // 不再依賴獨立的 CSS animation 時間軸，徹底消除步調不一致造成的卡頓感
    const scale = SCALE_START + (SCALE_END - SCALE_START) * t;
    const opacity = rawT < 0.08 ? rawT / 0.08 : 1; // 前 8% 時間淡入，跟原本邏輯一致
    tapPromptLeaf.style.transform = `scale(${scale.toFixed(3)})`;
    tapPromptLeaf.style.opacity = opacity.toFixed(2);

    // ⚡ 新增：提早觸發水波紋，不用等到葉子真正落地(rawT===1)
    if (!rippleTriggered && rawT >= RIPPLE_TRIGGER_RATIO) {
      rippleTriggered = true;
      tapPromptRipple.classList.add('rippling');
    }

    if (rawT < 1) {
      leafFlightRafId = requestAnimationFrame(frame);
    } else {
      leafStage.style.transform = 'translate(0px, 0px)';
      tapPromptLeaf.style.opacity = '1';
      leafFlightRafId = null;

      // ⚡ 不再用 CSS class 切換動畫，改成直接接續呼叫 JS 晃動函式，
      // 用同一個 SCALE_END 數值，角度從 0 開始漸變，不會再有跳動/尺寸彈回的問題
      startLeafSway(SCALE_END);

      tapPromptWelcome.style.opacity = '0';
      tapPromptText.style.opacity = '1';
      fadeOutBlackCover();
    }
  }

  leafFlightRafId = requestAnimationFrame(frame);
}

let leafSwayRafId = null;

function startLeafSway(baseScale) {
  if (leafSwayRafId !== null) {
    cancelAnimationFrame(leafSwayRafId);
    leafSwayRafId = null;
  }

  const start = performance.now();
  const duration = 2600; // 對應原本 tapLeafSway 的 2.6s 一輪週期

  function frame(now) {
    const elapsed = (now - start) % duration;
    const phase = (elapsed / duration) * Math.PI * 2; // 0~2π，一個完整循環

    const rotateDeg = Math.sin(phase) * 4;      // -4deg ~ 4deg
    const translateXpx = Math.sin(phase) * 2;   // -2px ~ 2px

    tapPromptLeaf.style.transform =
      `scale(${baseScale}) rotate(${rotateDeg.toFixed(2)}deg) translateX(${translateXpx.toFixed(2)}px)`;

    leafSwayRafId = requestAnimationFrame(frame);
  }

  leafSwayRafId = requestAnimationFrame(frame);
}

function stopLeafSway() {
  if (leafSwayRafId !== null) {
    cancelAnimationFrame(leafSwayRafId);
    leafSwayRafId = null;
  }
}

const tapPrompt = document.createElement('div');
Object.assign(tapPrompt.style, {
  position: 'fixed',
  left: '50%',   // ⚡ 固定用百分比置中，resize 時瀏覽器原生重算，不觸發 transition、零延遲
  top: '50%',
  transform: 'translate(-50%, -50%)',
  display: 'none',
  flexDirection: 'column',
  alignItems: 'center',
  zIndex: '400',
  pointerEvents: 'none',
  opacity: '0',
  transition: 'opacity 0.4s ease',
});

// ⚡ 「該回家了吧！」：葉子開始下降時淡入顯示，持續留到使用者點擊畫面才一起消失
const tapPromptWelcome = document.createElement('div');
tapPromptWelcome.textContent = '該回家了吧 ！';
Object.assign(tapPromptWelcome.style, {
  marginBottom: '18px',
  color: 'white',
  fontSize: '32px',
  fontWeight: 'bold',
  letterSpacing: '8px',
  textShadow: '0 2px 12px rgba(0,0,0,0.85)',
  opacity: '0',
  transition: 'opacity 3.5s ease-out', // 修改：ease → linear
});
tapPrompt.appendChild(tapPromptWelcome);

const leafStage = document.createElement('div');
Object.assign(leafStage.style, {
  position: 'relative',
  width: '90px',
  height: '90px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

const tapPromptLeaf = document.createElement('div');
tapPromptLeaf.textContent = '🌿';
tapPromptLeaf.className = 'tap-prompt-leaf';
leafStage.appendChild(tapPromptLeaf);

const tapPromptRipple = document.createElement('div');
tapPromptRipple.className = 'tap-prompt-ripple';
leafStage.appendChild(tapPromptRipple);

tapPrompt.appendChild(leafStage);

const tapPromptText = document.createElement('div');
tapPromptText.textContent = '點擊畫面開始';
Object.assign(tapPromptText.style, {
  marginTop: '14px',
  color: 'white',
  fontSize: '20px',
  fontWeight: 'bold',
  letterSpacing: '4px',
  textShadow: '0 2px 8px rgba(0,0,0,0.8)',
  background: 'rgba(0,0,0,0.35)',
  padding: '10px 24px',
  borderRadius: '30px',
  opacity: '0',
  transition: 'opacity 1.2s ease',
});
tapPrompt.appendChild(tapPromptText);

document.body.appendChild(tapPrompt);

// ── 點擊提示：葉片「只掉落一次」→ 落地後才開始輕微持續晃動 + 正圓水波紋 ──
const tapPromptStyleTag = document.createElement('style');
tapPromptStyleTag.textContent = `
/* 掉落階段：從正中央、大尺寸、透明，垂直墜落並縮小到最小，只播一次
   （用 JS 控制 animation-iteration-count，不寫 infinite） */
/* 縮放（留在葉片自己身上，不含位移） */
@keyframes tapLeafFall {
  0%   { transform: scale(1.6); opacity: 0; }
  8%   { transform: scale(1.6); opacity: 1; }
  100% { transform: scale(0.34); opacity: 1; }
}

@keyframes tapRippleExpand {
  0%   { opacity: 0.55; transform: translate(-50%, -50%) scale(0.2); }
  100% { opacity: 0;    transform: translate(-50%, -50%) scale(1.6); }
}

.tap-prompt-leaf {
  font-size: 100px;
  line-height: 1;
  transform-origin: center center;
  filter: drop-shadow(0 4px 6px rgba(0,0,0,0.4));
  opacity: 0;
}

.tap-prompt-ripple {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%); /* ⚡ 修正：用 top+left 50% 搭配 translate(-50%,-50%)，才是真正的正中心 */
  width: 60px;
  height: 60px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.8);
  background: radial-gradient(circle, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0) 70%);
  opacity: 0;
}
/* 只有落地後才加上這個 class，水波紋只播放一次（原本 infinite） */
.tap-prompt-ripple.rippling {
  animation: tapRippleExpand 1.2s ease-out forwards;
  animation-iteration-count: 1;
}
`;
document.head.appendChild(tapPromptStyleTag);

const LEAF_FLIGHT_DURATION = 2400; // 毫秒，需跟 CSS 裡 tapLeafFall 的秒數一致（2.4s）

let leafEntryDelayTimeoutId = null; // 用來追蹤延遲啟動的葉子動畫，方便中途取消

function showTapPrompt() {
  stopLeafSway();
  if (leafFlightRafId !== null) {
    cancelAnimationFrame(leafFlightRafId);
    leafFlightRafId = null;
  }
  if (leafEntryDelayTimeoutId !== null) {
    clearTimeout(leafEntryDelayTimeoutId);
    leafEntryDelayTimeoutId = null;
  }

  tapPromptRipple.classList.remove('rippling');
  tapPromptText.style.opacity = '0';
  tapPromptWelcome.style.opacity = '0';
  tapPromptLeaf.style.opacity = '0';

  tapPrompt.style.display = 'flex';

  // 確保外層與文字都是完全透明
  tapPrompt.style.opacity = '1';
  tapPromptWelcome.style.opacity = '0';

  // 強制瀏覽器先套用 opacity: 0（觸發 reflow）
  void tapPromptWelcome.offsetWidth;

  // 下一幀才開始文字淡入
  requestAnimationFrame(() => {
    tapPromptWelcome.style.opacity = '1';
  });

  leafEntryDelayTimeoutId = setTimeout(() => {
    const points = computeLeafEntry();
    leafStage.style.transform = `translate(${points.p0x.toFixed(1)}px, ${points.p0y.toFixed(1)}px)`;
    void leafStage.offsetWidth;
    animateLeafFlight(points, LEAF_FLIGHT_DURATION);
    leafEntryDelayTimeoutId = null;
  }, 500);
}

function hideTapPrompt() {
  tapPrompt.style.opacity = '0';
  if (leafEntryDelayTimeoutId !== null) {
    clearTimeout(leafEntryDelayTimeoutId); // ⚡ 避免使用者提早點擊時，延遲的葉子動畫還被觸發
    leafEntryDelayTimeoutId = null;
  }
  setTimeout(() => {
    tapPrompt.style.display = 'none';
    tapPromptRipple.classList.remove('rippling');
    if (leafFlightRafId !== null) {
      cancelAnimationFrame(leafFlightRafId);
      leafFlightRafId = null;
    }
    stopLeafSway();
    leafStage.style.transform = 'translate(0px, 0px)';
    tapPromptWelcome.style.opacity = '0';
  }, 400);
}

// ── 全黑遮罩：載入完成後持續蓋住畫面，直到使用者點擊才從十字標中心向外揭露 ──
// ── 全黑遮罩：載入完成後持續蓋住畫面，直到使用者點擊才整體淡出消失 ──
// ── 全黑遮罩：載入完成、葉片開始掉落時蓋住畫面，
//    葉片落地（縮到最小）的那一刻才整體淡出消失 ──
const blackCover = document.createElement('div');
Object.assign(blackCover.style, {
  position: 'fixed',
  inset: '0',
  background: '#000',
  zIndex: '150',
  pointerEvents: 'none',
  opacity: '1',
  transition: 'opacity 0.9s ease-out', // ⚡ ease → ease-out：一開始就明顯變化，沒有前段停滯感
});
document.body.appendChild(blackCover);

let blackCoverFaded = false;

function fadeOutBlackCover() {
  if (blackCoverFaded) return;
  blackCoverFaded = true;
  sceneRenderEnabled = true; // ⚡ 開始淡出的同時，恢復場景渲染
  blackCover.style.opacity = '0';
  blackCover.addEventListener('transitionend', () => {
    blackCover.remove();
  }, { once: true });
}
manager.onProgress = (url, loaded, total) => {
  const percent = (loaded / total) * 100;
  const bar = document.getElementById('loader-bar');
  const percentText = document.getElementById('loader-percent');

  if (bar) bar.style.width = percent + '%';
  if (percentText) percentText.textContent = `${Math.round(percent)}%`;
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
    const name = obj.name.toLowerCase();
    // ⚡ 名稱含 "sliding_up_door" 的門視為「往上滑動」的滑門
    const isUpSlidingDoor = name.includes('sliding_up_door');
    // ⚡ 名稱含 "turn_up_door" 的門視為「往上掀開」的門（繞 X 軸旋轉 60 度）
    const isTurnUpDoor = name.includes('turn_up_door');

    if (isTurnUpDoor) {
      // 避免同一個名稱被重複登記（例如父物件跟唯一的子 mesh 剛好同名）
      if (doorAnimations[name]) return;

      doorAnimations[name] = {
        mesh: obj,
        isOpen: false,
        progress: 0,
        direction: 0,
        type: 'turn_up',
        turnUpSign: TURN_UP_SIGN_OVERRIDE[name] ?? -1, // 預設往上掀開方向，可用 override 反轉
        turnUpAxis: TURN_UP_AXIS_OVERRIDE[name] ?? 'z', // 預設繞 X 軸，可用 override 改成 y 或 z
        baseRotationX: obj.rotation.x, // 記錄關閉時原本角度，避免絕對覆蓋造成角度錯亂
        baseRotationY: obj.rotation.y,
        baseRotationZ: obj.rotation.z,
      };

      obj.traverse((child) => {
        if (child.isMesh) doorObjects.push(child);
      });
      return;
    }

    if (!name.includes('sliding_door') && !isUpSlidingDoor) return;
    // 避免同一個名稱被重複登記（例如父物件跟唯一的子 mesh 剛好同名）
    if (doorAnimations[name]) return;

    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);

    const DOOR_OPEN_MARGIN = 0.1;
    // 往上滑動的門固定用 Y 軸，不套用原本 X/Z 自動判斷邏輯
    const slideAxis = isUpSlidingDoor
      ? 'y'
      : (SLIDE_AXIS_OVERRIDE[name] ?? (size.x >= size.z ? 'x' : 'z'));
    const slideDistance = isUpSlidingDoor
      ? Math.max(0, size.y - DOOR_OPEN_MARGIN)
      : Math.max(0, (slideAxis === 'z' ? size.z : size.x) - DOOR_OPEN_MARGIN);
    // 往上滑動預設方向是 +Y（往上開），一般滑門預設是 -1；都可用 SLIDE_SIGN_OVERRIDE 覆寫
    const slideSign = SLIDE_SIGN_OVERRIDE[name] ?? (isUpSlidingDoor ? 1 : -1);

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
      startY: obj.position.y,
    };

    obj.traverse((child) => {
      if (child.isMesh) doorObjects.push(child);
    });
  });

  // ── 第一遍：收集 outlet / drain 空物件（純定位用，統一同一套邏輯）──
  gltf.scene.traverse((obj) => {
    const name = obj.name.toLowerCase();
    if (Object.values(PIPE_CONFIG).some(cfg => cfg.outletKey === name)) {
      outletObjects[name] = obj;
    }
    if (Object.values(PIPE_CONFIG).some(cfg => cfg.drainKey === name)) {
      drainObjects[name] = obj;
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
    // ⚡ 新增：有些物件在 Blender 有多材質，匯出後會拆成
    // 「Group（保留原名字）+ 子 Mesh（名字變成 Cube082_1 這種跟原名無關）」，
    // 子 mesh 自己的 name 比對不到時，退回去看父層 Group 的名字。
    const parentName = (mesh.parent && mesh.parent.name) ? mesh.parent.name.toLowerCase() : '';

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
    if ((AO_BAKE_TARGETS.has(name) || AO_BAKE_TARGETS.has(parentName)) && mesh.material) {

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

    // ⚡ 修正「室內地板亮度會隨太陽方向移動」的問題：
    // 不用 Shadow Map（要另外算陰影貼圖，成本較高），改用幾乎零成本的做法——
    // 直接把地板材質換成不受任何光源影響的 MeshBasicMaterial（無光照材質）。
    // MeshBasicMaterial 完全不吃 Light 的方向/角度計算，畫面亮暗改由
    // renderer.toneMappingExposure 決定（這個值在 applyDayNight() 裡已經
    // 跟著 elevRatio 一起變化），地板仍會隨時段整體變亮變暗，但不會再因為
    // 太陽移動角度而在地板表面上出現不合理的「跑位」效果。
    // 放在 AO 貼圖套用區塊之後，確保 aoMap 已經掛載到 mesh.material 上，
    // 這裡才能把它一起帶到新的材質裡，貼圖效果不會消失。
    if (name === 'floor' || name === 'floor_2') {
      const old = mesh.material;
      mesh.material = new THREE.MeshBasicMaterial({
        map: old.map ?? null,
        color: old.color ? old.color.clone() : new THREE.Color(0xffffff),
        aoMap: old.aoMap ?? null,
        aoMapIntensity: old.aoMapIntensity ?? 1,
        transparent: old.transparent,
        opacity: old.opacity,
      });
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
        // ⚡ 效能優化：原本依長度動態產生 3~N 顆 PointLight，
        // 改成每顆燈條「固定只 1 顆」，亮度稍微提高補足視覺效果，
        // 大幅減少場景總光源數（每顆燈條可省下 2~4 顆光源）
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
        const BALL_BULB_OVERRIDES = {
          // 範例：門廊那顆燈調暗
          'livingroom_rec_bulb_1': { emissiveIntensity: 5, lightIntensity: 1.5, lightDistance: 5, glowOpacity: 0.35, glowScaleFactor: 5 },
        };
        // ── 球型燈泡 ──
        const ov = BALL_BULB_OVERRIDES[name] ?? {};
        const emissiveIntensity = ov.emissiveIntensity ?? 12;
        const lightIntensity = ov.lightIntensity ?? 4.0;
        const lightDistance = ov.lightDistance ?? 8.0;
        const glowOpacity = ov.glowOpacity ?? 0.85;
        const glowScaleFactor = ov.glowScaleFactor ?? 9;

        if (mesh.material) {
          mesh.material.emissive = new THREE.Color(0xffcc88);
          mesh.material.emissiveIntensity = emissiveIntensity;
          if (mesh.material.map) mesh.material.color.setHex(0x888866);
        }

        mesh.geometry.computeBoundingBox();
        const localBox = mesh.geometry.boundingBox;
        const localSize = new THREE.Vector3();
        localBox.getSize(localSize);
        const localCenterGeo = new THREE.Vector3();
        localBox.getCenter(localCenterGeo);

        const baseRadius = Math.max(localSize.x, localSize.y, localSize.z) * 0.5;

        const pt = new THREE.PointLight(0xffcc88, lightIntensity, lightDistance, 2);
        pt.position.copy(localCenterGeo);
        mesh.add(pt);

        const glowTexture = getRadialGlowTexture();
        const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTexture,
          color: 0xffcc88,
          transparent: true,
          opacity: glowOpacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }));

        const glowScale = baseRadius * glowScaleFactor;
        glowSprite.scale.set(glowScale, glowScale, 1);
        glowSprite.position.copy(localCenterGeo);
        glowSprite.userData.isBallBulbGlow = true;
        glowSprite.material.userData._baseOpacity = glowOpacity;
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
        // ⚡ 效能優化：可拿掉真實 SpotLight，只保留視覺用的錐體光柱（emissive + cone）。
        // 一般燈泡數量通常最多，真實光源省下最多。如果之後覺得地面/牆面暗，
        // 可以只挑幾顆「重點燈泡」（例如玄關、樓梯口）手動加回 SpotLight。
        const spot = new THREE.SpotLight(0xffaa44, 3, 5, Math.PI / 3.5, 0.6, 2);
        mesh.add(spot);
        mesh.add(spot.target);
        spot.target.position.set(0, -10, 0);
      }
    }

    // ✅ 設備識別
    if (PIPE_CONFIG[name]) {
      interactiveDevices.push(mesh);
      activeTimers[name] = { startTime: null, alerted: false, repeatMode: false };
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
        isShared: SHARED_WASTE_PIPES.has(name),
      });
    }

    // 碰撞
    // ⚡ 排除 floor_pool_water：這片水面本身只是視覺/觸發用的地板，不該當成「牆壁」納入水平碰撞。
    // 入水後攝影機會下沉，COLLISION_HEIGHT_OFFSETS 的某個高度很容易剛好跟水面同高，
    // 造成水平射線跟這片水平薄片幾乎共平面而誤判成撞到牆，這就是「上不了岸」的根本原因。
    //
    // ⚡ 新增：有些物件在 Blender 有多個材質，匯出成 glTF 後會被拆成
    // 「Group（保留原本物件名字）+ 底下子 Mesh（名字被自動改成 Cube082_1 這種、跟 wall/floor 等關鍵字無關）」，
    // 這時子 mesh 自己的 name 比對不到，要往上看 parent 的名字才抓得到。
    const nameForCollision = (name.includes('wall') || name.includes('floor') || name.includes('door') || name.includes('stairs'))
      ? name
      : parentName;

    if (nameForCollision !== 'floor_pool_water' &&
      (nameForCollision.includes('wall') || nameForCollision.includes('floor') || nameForCollision.includes('door') || nameForCollision.includes('stairs'))) {
      collidableObjects.push(mesh);
      if (mesh.geometry && !mesh.geometry.boundsTree) {
        mesh.geometry.computeBoundsTree();
      }
    }
    if (STRICT_COLLISION_NAMES.has(name) || STRICT_COLLISION_NAMES.has(parentName)) {
      strictCollidableObjects.push(mesh);
      if (mesh.geometry && !mesh.geometry.boundsTree) {
        mesh.geometry.computeBoundsTree();
      }
    }

    // traverse 裡收集門
    // traverse 裡的門收集邏輯，取代原本的區塊
    // ⚡ 如果這個名稱已經被上面的滑門/上掀門邏輯登記過（sliding_door / sliding_up_door / turn_up_door），
    // 就不要再被這裡的「door_」規則覆蓋成旋轉門
    if (name.includes('door_') && !doorAnimations[name]) {
      doorObjects.push(mesh);
      doorAnimations[name] = {
        mesh,
        isOpen: false,
        progress: 0,
        direction: 0,
        type: 'swing',          // ← 原本旋轉門也標記類型，方便 animate() 判斷
        swingSign: SWING_SIGN_OVERRIDE[name] ?? -1,  // ⚡ 開門方向，預設 -1，例外門用 1
        baseRotationY: mesh.rotation.y,  // ⚡ 記錄門原本（關閉時）的角度，避免絕對覆蓋造成角度錯亂
      };
    }

    // drain 識別已搬到第一遍 traverse（drainObjects），這裡不需要了
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

  // ⚡ 效能優化：碰撞偵測（checkCurrentCollision / resolveCollisionSlide）
  // 原本每一幀都要對「整棟房子」的 collidableObjects / strictCollidableObjects
  // 逐一打射線檢查，不管玩家人在哪個房間，客廳、樓上的牆壁也都要陪著一起
  // 檢查，房子越大、牆越多，成本越高（Performance 面板量到光是碰撞相關的
  // raycasting 就佔了整體 scripting 時間一大塊）。
  // 這裡在牆壁清單建立完成後，預先算好每片牆的「世界座標包圍球」
  // （中心點 + 半徑），只需要算一次，之後每一幀就能用「兩點距離」這種
  // 非常便宜的算術，先篩掉離玩家很遠、不可能撞到的牆，再拿篩選後的
  // 小清單去做真正昂貴的射線檢測，大幅降低每幀要檢查的物件數量。
  const collidableSpheresResult = collidableObjects.map(mesh => {
    const box = new THREE.Box3().setFromObject(mesh);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    return sphere;
  });
  const strictCollidableSpheresResult = strictCollidableObjects.map(mesh => {
    const box = new THREE.Box3().setFromObject(mesh);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    return sphere;
  });
  // 賦值給模組層級變數（宣告在檔案上方，跟 collidableObjects 放一起），
  // 這樣 checkCurrentCollision() / resolveCollisionSlide() 才讀得到。
  collidableSpheres = collidableSpheresResult;
  strictCollidableSpheres = strictCollidableSpheresResult;

  // ✅ 建立水流
  interactiveDevices.forEach(mesh => {
    _createWaterFlow(mesh.name.toLowerCase());
  });

  // ✅ 建立排水漩渦粒子（drain 現在統一比照 outlet，是純定位用的空物件）
  Object.values(PIPE_CONFIG).forEach(cfg => {
    const anchor = drainObjects[cfg.drainKey];
    if (!anchor) {
      console.warn(`[Drain] 找不到 ${cfg.drainKey} 對應的空物件，排水粒子建立失敗`);
      return;
    }
    const worldPos = new THREE.Vector3();
    anchor.getWorldPosition(worldPos);
    const drainRadius = cfg.drainRadius ?? (cfg.type === 'shower' ? 0.6 : 0.2);
    drainFlows[cfg.drainKey] = new DrainFlow(scene, worldPos, drainRadius);
  });

  // ✅ 把濾心卡片掛到對應裝置的正上方（一定要在這裡才做，
  // 因為要等 outletObjects / interactiveDevices 都填好之後才能定位）
  attachFilterCardsToScene();

  // ✅ 把開關靠近提示（魚形）也掛到對應裝置上，原因跟上面濾心卡片一樣：
  // 一定要等 interactiveDevices 填好之後才能找到掛載點。
  attachSwitchHintsToScene();

  // ✅ 把客廳門靠近提示也掛上去，原因相同：一定要等 doorAnimations
  // 填好之後才能找到對應的 mesh。
  attachDoorHintsToScene();
});

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
//控制太陽出現
const SHOW_SUN_MESH = false;
sunMesh.visible = SHOW_SUN_MESH;

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

// ── ⏳ 透視模式切換提示（三點輪流跳動）──
const xrayTransitionStyleTag = document.createElement('style');
xrayTransitionStyleTag.textContent = `
  #xray-transition-overlay {
    position: fixed;
    inset: 0;
    z-index: 999999;
    display: none;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  #xray-transition-overlay.show {
    display: flex;
  }
  .xray-transition-dots {
    display: flex;
    gap: 10px;
  }
  .xray-transition-dots span {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #4facfe;
    box-shadow: 0 0 10px rgba(79, 172, 254, 0.9);
    opacity: 0.25;
    animation: xray-dot-blink 1.2s infinite ease-in-out;
  }
  .xray-transition-dots span:nth-child(1) { animation-delay: 0s; }
  .xray-transition-dots span:nth-child(2) { animation-delay: 0.2s; }
  .xray-transition-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes xray-dot-blink {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
    40%           { opacity: 1;    transform: scale(1.15); }
  }
`;
document.head.appendChild(xrayTransitionStyleTag);

const xrayTransitionOverlay = document.createElement('div');
xrayTransitionOverlay.id = 'xray-transition-overlay';
xrayTransitionOverlay.innerHTML = `
  <div class="xray-transition-dots"><span></span><span></span><span></span></div>
`;
document.body.appendChild(xrayTransitionOverlay);

function showXrayTransition() {
  xrayTransitionOverlay.classList.add('show');
}
function hideXrayTransition() {
  xrayTransitionOverlay.classList.remove('show');
}

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

  // ⚡ 先顯示三點動畫（跟原本文字改變的時機點一致：選單還開著）
  showXrayTransition();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toggleXRayMode(isXRayMode);
      hideXrayTransition();

      // ⚡ 跟原本順序一致：toggleXRayMode 跑完，選單才關閉
      menuPanel.style.display = 'none';

      // ⚡ 修正：透過 xrayBtn 關閉選單時，之前漏了清掉「離開遊戲」按鈕的 show class，
      // 導致進過透視模式後，離開遊戲按鈕會卡住一直顯示
      const exitBtn = document.getElementById('exit-btn');
      if (exitBtn) exitBtn.classList.remove('show');

      setTimeout(() => {
        unlockFromButton = false;
        controls.lock();
      }, 80);
    });
  });
};
menuPanel.appendChild(xrayBtn);

// ── 面板開關函式 ──
function openMenu() {
  if (controls.isLocked) controls.unlock();
  menuPanel.style.display = 'flex';

  // ⚡ 神之手面板開啟時，一併顯示「離開遊戲」按鈕
  const exitBtn = document.getElementById('exit-btn');
  if (exitBtn) exitBtn.classList.add('show');
}

function closeMenu() {
  unlockFromButton = true;
  menuPanel.style.display = 'none';
  setTimeout(() => {
    unlockFromButton = false;
    controls.lock();
  }, 80);

  // ⚡ 面板關閉時，一併隱藏「離開遊戲」按鈕
  const exitBtn = document.getElementById('exit-btn');
  if (exitBtn) exitBtn.classList.remove('show');
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

    // ⚡ 覆寫成透視模式專用的偏暗數值，不受 DEFAULT_DAY_VALUE 對應的曝光/環境光影響
    renderer.toneMappingExposure = XRAY_TONE_EXPOSURE;
    const ambLight = scene.children.find(o => o.isAmbientLight);
    if (ambLight) ambLight.intensity = XRAY_AMBIENT_INTENSITY;

    sliderWrap.style.opacity = '0';
    sliderWrap.style.pointerEvents = 'none';
  } else {
    if (daySliderValueBeforeXRay !== null) {
      daySlider.value = daySliderValueBeforeXRay;
      applyDayNight(parseFloat(daySliderValueBeforeXRay));   // 這裡會重新算出正確的曝光/環境光，不用額外還原
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
    sunMesh.visible = SHOW_SUN_MESH; // ⚡ 改成尊重開關，不再強制顯示
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
      // ⚡ 效能優化：emissiveIntensity 只是 uniform，不需要 needsUpdate（不影響 shader 編譯）
      // mesh.material.needsUpdate = true;
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
    // ⚡ 效能優化：opacity/transparent/depthWrite 都不影響 shader 編譯，
    // 不需要 needsUpdate。這行原本會逼 three.js 對場景「每一個」物件材質
    // 重跑一次 getProgram/getProgramParameter 驗證，是造成長時間凍結的主因。
    // mat.needsUpdate = true;
  });

  // ── 管路：inactive 材質是共用的，只需改這 2 份材質的 opacity，
  //     就能同時影響所有「未啟動」的管路 mesh，不用再逐一迴圈 ──
  PIPE_MATERIALS.cold.inactive.opacity = enable ? 0.6 : 0.12;
  PIPE_MATERIALS.drain.inactive.opacity = enable ? 0.6 : 0.12;
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

  // ⚡ 修正bug：只重置「這個裝置自己」的計時器，不要牽動其他裝置。
  // 原本用 for...in 迴圈把目前所有還在出水的裝置的計時器一起重置、
  // alerted 旗標也一起清空，導致其他本來還沒到警告時間的裝置，
  // 被迫跟這次確認的裝置同步重新倒數。結果只要有多個裝置同時在出水，
  // 隨便確認一個警告，就會把全部裝置的下一次警告時間洗牌成同一時刻，
  // 造成「只點了一個水龍頭，卻跳出所有裝置的警告，而且反覆跳出」的現象。
  if (activeTimers[deviceName]) {
    if (activeTimers[deviceName].startTime) activeTimers[deviceName].startTime = Date.now();
    activeTimers[deviceName].alerted = false;
    // ⚡ 使用者已經看過第一次警告了，之後改用比較長的重複提醒間隔
    // （WARNING_REPEAT_MS，預設10分鐘），不用再每60秒就吵一次。
    activeTimers[deviceName].repeatMode = true;
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
      setPipeState(p, 'inactive');
    }
  });

  waterFlows[deviceName]?.setActive(false);
  drainFlows[cfg.drainKey]?.setActive(false);
  setFilterActive(deviceName, false);

  if (activeTimers[deviceName]) {
    activeTimers[deviceName].startTime = null;
    activeTimers[deviceName].alerted = false;
    activeTimers[deviceName].repeatMode = false; // 關水後重置，下次重新開水從第一次的60秒門檻開始算
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

// ─────────────────────────────────────────
// 濾心壽命 UI（跟著水龍頭在3D場景裡的位置走，顯示在裝置正上方）
// ─────────────────────────────────────────
// ⚡ 展開動畫時間：只做「縮放展開＋淡入」，不做跳起/拉伸效果。
const FILTER_CARD_SHOW_MS = 320;
// ⚡ 卡片相對於水龍頭出水口的垂直偏移量（3D世界座標，單位：公尺）。
// 數字越大，卡片浮得越高；如果實際看起來卡片沒有剛好在裝置正上方，
// 調這個數字即可，不用動其他邏輯。
const FILTER_CARD_HEIGHT_OFFSET = 0.2;
// ⚡ 兩張卡片視覺上重疊時，避讓後至少要保留的間距（螢幕像素）
const FILTER_CARD_GAP = 14;

const filterUICards = {}; // { [device]: { wrapper, offsetWrapper, root, cssObject, fg, percentText, hourLine, hideTimer } }
const RING_RADIUS = 26;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
// ── 圓環五色分區設定：0~100 對應「已使用百分比」，數字越大代表濾心越接近該換 ──
// ⚡ 恢復5段：0~25藍、25~50綠、50~75黃、75~90橘、90~100紅。
// 分區數量恢復，跟「單色提醒」邏輯不衝突：背景 trackCircle 跟前景進度弧
// 一樣是依 currentZone 動態決定顏色，只是現在可選的顏色多了一種（多了綠色），
// 跨過閾值（25%/50%/75%/90%）整圈就會換成對應顏色。
const FILTER_RING_ZONES = [
  { min: 0, max: 25, color: '#60a5fa', dim: 'rgba(59,130,246,0.25)' },   // 藍：安全
  { min: 25, max: 50, color: '#4ade80', dim: 'rgba(34,197,94,0.25)' },   // 綠：良好
  { min: 50, max: 75, color: '#facc15', dim: 'rgba(234,179,8,0.25)' },   // 黃：注意
  { min: 75, max: 90, color: '#fb923c', dim: 'rgba(251,146,60,0.3)' },   // 橘：警戒
  { min: 90, max: 100, color: '#ef4444', dim: 'rgba(220,38,38,0.3)' },   // 紅：危險
];

// ⚡ 新增：把顏色跟白色混合，ratio 0 = 完全原色，1 = 完全變白，可以自由調整「多亮」
function mixWithWhite(hex, ratio) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c) => Math.round(c + (255 - c) * ratio);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const FILTER_RING_BRIGHTEN_RATIO = 0.35; // ⚡ 進度弧核心變白的程度，0~1，數字越大越白

// ⚡ 新增：圓環呼吸光暈的 CSS keyframes（只注入一次）。
// 動畫只動 opacity + transform：這兩個屬性瀏覽器可以直接在 GPU 圖層上
// 合成（composite），不需要重新計算/重繪圓環的幾何內容或 blur 濾鏡，
// 成本幾乎固定、跟元素複雜度無關，是效能最好的動畫寫法。
// 動畫跑在瀏覽器 compositor thread，不進 JS 的 animate() render loop；
// 卡片 display:none 時瀏覽器會自動暫停動畫，水龍頭沒開時完全零成本。
const filterGlowStyleTag = document.createElement('style');
filterGlowStyleTag.textContent = `
@keyframes filterRingGlowBreathe {
  0%, 100% {
    opacity: 0.3;
    transform: scale(1);
  }
  50% {
    opacity: 0.8;
    transform: scale(1.06);
  }
}
.filter-ring-glow {
  transform-origin: 40px 40px; /* 對齊 SVG viewBox(0 0 80 80) 圓心，scale 時光暈不會偏移 */
  animation: filterRingGlowBreathe 1.8s ease-in-out infinite;
  will-change: opacity, transform;
}
`;
document.head.appendChild(filterGlowStyleTag);

// ── 卡片顯示：只看是否在視野內，不再限制距離 ──
const FILTER_CARD_VISIBILITY_INTERVAL = 0.15; // 視野判斷節流間隔（秒），不需要每一幀都算

let filterCardVisibilityElapsed = 0;
const _filterCardWorldPos = new THREE.Vector3(); // 重複使用的暫存向量，避免每次判斷都 new

// ⚡ 位移套用：只處理卡片互相避讓的水平位移，不再有縮放
function applyCardOffsetAndScale(card) {
  card.offsetWrapper.style.transform = `translateX(${card.offsetX}px)`;
}

function createFilterCard(device) {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'absolute';
  wrapper.style.pointerEvents = 'none';

  const offsetWrapper = document.createElement('div');
  offsetWrapper.style.position = 'absolute';
  offsetWrapper.style.left = '0';
  offsetWrapper.style.top = '0';
  offsetWrapper.style.transform = 'translateX(0px)';
  wrapper.appendChild(offsetWrapper);

  const root = document.createElement('div');
  Object.assign(root.style, {
    display: 'none', // 沒出水/不符合顯示條件時隱藏
    background: 'rgba(0,0,0,0.4)',
    backdropFilter: 'blur(4px)',
    borderRadius: '50%',
    padding: '4px',
    position: 'absolute',
    left: '50%',
    bottom: '0',
    marginLeft: '-40px',  // 抵銷圓環寬度(約68px)的一半，橫向置中對齊錠點
    marginBottom: '10px',
    opacity: '0',
    transformOrigin: 'center center',
    transform: 'scale(0.4)',
    transition: `transform ${FILTER_CARD_SHOW_MS}ms ease-out, opacity ${FILTER_CARD_SHOW_MS}ms ease-out`,
  });
  root.classList.add('filter-card-glow'); // ⚡ 新增：加上呼吸光暈動畫（display:none時瀏覽器會自動暫停，零成本

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '80');
  svg.setAttribute('height', '80');
  svg.setAttribute('viewBox', '0 0 80 80');
  svg.style.overflow = 'visible'; // ⚡ 保險：明確允許光暈超出viewBox範圍也不被裁切

  // 底環：極暗的輪廓，讓整個圓形看得出來
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bg.setAttribute('cx', '40'); bg.setAttribute('cy', '40'); bg.setAttribute('r', String(RING_RADIUS));
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke', 'rgba(255,255,255,0.15)');
  bg.setAttribute('stroke-width', '6');
  svg.appendChild(bg);
  // ⚡ 改成「單色提醒」：原本這裡是5段各自上色的 circle，背景永遠同時顯示
  // 藍/綠/黃/橘/紅五種顏色，跟目前狀態無關。現在改成只有一條整圈的
  // trackCircle，顏色由 updateFilterUI() 依「目前所在區段」即時設定，
  // 永遠只呈現一種顏色（跟前景的進度弧同色系，只是較暗），
  // 讓整個圓環在同一時間只透露一個顏色訊號，跨過閾值才整個換色。
  const trackCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  trackCircle.setAttribute('cx', '40'); trackCircle.setAttribute('cy', '40'); trackCircle.setAttribute('r', String(RING_RADIUS));
  trackCircle.setAttribute('fill', 'none');
  trackCircle.setAttribute('stroke-width', '6');
  trackCircle.setAttribute('stroke-dasharray', `${RING_CIRC} 0`); // 固定整圈，不隨用量變化
  trackCircle.setAttribute('stroke', FILTER_RING_ZONES[0].dim); // 初始值，之後每次 updateFilterUI() 都會覆蓋
  svg.appendChild(trackCircle);

  // ⚡ 新增：halo circle，貼在圓環的「已使用進度」那一段上，用來做呼吸光暈。
  // 粗細(stroke-width)、模糊(blur)都寫死固定值，動畫只透過 CSS class
  // 「filter-ring-glow」去動 opacity/transform，不會逐幀重繪這條線本身，
  // 效能成本最低。dasharray 長度會在 updateFilterUI() 裡跟進度弧同步。
  const haloCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  haloCircle.setAttribute('cx', '40'); haloCircle.setAttribute('cy', '40'); haloCircle.setAttribute('r', String(RING_RADIUS));
  haloCircle.setAttribute('fill', 'none');
  haloCircle.setAttribute('stroke-width', '10'); // 固定粗細，不隨動畫變化
  // ⚡ 改成固定「滿圈」：dasharray = 整個圓周長度 + 0 間隙，
  // 不再跟進度弧的 progressLen 同步，這樣不管濾心用量多少，
  // 光暈永遠環繞整個圓環一圈，而不是只出現在已使用的那一小段。
  haloCircle.setAttribute('stroke-dasharray', `${RING_CIRC} 0`);
  haloCircle.setAttribute('transform', 'rotate(-90 40 40)');
  haloCircle.style.filter = 'blur(4px)'; // 固定模糊值，讓它看起來像光暈而不是一條硬邊線
  haloCircle.classList.add('filter-ring-glow'); // 掛上呼吸動畫（只動 opacity/transform）
  svg.appendChild(haloCircle);

  // ⚡ 新增：進度弧，疊在 halo 之上，維持清晰銳利的邊緣。長度 = 已用百分比，
  // updateFilterUI() 會即時更新它的 dasharray 跟顏色。
  const progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  progressCircle.setAttribute('cx', '40'); progressCircle.setAttribute('cy', '40'); progressCircle.setAttribute('r', String(RING_RADIUS));
  progressCircle.setAttribute('fill', 'none');
  progressCircle.setAttribute('stroke-width', '6');
  progressCircle.setAttribute('stroke-linecap', 'round'); // 進度末端圓角，看起來更像進度環
  progressCircle.setAttribute('stroke-dasharray', `0 ${RING_CIRC}`); // 一開始是0，updateFilterUI 會補上實際比例
  progressCircle.setAttribute('transform', 'rotate(-90 40 40)');
  svg.appendChild(progressCircle);

  root.appendChild(svg);

  // ⚡ 圓心文字改成三行顯示「剩餘」時／分／秒（原本是累積已用時間的單行長字串，
  // 濾心壽命 2000 小時的極限值會變成「1999小時59分59秒」9個字，在 80px 圓環裡
  // 塞不下）。拆成三行、各自固定寬度（時最多4位數、分秒固定2位數），版面不會
  // 再隨壽命拉長而擠爆，秒數仍然每秒跳動一次維持「系統正在即時運算」的即時感。
  // 方向也跟圓環的「剩餘量」邏輯一致：圓環消退、數字倒數，同步遞減不會打架。
  const timeText = document.createElement('div');
  Object.assign(timeText.style, {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    color: '#fff',
    textAlign: 'center',
    lineHeight: '1.15',
    whiteSpace: 'nowrap',
    textShadow: '0 1px 2px rgba(0,0,0,0.8)',
    pointerEvents: 'none',
  });

  // 建立單一行（數值 + 單位），回傳這一行的 value span 供之後每次更新文字用
  function makeRemainingTimeLine(unitLabel) {
    const line = document.createElement('div');
    Object.assign(line.style, {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'center',
      gap: '2px',
    });
    const valueSpan = document.createElement('span');
    valueSpan.style.fontSize = '11px';
    valueSpan.style.fontWeight = '600';
    const unitSpan = document.createElement('span');
    unitSpan.textContent = unitLabel;
    unitSpan.style.fontSize = '8px';
    unitSpan.style.fontWeight = '500';
    unitSpan.style.opacity = '0.85';
    line.appendChild(valueSpan);
    line.appendChild(unitSpan);
    timeText.appendChild(line);
    return valueSpan;
  }

  const hourValueEl = makeRemainingTimeLine('時');
  const minuteValueEl = makeRemainingTimeLine('分');
  const secondValueEl = makeRemainingTimeLine('秒');

  root.appendChild(timeText);

  offsetWrapper.appendChild(root);

  filterUICards[device] = {
    wrapper, offsetWrapper, root, cssObject: null,
    trackCircle, progressCircle, haloCircle,
    hourValueEl, minuteValueEl, secondValueEl,
    hideTimer: null, isVisible: false,
  };
}
FILTER_DEVICES.forEach(createFilterCard);

// ⚡ 把濾心卡片掛到3D場景裡：優先掛在「出水口」這個空物件上（位置最精確，
// 就是水真正流出來的那個點），找不到才退回掛在裝置 mesh 本身上。
// 一定要等 GLTF 模型載入完成、outletObjects/interactiveDevices 都填好之後
// 才能呼叫，所以放在 loader.load() 的callback最後面才執行。
function attachFilterCardsToScene() {
  FILTER_DEVICES.forEach(device => {
    const card = filterUICards[device];
    if (!card || card.cssObject) return; // 已經掛過了就不要重複掛

    const cfg = PIPE_CONFIG[device];
    const anchorParent =
      (cfg && outletObjects[cfg.outletKey]) ||
      interactiveDevices.find(m => m.name.toLowerCase() === device);

    if (!anchorParent) {
      console.warn(`[FilterUI] 找不到 ${device} 對應的3D物件，濾心卡片無法定位`);
      return;
    }

    const cssObject = new CSS2DObject(card.wrapper);
    cssObject.position.set(0, FILTER_CARD_HEIGHT_OFFSET, 0); // 相對於裝置本身往上偏移
    anchorParent.add(cssObject);
    card.cssObject = cssObject;
  });
}

// ═══════════════════════════════════════════════════════════
// ── 開關靠近提示：橘色魚形提示，靠近開關1公尺內彈出「按開關」──
// ⚡ 效能設計刻意跟結束畫面的魚群動畫（見 createEndScreenAmbience）不同——
// 那組魚是「3D渲染主迴圈已經停掉之後」才會啟動的JS逐幀steering動畫，
// 這裡的提示是遊戲進行中隨時可能出現的，不能沿用同一套寫法。改成：
//   1. 位置：沿用濾心卡片同一套 CSS2DObject／CSS2DRenderer，掛成裝置 mesh
//      的子物件，跟著 Three.js 本來就會做的場景矩陣運算走，不用額外寫
//      world-to-screen 投影。
//   2. 上下浮動的動畫：純 CSS @keyframes，只動 transform，交給瀏覽器
//      compositor thread 處理，不進 JS 的 animate() 迴圈，跟濾心圓環的
//      呼吸光暈（filterRingGlowBreathe）同一招。沒有 .visible 時瀏覽器
//      自動暫停動畫，沒人靠近時零成本。
//   3. 距離判斷：用便宜的「兩點距離」計算，每幀都算一次（見下方
//      updateSwitchHintVisibility 開頭的說明：裝置數量有限，成本可忽略，
//      拿掉節流換取出現/消失門檻更即時準確）。
//   4. 數量：整個場景的開關就是 PIPE_CONFIG 列出的幾個裝置（目前8個），
//      距離檢查頂多8次減法+開根號，一幀跑一次也沒問題。
// ═══════════════════════════════════════════════════════════

const SWITCH_HINT_DEVICES = Object.keys(PIPE_CONFIG); // 場景裡所有可點擊開關的裝置名稱
const SWITCH_HINT_RADIUS = 2.4;             // 靠近幾公尺內才彈出提示（Blender校正物件中心後實測值）
const SWITCH_HINT_HEIGHT_OFFSET = 0.15;     // 相對於裝置本身往上偏移多少（跟濾心卡片的 0.2 錯開，避免疊在一起）
const SWITCH_HINT_CHECK_INTERVAL = 0.2;     // 距離判斷節流間隔（秒）
// ⚡ 保留節流：出現/消失用同一個 SWITCH_HINT_RADIUS，理論上就是同一個距離。
// 節流間隔拉長時，移動速度快的話確實會讓「跨過門檻」跟「系統反應」之間
// 出現一點延遲落差（0.2秒內走0.3~0.6公尺是有可能的），如果之後還是
// 覺得落差明顯，可以把這個數字調小（例如 0.1），或恢復成每幀檢查
// （8個裝置的距離計算成本本身可忽略，主要看你想不想接受這個延遲）。

const switchHintCards = {}; // { [device]: { root, cssObject, isVisible, dismissedUntilLeave } }
let switchHintCheckElapsed = 0;
const _switchHintWorldPos = new THREE.Vector3(); // 重複使用的暫存向量，避免每次判斷都 new

// ⚡ 魚形提示的 CSS keyframes + 樣式（只注入一次）。只動 transform + opacity，
// GPU合成，跟濾心圓環呼吸光暈同樣的效能等級。
const switchHintStyleTag = document.createElement('style');
switchHintStyleTag.textContent = `
.switch-hint-root {
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease-out;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.switch-hint-root.visible {
  opacity: 1;
}
/* ⚡ 文字現在放在魚群「上方」，不是畫在魚身上——跟裝置本身脫鉤，
   單獨一行，兩條魚不管怎麼動、怎麼排列都不會影響文字的可讀性。 */
.switch-hint-label {
  color: rgba(255,255,255,0.9);
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
}
/* ⚡ 兩條魚呈V字型分別站在物件斜上方兩側，魚頭都斜向下指向中間的物件
   （物件本身在3D世界裡就在這個浮動群組的正下方）。固定寬高當畫布，
   裡面兩個 slot 各自用絕對定位+旋轉角度擺放，不需要 scaleX 鏡射。 */
.switch-hint-fish-group {
  position: relative;
  width: 80px;
  height: 33px;
}
.switch-hint-fish-slot {
  position: absolute;
  top: 4px;
}
/* 左邊：站在物件左上方，旋轉40°後，原本朝右的魚頭會轉向右下，斜指物件 */
.switch-hint-fish-slot.slot-left {
  left: -10px;
  transform: rotate(55deg);
}
/* 右邊：站在物件右上方，旋轉140°後，原本朝右的魚頭會轉向左下，斜指物件——
   跟左邊剛好對稱，不用額外鏡射一份形狀。 */
.switch-hint-fish-slot.slot-right {
  right: -10px;
  transform: rotate(135deg);
}
/* ⚡ 單條魚的基本形狀，永遠是「預設朝右」，實際朝向完全交給外層 slot 的
   rotate() 角度決定。前進後退的「啃咬」動畫只動 translateX，套用在
   已經被 slot 轉過角度的座標系裡，會自動沿著魚頭指的方向前進後退，
   不用另外為每個角度寫一份動畫。 */
.switch-hint-fish-h {
  display: flex;
  align-items: center;
  animation: switchHintNibble 0.95s linear infinite;
  will-change: transform;
}
/* ⚡ 另一條魚的動畫時長刻意跟左邊不一樣（0.95s vs 1.25s，不是簡單倍數關係），
   兩條魚每次循環後的相對位置會持續往前漂移、不會永遠對得整整齊齊，
   看起來才不會像兩隻機器手臂在對稱擺動。 */
.switch-hint-fish-h.delayed {
  animation-duration: 1.25s;
  animation-delay: 0.3s;
}
/* ⚡ 原本是對稱的 ease-in-out（前衝跟退回速度一樣），改成不對稱的時間曲線：
   前段(0%→22%)快速衝刺一口咬下去，中段(22%→38%)停頓一下像叼住不放，
   後段(38%→100%)緩慢退回，速度節奏跟真實生物的動作比較接近，
   不會是那種等速往返、一看就知道是在跑固定動畫的死板感。 */
@keyframes switchHintNibble {
  0%       { transform: translateX(0) scaleX(1); }
  22%      { transform: translateX(9px) scaleX(0.88); }   /* 快速前衝一口咬下去 */
  38%      { transform: translateX(8px) scaleX(0.92); }   /* 停頓一下，像叼住不放 */
  100%     { transform: translateX(0) scaleX(1); }        /* 緩慢退回 */
}
.fish-body-h {
  width: 25px;
  height: 16px;
  background: linear-gradient(180deg, #ffb454, #fb7a1f);
  border-radius: 50%;
  box-shadow: 0 0 8px rgba(251, 146, 60, 0.7), 0 2px 5px rgba(0,0,0,0.4);
}
/* 頭部尖端：指向右邊（旋轉前的預設方向，實際朝向由外層slot決定），底邊貼著魚身右緣 */
.fish-head-h {
  width: 0;
  height: 0;
  border-top: 7px solid transparent;
  border-bottom: 7px solid transparent;
  border-left: 9px solid #fb7a1f;
  margin-left: -5px;
  filter: drop-shadow(1px 0 2px rgba(0,0,0,0.3));
}
/* 尾鰭：故意做得比頭部小很多，貼著魚身左緣，才分得出頭尾方向 */
.fish-tailfin-h {
  width: 24px;               /* 適當加寬，讓凹陷更有視覺空間 */
  height: 20px;
  background-color: #fb7a1f;
  margin-right: -10px;
  filter: drop-shadow(-1px 0 2px rgba(0,0,0,0.25));

  /* 4 個點描繪：左上 -> 右側尖端 -> 左下 -> 底部中央內凹點 */
  clip-path: polygon(
    0% 0%,      /* 1. 左上角尖點 */
    100% 50%,   /* 2. 右側指向尖點 */
    0% 100%,    /* 3. 左下角尖點 */
    35% 50%     /* 4. 左側底邊內凹點（向右深陷進去） */
  );
}
`;
document.head.appendChild(switchHintStyleTag);

// 建立單一「魚」的形狀（尾鰭 → 橢圓魚身 → 頭部尖端），永遠預設朝右，
// 實際朝向交給外層 slot 的 rotate() 決定，給下面 createSwitchHint() 組出兩條魚共用。
function buildSwitchHintFish(extraClass) {
  const fish = document.createElement('div');
  fish.className = extraClass ? `switch-hint-fish-h ${extraClass}` : 'switch-hint-fish-h';

  const tailFin = document.createElement('div');
  tailFin.className = 'fish-tailfin-h';

  const body = document.createElement('div');
  body.className = 'fish-body-h';

  const head = document.createElement('div');
  head.className = 'fish-head-h';

  fish.appendChild(tailFin);
  fish.appendChild(body);
  fish.appendChild(head);
  return fish;
}

// 建立單一開關的提示 DOM：上方文字「按一下」+ 下方兩條魚呈V字型立在物件斜上方兩側
// （cssObject 要等場景 GLTF 載入完成才補上，見 attachSwitchHintsToScene）
// ⚡ 外層 wrapper 乾淨地交給 CSS2DObject 自己管定位（它每一幀都會直接
// 覆寫 style.transform 做世界座標轉螢幕座標），我方的置中/浮動動畫樣式
// 全部搬到內層 root，避免兩邊搶著寫同一個元素的 transform 導致互相蓋掉
// （這正是濾心卡片用 wrapper→offsetWrapper→root 三層結構的同一個理由）。
function createSwitchHint(device) {
  const wrapper = document.createElement('div'); // 這層交給 CSS2DObject，內容不放任何自訂 transform

  const root = document.createElement('div');
  root.className = 'switch-hint-root';

  const label = document.createElement('div');
  label.className = 'switch-hint-label';
  label.textContent = '按開關';

  const group = document.createElement('div');
  group.className = 'switch-hint-fish-group';

  // 左邊：slot-left 旋轉40°後，魚頭斜指向右下方的物件
  const slotLeft = document.createElement('div');
  slotLeft.className = 'switch-hint-fish-slot slot-left';
  slotLeft.appendChild(buildSwitchHintFish());

  // 右邊：slot-right 旋轉140°後，魚頭斜指向左下方的物件——跟左邊對稱，
  // 用的是同一份「預設朝右」的魚形，不需要額外鏡射；animation-delay
  // 錯開，兩條魚才不會同時前衝、看起來呆板。
  const slotRight = document.createElement('div');
  slotRight.className = 'switch-hint-fish-slot slot-right';
  slotRight.appendChild(buildSwitchHintFish('delayed'));

  group.appendChild(slotLeft);
  group.appendChild(slotRight);

  root.appendChild(label);
  root.appendChild(group);
  wrapper.appendChild(root);

  switchHintCards[device] = { wrapper, root, cssObject: null, isVisible: false, dismissedUntilLeave: false };
}
SWITCH_HINT_DEVICES.forEach(createSwitchHint);

// ═══════════════════════════════════════════════════════════
// ── 門靠近提示：距離指定的門2公尺內彈出「按門開關」──
// 跟上面開關的魚形提示（SWITCH_HINT_*）是完全獨立的系統，差異點：
//   1. 支援多個裝置（DOOR_HINT_DEVICES 陣列），但全部共用同一個
//      doorHintSeen 旗標——只要其中任何一扇門觸發過這個提示，
//      代表玩家已經學會「按門可以開關」，其餘的門就不會再顯示，
//      不是每個裝置各自獨立記錄「看過了沒」。
//   2. ⚡ 沒有魚了。改成「光暈 + 文字浮現」的設計，抓的是「靠近時
//      像神明現身說話」的氛圍：中間一團柔和的放射狀光暈，文字從
//      模糊、縮小、透明的狀態，緩緩浮現放大、清晰、發光，像從
//      光裡顯現出來，光暈本身則是持續、輕微的呼吸律動（infinite，
//      但只是純CSS的opacity/scale變化，成本極低，概念上跟濾心圓環
//      的呼吸光暈是同一招）。
//   3. 文字「按門開關」不會自己倒數消失，會一直留著，直到玩家真的
//      按了其中一扇門才消失；按過之後 doorHintSeen 永久設成 true，
//      之後不管再靠近哪一扇門都不會再彈出這個提示——這是一次性的
//      教學提示，不是每次靠近都要重複提醒的常駐UI。
// ⚡ 效能：裝置數量少（目前2個），只有簡單的 opacity/scale/blur CSS
// 動畫，沒有任何JS逐幀運算，比原本的魚更省。
// ═══════════════════════════════════════════════════════════

// ⚡ 每個裝置除了名字，還帶一個 offsetX——因為不同門的物件中心（pivot）
// 在Blender裡不一定量測得完全一致（例如door_livingroom的中心點在門軸，
// 需要往門片中央方向修正），所以做成可以逐一調整，不是全部門共用同一個值。
const DOOR_HINT_DEVICES = [
  { name: 'door_livingroom', offsetX: 0.8 },
  { name: 'kit_sliding_door', offsetX: 0 }, // ⚡ 先給0，之後看實際畫面偏移多少再調整
];
const DOOR_HINT_RADIUS = 3.5;              // 靠近幾公尺內彈出提示
const DOOR_HINT_HEIGHT_OFFSET = 0.4;     // 相對於門本身往上偏移多少

let doorHintSeen = false; // ⚡ 共用旗標：只要按過「任一扇」門，之後所有門都不再顯示提示
const doorHintInstances = {}; // { [device]: { wrapper, root, label, cssObject, offsetX, isVisible } }
const _doorHintWorldPos = new THREE.Vector3(); // 重複使用的暫存向量，避免每次判斷都 new

// ⚡「神明現身」的光暈 + 文字浮現效果：
//   .door-hint-glow：放射狀漸層光暈，持續輕微呼吸律動（infinite，但只是
//   opacity/scale，成本極低）。
//   .door-hint-label：文字本身，從模糊縮小透明 → 清晰放大顯現，
//   是一次性動畫（不加infinite，配合 forwards 停在顯現後的最終狀態），
//   每次從隱藏變顯示都會透過 triggerDoorHintAppear() 重新播放一次。
const doorHintStyleTag = document.createElement('style');
doorHintStyleTag.textContent = `
.door-hint-root {
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms ease-out;
  display: flex;
  align-items: center;
  justify-content: center;
}
.door-hint-root.visible {
  opacity: 1;
}
.door-hint-glow {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 220px;   /* ⚡ 放大：原本140px，範圍越大數字越大 */
  height: 220px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle,
    rgba(255,255,255,0.5) 0%,
    rgba(191,219,254,0.3) 30%,
    rgba(147,197,253,0.12) 55%,
    rgba(147,197,253,0) 75%);
  pointer-events: none;
  animation: doorHintGlowBreathe 2.6s ease-in-out infinite;
}
/* ⚡ 新增：黑色圓底，疊在光暈上方、文字下方，讓白色文字有足夠對比、
   不會被場景背景吃掉。比光暈小一圈，露出外圍的光暈當作發光邊緣。 */
@keyframes doorHintGlowBreathe {
  0%, 100% { opacity: 0.65; transform: translate(-50%, -50%) scale(0.92); }
  50%      { opacity: 1;    transform: translate(-50%, -50%) scale(1.08); }
}
.door-hint-label {
  position: relative;
  color: #000000;
  font-size: 17px;
  font-weight: 700;
  white-space: nowrap;
  text-shadow: 0 0 6px rgba(255,255,255,0.9), 0 0 14px rgba(191,219,254,0.7);
  letter-spacing: 1px;
}
/* ⚡ 一次性「浮現」動畫：跟葉子的細縫展開動畫同時開始，
   從模糊、縮小、透明開始，緩緩放大、清晰、顯現，不加infinite，
   播完停在顯現後的最終狀態（forwards）。要重播必須由
   triggerDoorHintAppear() 主動移除再加回 class，是標準的CSS動畫
   重播技巧。 */
.door-hint-label.appearing {
  animation: doorHintLabelAppear 1.1s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes doorHintLabelAppear {
  0%   { opacity: 0; transform: scale(0.4); filter: blur(6px); }
  60%  { opacity: 1; transform: scale(1.08); filter: blur(0px); }
  100% { opacity: 1; transform: scale(1); filter: blur(0px); }
}
/* ⚡ 葉子改成「發光細縫展開」出現：一開始沿著葉子本身的斜向
   （rotate(-20deg)，右上到左下）壓扁成一條細線，帶著明顯的發光感，
   接著沿同一條斜線展開放大，變成完整的葉子形狀——像一道光縫裂開，
   從中間展開出葉片。跟文字一起靠外層 .door-hint-root 的 opacity
   切換來顯示/隱藏（見 setDoorHintVisible），一起出現、一起消失。
   全程只動 opacity/transform/filter，GPU合成，一次性播放，播完就停
   在完全展開的狀態（forwards），不會反覆重播（要重播由
   triggerDoorHintAppear() 統一觸發）。 */
.door-hint-leaf-wrap {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 52px;
  height: 52px;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.door-hint-leaf {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #86efac, #16a34a);
  border-radius: 0% 100% 0% 100%;
  opacity: 0;
  /* 初始狀態：沿著葉子自己的斜向（-20deg）壓扁成一條細縫，
     scaleX 壓到接近0，展開時只需要把 scaleX 放大回1即可，
     細縫跟展開後的葉子會是同一條斜線方向，不會歪掉。 */
  transform: rotate(-20deg) scaleX(0.03);
  box-shadow: 0 0 10px rgba(134,239,172,0.95), 0 0 22px rgba(22,163,74,0.7);
}
.door-hint-leaf-wrap.leaf-playing .door-hint-leaf {
  animation: doorHintLeafOpen 0.75s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
@keyframes doorHintLeafOpen {
  0%   { opacity: 1; transform: rotate(-20deg) scaleX(0.03); filter: brightness(1.7); }
  40%  { opacity: 1; transform: rotate(-20deg) scaleX(0.03); filter: brightness(1.7); } /* 細縫先停留一下再展開，讓「這是一條縫」的瞬間夠明顯 */
  100% { opacity: 1; transform: rotate(-20deg) scaleX(1);    filter: brightness(1); }
}
`;
document.head.appendChild(doorHintStyleTag);

// 建立葉子 DOM（單一葉形，靠 scaleX 從細縫展開成完整葉子，不再需要像素格）。
function buildDoorHintLeaf() {
  const wrap = document.createElement('div');
  wrap.className = 'door-hint-leaf-wrap';

  const leaf = document.createElement('div');
  leaf.className = 'door-hint-leaf';
  wrap.appendChild(leaf);

  return wrap;
}

// 建立單一裝置的門提示 DOM 結構（cssObject 要等場景 GLTF 載入完成才補上，
// 見 attachDoorHintsToScene）。跟開關提示一樣，用陣列 forEach 建立多個實體，
// 但共用的是同一個全域 doorHintSeen 旗標，不是各自獨立判斷。
function createDoorHint(config) {
  const wrapper = document.createElement('div'); // 交給 CSS2DObject 自己管定位，跟開關提示同樣的理由

  const root = document.createElement('div');
  root.className = 'door-hint-root';

  const glow = document.createElement('div');
  glow.className = 'door-hint-glow';

  const leafWrap = buildDoorHintLeaf();

  const label = document.createElement('div');
  label.className = 'door-hint-label';
  label.textContent = '按門開關';

  root.appendChild(glow);
  root.appendChild(leafWrap);
  root.appendChild(label);
  wrapper.appendChild(root);

  doorHintInstances[config.name] = {
    wrapper, root, label, leafWrap, cssObject: null,
    offsetX: config.offsetX || 0, isVisible: false,
  };
}
DOOR_HINT_DEVICES.forEach(createDoorHint);

// 把每個門提示掛到3D場景裡：跟濾心卡片/開關提示同一套做法，掛在門 mesh
// 本身上，一定要等 GLTF 模型載入完成、doorAnimations 都填好之後才能呼叫。
function attachDoorHintsToScene() {
  DOOR_HINT_DEVICES.forEach(({ name }) => {
    const hint = doorHintInstances[name];
    if (!hint || hint.cssObject) return; // 已經掛過了

    const anim = doorAnimations[name];
    if (!anim || !anim.mesh) {
      console.warn(`[DoorHint] 找不到 ${name} 對應的3D物件，門提示無法定位`);
      return;
    }
    const cssObject = new CSS2DObject(hint.wrapper);
    cssObject.position.set(hint.offsetX, DOOR_HINT_HEIGHT_OFFSET, 0);
    anim.mesh.add(cssObject);
    hint.cssObject = cssObject;
  });
}

// ⚡ 重新觸發指定裝置文字的「浮現」動畫：先拿掉 class 強制瀏覽器
// reflow，再重新加回去，CSS animation 才會從頭播放一次——同一個 class
// 只在第一次加上去時會觸發動畫，之後不會自動重播，這是標準的CSS動畫
// 重播技巧，成本是一次同步的樣式讀取（offsetWidth），可忽略。
function triggerDoorHintAppear(device) {
  const hint = doorHintInstances[device];
  if (!hint) return;

  // ⚡ 葉子（發光細縫展開）跟文字是兩個獨立的一次性動畫，兩者同時
  // 開始播放，一起重新觸發才會維持同步的「重播」效果。
  hint.leafWrap.classList.remove('leaf-playing');
  void hint.leafWrap.offsetWidth; // 強制 reflow，讓瀏覽器認為這是「新的一次」動畫
  hint.leafWrap.classList.add('leaf-playing');

  hint.label.classList.remove('appearing');
  void hint.label.offsetWidth;
  hint.label.classList.add('appearing');
}

// 顯示/隱藏指定裝置的門提示；從隱藏變顯示的那一刻（rising edge）
// 順便重播浮現動畫
function setDoorHintVisible(device, visible) {
  const hint = doorHintInstances[device];
  if (!hint || hint.isVisible === visible) return;
  hint.isVisible = visible;
  hint.root.classList.toggle('visible', visible);
  if (visible) {
    triggerDoorHintAppear(device);
  }
}

// ⚡ 使用者按下「任一扇」門時呼叫：doorHintSeen 永久設成 true，
// 所有門提示立刻一起隱藏，之後不管再靠近哪一扇門都不會再顯示——
// 這是共用的教學型一次性提示，跟開關提示「離開範圍後下次靠近還會
// 再彈出」的行為刻意不同。
function dismissDoorHintPermanently() {
  doorHintSeen = true;
  DOOR_HINT_DEVICES.forEach(({ name }) => setDoorHintVisible(name, false));
}

// ⚡ 距離判斷：裝置數量少，每幀對每個裝置算一次「兩點距離」成本可忽略，
// 不需要像開關提示那樣特別節流。doorHintSeen 一旦是 true 就整個跳過，
// 連距離計算都省了。
function updateDoorHintsVisibility() {
  if (doorHintSeen) return;
  DOOR_HINT_DEVICES.forEach(({ name }) => {
    const hint = doorHintInstances[name];
    if (!hint || !hint.cssObject) return;
    hint.cssObject.getWorldPosition(_doorHintWorldPos);
    const dist = camera.position.distanceTo(_doorHintWorldPos);
    setDoorHintVisible(name, dist <= DOOR_HINT_RADIUS);
  });
}


// ⚡ 把魚形提示掛到3D場景裡：跟濾心卡片（attachFilterCardsToScene）同一套做法，
// 掛在裝置 mesh 本身上，一定要等 GLTF 模型載入完成、interactiveDevices
// 都填好之後才能呼叫。
function attachSwitchHintsToScene() {
  // 🔧 暫時除錯用：列出 PIPE_CONFIG 8 個開關裡，哪些成功掛上、哪些找不到對應mesh。
  // 排查完之後可以把這行 console.log 拿掉。
  console.log('[SwitchHint] interactiveDevices 目前收錄的mesh名稱:', interactiveDevices.map(m => m.name.toLowerCase()));

  SWITCH_HINT_DEVICES.forEach(device => {
    const hint = switchHintCards[device];
    if (!hint || hint.cssObject) return; // 已經掛過了就不要重複掛

    const anchorParent = interactiveDevices.find(m => m.name.toLowerCase() === device);
    if (!anchorParent) {
      console.warn(`[SwitchHint] 找不到 ${device} 對應的3D物件，開關提示無法定位`);
      return;
    }

    const cssObject = new CSS2DObject(hint.wrapper);
    cssObject.position.set(0, SWITCH_HINT_HEIGHT_OFFSET, 0);
    anchorParent.add(cssObject);
    hint.cssObject = cssObject;
    console.log(`[SwitchHint] ${device} 掛載成功`); // 🔧 暫時除錯用，排查完可拿掉
  });
}

// 顯示/隱藏單一開關的提示（給距離判斷跟點擊事件共用）
function setSwitchHintVisible(device, visible) {
  const hint = switchHintCards[device];
  if (!hint || !hint.cssObject) return;
  if (hint.isVisible === visible) return;
  hint.isVisible = visible;
  hint.root.classList.toggle('visible', visible);
}

// ⚡ 使用者按下開關時呼叫：立刻隱藏提示，並標記「這次靠近先不要再彈出來」，
// 避免下一輪距離判斷（最多 SWITCH_HINT_CHECK_INTERVAL 秒後）又把它顯示回來，
// 造成一按下去提示又立刻彈回來的閃爍感。等使用者離開 SWITCH_HINT_RADIUS
// 範圍之後才會解除標記，下次重新靠近才會再次提示。
function dismissSwitchHint(device) {
  const hint = switchHintCards[device];
  if (!hint) return;
  hint.dismissedUntilLeave = true;
  setSwitchHintVisible(device, false);
}

// ⚡ 節流：每 SWITCH_HINT_CHECK_INTERVAL 秒才對每個開關算一次距離，
// 不是每一幀都算。裝置數量有限（目前8個），成本可忽略，但保留節流
// 給移動裝置/低階顯卡多一點安全邊際。
function updateSwitchHintVisibility() {
  SWITCH_HINT_DEVICES.forEach(device => {
    const hint = switchHintCards[device];
    if (!hint || !hint.cssObject) return;

    hint.cssObject.getWorldPosition(_switchHintWorldPos);
    const dist = camera.position.distanceTo(_switchHintWorldPos);
    const inRange = dist <= SWITCH_HINT_RADIUS;

    // 🔧 暫時除錯用：印出每個開關目前的距離跟是否該顯示。排查完可拿掉整個 if 區塊。
    if (window.__SWITCH_HINT_DEBUG__) {
      console.log(`[SwitchHint] ${device} 距離=${dist.toFixed(2)}m inRange=${inRange} dismissed=${hint.dismissedUntilLeave}`);
    }

    if (!inRange) {
      hint.dismissedUntilLeave = false; // 離開範圍後解除「按過先不彈」的標記
    }
    setSwitchHintVisible(device, inRange && !hint.dismissedUntilLeave);
  });
}

// ⚡ 節流重點：這個函式只在 FILTER_UI_UPDATE_INTERVAL 秒才會被呼叫一次，
// 不是每一幀都跑，所以裡面的 DOM 操作（改 3 個屬性）成本完全可以忽略。
// ⚡ 改成計算「剩餘」時間（原本是累積已用時間）。方向理由：
// 圓環已經改成「剩餘量」邏輯（滿圈=全新，用越多消退越多），文字如果還顯示
// 「已用」會變成圓環往下消、數字往上加，方向相反、使用者會覺得兜不起來。
// 拆成 {h, m, s} 三個獨立數字字串（不是組成一整串），讓呼叫端能各自塞進
// 圓心的三行版面，不受濾心壽命拉長（分母變大）影響文字寬度。
// 秒數仍然每秒遞減跳動一次（配合 FILTER_UI_UPDATE_INTERVAL），
// 使用者能立刻感受到「系統正在即時運算」，不會誤以為數字卡住沒在動。
function formatRemainingParts(remainSeconds) {
  const s = Math.max(0, Math.floor(remainSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return {
    h: String(h),
    m: String(m).padStart(2, '0'),
    s: String(sec).padStart(2, '0'),
  };
}

function updateFilterUI(device) {
  const card = filterUICards[device];
  const st = filterState[device];
  if (!card || !st) return;

  const usedPercent = Math.min(100, (st.usedSeconds / FILTER_LIFETIME_SECONDS) * 100);
  // ⚡ 剩餘量：圓環進度弧、圓心文字都改用這個數字，兩者方向才會一致
  // （滿=全新，用越多消退越多，跟油量/電量的直覺一致）。
  const remainSeconds = Math.max(0, FILTER_LIFETIME_SECONDS - st.usedSeconds);
  const remainPercent = 100 - usedPercent;

  // 找出目前所在的區段，只用來決定進度弧該上什麼顏色。
  // ⚡ 這裡刻意仍用 usedPercent（不是 remainPercent）去查表：FILTER_RING_ZONES
  // 的 min/max 定義本來就是描述「已用到多少會進入哪個危險等級」，語意沒有變，
  // 只有下面畫圓環弧長的地方改成用剩餘量，兩者不衝突、也不用重寫一套新的分區表。
  const currentZone = FILTER_RING_ZONES.find((zone, i) => {
    const isLast = i === FILTER_RING_ZONES.length - 1;
    return usedPercent >= zone.min && (isLast ? usedPercent <= zone.max : usedPercent < zone.max);
  }) || FILTER_RING_ZONES[FILTER_RING_ZONES.length - 1];

  // ⚡ 單色提醒：背景整圈 trackCircle 統一改成「目前所在區段」的暗色版本，
  // 不再是永遠同時顯示5種顏色的分段背景。前景進度弧（下面）也是同一個
  // currentZone 的亮色版本，兩者同色系，整個圓環在同一時間只透露一種顏色，
  // 跨過閾值（50%/75%/90%）才會整圈一起換色。
  card.trackCircle.setAttribute('stroke', currentZone.dim);

  // ⚡ 進度弧改成畫「剩餘量」：滿圈=濾心全新，隨使用時間增加逐漸消退。
  // 顏色依然跟著目前所在區段換色（由上面 currentZone 決定），並套用飽和度/光暈。
  // 線條核心用「混白後」的顏色（更亮），光暈維持原本飽和色（保留辨色度）。
  const progressLen = (remainPercent / 100) * RING_CIRC;
  const coreColor = mixWithWhite(currentZone.color, FILTER_RING_BRIGHTEN_RATIO);
  card.progressCircle.setAttribute('stroke-dasharray', `${progressLen} ${RING_CIRC - progressLen}`);
  card.progressCircle.setAttribute('stroke', coreColor);
  card.progressCircle.style.filter =
    `saturate(1.6) brightness(1.25) drop-shadow(0 0 4px ${currentZone.color}) drop-shadow(0 0 8px ${currentZone.color})`;

  // ⚡ halo 固定是滿圈（dasharray 已在建立時設成整圈，這裡不用再動），
  // 只需要同步顏色，讓光暈跟著目前所在區段（藍/綠/黃/橘/紅）換色即可。
  // 已被 FILTER_UI_UPDATE_INTERVAL 節流成每秒才更新一次，成本可忽略。
  card.haloCircle.setAttribute('stroke', currentZone.color);

  // ⚡ 圓心改成三行顯示「剩餘」時／分／秒，方向跟圓環同步遞減，
  // 秒數持續跳動維持「系統正在即時運算」的即時感，同時三行固定寬度
  // 不會因為濾心壽命拉長（分母變大）而擠爆版面。
  const remainingParts = formatRemainingParts(remainSeconds);
  card.hourValueEl.textContent = remainingParts.h;
  card.minuteValueEl.textContent = remainingParts.m;
  card.secondValueEl.textContent = remainingParts.s;
}

// ⚡ 解決「兩個水龍頭太靠近，卡片互相蓋住」的問題：
// 用簡單的鬆弛（relaxation）演算法——每一輪檢查任兩張目前顯示中的卡片
// 是否重疊（含間距 FILTER_CARD_GAP），重疊就各自往反方向推開一半的重疊量，
// 跑幾輪讓結果穩定下來。這個位移只作用在 offsetWrapper 上，跟卡片本身的
// 3D定位（wrapper）、展開動畫（root的scale/opacity）完全獨立，不會互相干擾。
// 只有在「有卡片新出現/消失」時才重新計算一次，不是每一幀都跑，成本可忽略。
function resolveFilterCardOverlaps() {
  const visibleDevices = FILTER_DEVICES.filter(
    d => filterUICards[d] && filterUICards[d].root.style.display === 'flex'
  );

  if (visibleDevices.length === 0) return;

  if (visibleDevices.length === 1) {
    const card = filterUICards[visibleDevices[0]];
    card.offsetX = 0;
    card.offsetWrapper.style.transition = 'transform 0.25s ease';
    applyCardOffsetAndScale(card);
    return;
  }

  visibleDevices.forEach(d => {
    const card = filterUICards[d];
    card.offsetX = 0;
    card.offsetWrapper.style.transition = 'none';
    applyCardOffsetAndScale(card);
  });
  void filterUICards[visibleDevices[0]].offsetWrapper.offsetWidth;

  const rects = visibleDevices.map(d => {
    const r = filterUICards[d].root.getBoundingClientRect();
    return { device: d, left: r.left, right: r.right, offset: 0 };
  });

  const ITERATIONS = 4;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const aLeft = a.left + a.offset, aRight = a.right + a.offset;
        const bLeft = b.left + b.offset, bRight = b.right + b.offset;
        const overlap = Math.min(aRight, bRight) - Math.max(aLeft, bLeft) + FILTER_CARD_GAP;
        if (overlap > 0) {
          const push = overlap / 2;
          if (aLeft <= bLeft) {
            a.offset -= push;
            b.offset += push;
          } else {
            a.offset += push;
            b.offset -= push;
          }
        }
      }
    }
  }

  rects.forEach(r => {
    const card = filterUICards[r.device];
    card.offsetX = r.offset;
    card.offsetWrapper.style.transition = 'transform 0.25s ease';
    applyCardOffsetAndScale(card);
  });
}

function showFilterCard(card) {
  if (card.hideTimer) {
    clearTimeout(card.hideTimer);
    card.hideTimer = null;
  }
  const el = card.root;
  el.style.display = 'flex';

  // ⚡ 避讓計算需要量到「展開完成後的最終大小」，而不是動畫途中還在放大的
  // 暫時尺寸，所以這裡先關掉 transition、直接跳到最終狀態量測，
  // 算好其它卡片該讓開多少之後，才切回「縮小透明」的起始狀態，
  // 真正開始播放展開動畫。這一切都在同一個畫面更新之前完成，肉眼不會看到閃爍。
  el.style.transition = 'none';
  el.style.transform = 'scale(1)';
  el.style.opacity = '1';

  resolveFilterCardOverlaps();

  el.style.transform = 'scale(0.4)';
  el.style.opacity = '0';
  void el.offsetWidth; // 強制reflow，確保「回到起始狀態」這個變化被瀏覽器真正套用
  el.style.transition = `transform ${FILTER_CARD_SHOW_MS}ms ease-out, opacity ${FILTER_CARD_SHOW_MS}ms ease-out`;
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'scale(1)';
  });
}

function hideFilterCard(card) {
  if (card.hideTimer) {
    clearTimeout(card.hideTimer);
    card.hideTimer = null;
  }
  // ⚡ 關閉水龍頭時要「俐落、立刻消失」，不要有動畫造成的停留感，
  // 所以直接把 display 設回 none，不等任何過渡效果播完。
  card.root.style.transition = 'none';
  card.root.style.display = 'none';

  // 這張卡片消失了，讓其它還顯示中的卡片鬆弛回真實位置（如果不再需要避讓）
  resolveFilterCardOverlaps();
}

function updateFilterCardVisibility(device) {
  const card = filterUICards[device];
  const st = filterState[device];
  if (!card || !st || !card.cssObject) return;

  let shouldShow = false;

  if (st.isActive) {
    card.cssObject.getWorldPosition(_filterCardWorldPos);

    // 只看是否落在畫面（視野）範圍內，不限制距離、也不再做遠近縮放
    _filterCardWorldPos.project(camera);
    shouldShow =
      _filterCardWorldPos.z < 1 &&
      _filterCardWorldPos.x >= -1 && _filterCardWorldPos.x <= 1 &&
      _filterCardWorldPos.y >= -1 && _filterCardWorldPos.y <= 1;
  }

  if (shouldShow !== !!card.isVisible) {
    card.isVisible = shouldShow;
    if (shouldShow) showFilterCard(card);
    else hideFilterCard(card);
  }

  if (card.isVisible) {
    applyCardOffsetAndScale(card);
  }
}

function updateFilterUIVisibility() {
  FILTER_DEVICES.forEach(device => updateFilterCardVisibility(device));
}

// ── 濾心低量警告彈窗（跟出水超時警告分開，樣式用同一套風格但改用藍色系區分）──
async function markFilterLowAlert(device) {
  if (!LINE_NOTIFY_ENABLED) return;
  await authReadyPromise;
  try {
    await set(ref(db, `filterAlerts/${device}`), {
      status: 'filter_low_alert',
      notified: false,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn('[Firebase] 寫入濾心低量警告失敗', err);
  }
}

const filterWarningModal = document.createElement('div');
Object.assign(filterWarningModal.style, {
  display: 'none',
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'rgba(0, 90, 130, 0.93)',
  color: 'white',
  padding: '28px 40px',
  borderRadius: '12px',
  fontSize: '20px',
  fontWeight: 'bold',
  textAlign: 'center',
  zIndex: '999',
  boxShadow: '0 0 30px rgba(0,180,255,0.8)',
  border: '2px solid #00cfff',
  minWidth: '300px',
  lineHeight: '1.6',
  pointerEvents: 'auto',
});
document.body.appendChild(filterWarningModal);

const filterWarningText = document.createElement('div');
filterWarningModal.appendChild(filterWarningText);

const filterWarningCloseBtn = document.createElement('button');
filterWarningCloseBtn.innerText = '我知道了';
Object.assign(filterWarningCloseBtn.style, {
  padding: '8px 24px', cursor: 'pointer', background: 'white', color: '#005a82',
  border: 'none', borderRadius: '6px', fontWeight: 'bold', fontSize: '15px',
  display: 'block', margin: '16px auto 0',
});
filterWarningCloseBtn.onclick = () => {
  filterWarningModal.style.display = 'none';
  if (menuPanel.style.display !== 'flex') setTimeout(() => controls.lock(), 80);
};
filterWarningModal.appendChild(filterWarningCloseBtn);

const filterReplaceBtn = document.createElement('button');
filterReplaceBtn.innerText = '已更換濾心，重新計時';
Object.assign(filterReplaceBtn.style, {
  padding: '8px 24px', cursor: 'pointer', background: '#005a82', color: 'white',
  border: 'none', borderRadius: '6px', fontWeight: 'bold', fontSize: '15px',
  display: 'block', margin: '10px auto 0',
});
filterReplaceBtn.onclick = () => {
  const device = filterReplaceBtn.dataset.device;
  resetFilterUsage(device);
  filterWarningModal.style.display = 'none';
  if (menuPanel.style.display !== 'flex') setTimeout(() => controls.lock(), 80);
};
filterWarningModal.appendChild(filterReplaceBtn);

function showFilterWarning(device) {
  const label = DEVICE_LABEL[device] ?? device;
  filterWarningText.innerHTML =
    `💧 濾心即將到期<br>
     <span style="color:#aef2ff;font-size:22px">${label}</span><br>
     濾心剩餘容量已低於 <span style="color:#aef2ff">5%</span>！<br>
     請盡快更換濾心。`;
  filterWarningCloseBtn.dataset.device = device;
  filterReplaceBtn.dataset.device = device;
  filterWarningModal.style.display = 'block';
  controls.unlock();
  markFilterLowAlert(device); // 寫入 Firebase，Apps Script 端輪詢到後會推播 LINE 通知
}

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
  collectBulbs();
  applyDayNight(parseFloat(daySlider.value));
  currentBulbStrength = targetBulbStrength;
  applyBulbStrength(currentBulbStrength);

  // ⚡ 修正「走到客廳突然爆衝一下」：composer.render() 只會編譯目前相機視野內
  // 看得到的材質 shader，起始位置(走道)看不到的客廳磚牆/發光燈框(RectAreaLight)/
  // 沙發等材質，會拖到玩家走過去、第一次真正進入視野時才臨時編譯，
  // 這個編譯動作是同步阻塞主執行緒的，一次可能卡住幾百毫秒。
  // 而移動迴圈的 delta 有 Math.min(time - prevTime, 0.1) 這個上限（見動畫迴圈），
  // 代表卡頓恢復的那一幀，會直接套用長達 0.1 秒份量的移動速度，
  // 感覺上就像「頓一下、然後瞬間往前衝一段」。
  //
  // ⚡ 但原本這裡直接傳入玩家「起始位置的 camera」去編譯，還是只涵蓋
  // 走廊那個視野看得到的材質——compile()/compileAsync() 內部判斷「要不要
  // 編譯某個物件」，用的是跟正式 render() 一樣的視錐體剔除(frustum culling)，
  // 所以客廳等「起始視角根本看不到」的房間，材質依然完全沒被編譯到，
  // bug 沒有真正解決。
  //
  // 改成造一台「上帝視角」的假攝影機：架在整棟房子正上方、由上往下俯瞰，
  // 視野涵蓋整個房子的水平範圍與高度，用這台假攝影機去編譯，
  // 不管客廳、臥室、樓上樓下，只要在房子範圍內都會落在視野裡，
  // 一次全部編譯完。編譯完這台假攝影機就直接丟掉，不影響玩家實際畫面。
  const sceneBox = new THREE.Box3().setFromObject(scene);
  const sceneSize = new THREE.Vector3();
  const sceneCenter = new THREE.Vector3();
  sceneBox.getSize(sceneSize);
  sceneBox.getCenter(sceneCenter);

  // 用正交攝影機（Orthographic）而非透視攝影機：正交攝影機的視野是一個
  // 方方正正的箱子，範圍設定直觀好算，不用擔心透視角度算錯導致邊緣物件
  // 漏出視野外；left/right/top/bottom 直接對應房子的水平範圍（X/Z），
  // 各留 2 公尺餘裕避免邊界物件卡在剛好被裁掉的邊緣。
  const MARGIN = 2;
  const halfX = sceneSize.x / 2 + MARGIN;
  const halfZ = sceneSize.z / 2 + MARGIN;
  const compileCamera = new THREE.OrthographicCamera(
    -halfX, halfX, halfZ, -halfZ,
    0.1, sceneSize.y + MARGIN * 2
  );
  // 架在房子最高點再往上一點的正上方，垂直往下看，near/far 涵蓋整個房子高度
  compileCamera.position.set(sceneCenter.x, sceneBox.max.y + MARGIN, sceneCenter.z);
  compileCamera.lookAt(sceneCenter.x, sceneBox.min.y, sceneCenter.z);
  compileCamera.updateMatrixWorld();

  // ⚡ compile()/compileAsync() 只會編譯 shader「程式」，不會把材質
  // 用到的「貼圖」真正上傳到 GPU（貼圖上傳/產生 mipmap 通常是等材質第一次
  // 真的被畫出來才會做）。這裡額外用同一台上帝視角攝影機，把整個場景
  // 實際「渲染一次」到一個看不見的離屏畫布（WebGLRenderTarget）上，
  // 強迫所有貼圖也在載入階段一次上傳完。渲染完立刻 dispose 釋放，不會留在記憶體。
  function warmUpTexturesAndPrograms() {
    const warmupTarget = new THREE.WebGLRenderTarget(64, 64); // 尺寸不重要，只是要觸發實際繪製
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(warmupTarget);
    renderer.render(scene, compileCamera);
    renderer.setRenderTarget(prevTarget);
    warmupTarget.dispose();

    // ⚡ 修正「setProgram 佔 30% 時間、還是會卡」的關鍵漏洞：
    // 上面 renderer.render() 只會暖機「場景本身材質」的 shader，
    // 但遊戲實際渲染時走的是 composer.render()（EffectComposer +
    // RenderPass + UnrealBloomPass），這條後製特效管線用的是完全
    // 獨立的一組 shader（模糊、合成等），從來沒被暖機過，玩家真正
    // 點擊開始、composer 第一次真的跑起來時，這組 shader 才臨時
    // 編譯，就是殘留卡頓的來源。這裡額外讓 composer 也跑一次，
    // 讓這組後製 shader 一起在載入階段編譯完成。
    //
    // composer 內部的 RenderPass 是綁定「真正的玩家攝影機」camera，
    // 不是我們的 compileCamera，所以這裡不需要（也無法簡單）換攝影機，
    // 直接用當下的 camera 跑一次即可——後製特效的 shader 種類是固定的，
    // 跟場景內容/攝影機位置無關，跑一次就能讓這組 shader 全部就緒。
    // 注意：composer.render() 內部每個 pass 會自行決定渲染目標
    // （最後一個 pass 預設畫到螢幕），這裡就算想重導到離屏目標也無效，
    // 但此時畫面外層還蓋著全黑的 blackCover DOM 圖層，玩家看不到
    // 這一幀，不需要額外處理。
    composer.render();
  }

  // ⚡ 修正時序 bug：原本 _origOnLoad()（也就是 finishLoading，負責讓黑幕
  // 淡出、顯示「點擊畫面開始」）是在這個 function 一開頭就立刻同步執行，
  // 但下面的 shader 編譯/貼圖熱身卻是「非同步」的，晚一點才會真正完成。
  // 這代表玩家手速夠快的話，很可能在編譯真正做完之前就已經點擊開始、
  // 開始走動了——等於帶著還在背景偷跑的編譯工作進場，第一趟自然還是會卡，
  // 直到真正跑完一輪之後才會變得滑順（也就是「回程忽然變超快/超滑順」
  // 這個體感落差的真正原因）。
  // 改成把 _origOnLoad() 移到這裡：確定 shader 編譯 + 貼圖熱身都「真正」
  // 完成之後才呼叫，玩家會多在黑幕/loading畫面停留一點點時間，
  // 但换來的是一進場走第一趟就是完全滑順的體驗，不會有「要走過一輪
  // 才會變快」這種不一致的感受。
  function revealGameAfterWarmup() {
    warmUpTexturesAndPrograms();
    // ⚡ 額外保險：非同步 shader 編譯（KHR_parallel_shader_compile）的
    // Promise 有時會比 GPU 驅動端真正處理完稍微早一點 resolve，這裡
    // 用 requestAnimationFrame 多等兩幀，給驅動一點點緩衝時間把背景
    // 工作徹底做完，再揭曉遊戲。這不是「猜一個固定時間」treat 症狀，
    // 而是在確定該做的暖機動作都做完之後，再留一個很小的安全邊際。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        _origOnLoad?.();
      });
    });
  }

  // ⚡ 修正「有開 DevTools 錄 Performance 就順、沒開就卡，且跟等待
  // 時間長短無關」的關鍵問題：
  // compileAsync() 依賴 KHR_parallel_shader_compile 擴充，讓 shader
  // 編譯丟到瀏覽器背景執行緒處理，只用「非阻塞查詢完成狀態」的方式
  // 檢查有沒有做完，不會真的強制等待。背景執行緒能分到多少 CPU 時間，
  // 是由瀏覽器動態排程決定的——開著 DevTools 錄製 Performance 時，
  // Chrome 會拉高該分頁處理程序的優先度（讓錄到的數據更準確），
  // 背景編譯執行緒才因此分到足夠 CPU 時間、真的編譯完成；沒開
  // DevTools 時，這個背景執行緒優先度較低，就算多等再久，也可能
  // 因為排程機制的關係一直沒有真正編譯完成。
  // 這種「背景執行緒優先度」完全不受 JavaScript 控制，所以乾脆不要
  // 依賴 compileAsync，改成只用同步的 renderer.compile()——同步版本
  // 內部呼叫的是傳統、真正會阻塞的 GPU 指令（不透過那個非阻塞查詢
  // 完成狀態的擴充），保證回傳的當下就是 100% 真的編譯完成，不受
  // 任何背景排程優先度影響。這裡執行時黑幕還沒淡出，玩家看不到這段
  // 同步卡頓，只是 loading 畫面停留久一點點，不影響遊戲進行中的流暢度。
  renderer.compile(scene, compileCamera);
  revealGameAfterWarmup();
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
  height: '48px',           // ⚡ 固定高度，跟離開鈕統一
  boxSizing: 'border-box',  // ⚡ padding 不會撐大總高度
  background: 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(6px)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '40px',
  padding: '0 22px',        // ⚡ 上下 padding 交給 height + align-items 處理
  zIndex: '300',
  pointerEvents: 'none',
  userSelect: 'none',
  opacity: '0',
  transition: 'opacity 0.3s ease',
});
document.body.appendChild(sliderWrap);

sliderWrap.appendChild(Object.assign(document.createElement('span'), {
  textContent: '🌙', style: 'font-size:22px'
}));

const daySlider = document.createElement('input');
Object.assign(daySlider, { type: 'range', min: '0', max: '100', value: '15' });
Object.assign(daySlider.style, { width: '200px', cursor: 'pointer', accentColor: '#ffd97a' });
sliderWrap.appendChild(daySlider);

// ── 管路透視模式：記錄進入前的日夜滑桿數值，用於還原 ──
const DEFAULT_DAY_VALUE = 50;
const XRAY_TONE_EXPOSURE = 0.3;      // 數字越小越暗，可自行調整
const XRAY_AMBIENT_INTENSITY = 0.2;  // 同上
let daySliderValueBeforeXRay = null;

sliderWrap.appendChild(Object.assign(document.createElement('span'), {
  textContent: '☀️', style: 'font-size:22px'
}));

// ── 核心日夜函式 ──
// ⚡ 燈泡開關的門檻，直接用「滑桿刻度」來定義，好懂、好調：
// 滑桿到達這個值（或對稱的 100-這個值）時，燈開始亮。
// 因為亮度公式是 elevRatio = sin(n × π)，sin 函式左右對稱，
// 所以只要設一個滑桿值，兩側（例如 30 跟 70）會自動同時生效，不用分開設定。
const LIGHTS_ON_SLIDER_VALUE = 30;
const LIGHTS_ON_ELEV_RATIO = Math.sin((LIGHTS_ON_SLIDER_VALUE / 100) * Math.PI);
// ⚡ 改版：滑桿左到右改成「日落最暗 → 正午最高最亮 → 日出（方位角與日落相對）」。
// 原本 n（0→1）同時拿來當「太陽仰角進度」跟「整體亮度」兩種用途，兩者都是
// 單調線性遞增。現在太陽仰角要變成「兩端低、中間高」的弧線（左右都在地平線，
// 中間最高），如果亮度還是直接用線性的 n 來算，會變成「中間暗、右邊卻最亮」，
// 跟實際太陽仰角對不上。所以拆成兩個獨立變數：
//   n        ：滑桿原始進度（0→1），只用來算「方位角」（決定太陽在左右哪一側）
//   elevRatio：太陽仰角的弧線進度（0→1→0），拿來算亮度/色溫/曝光等所有跟
//              「太陽有多高」相關的視覺效果，兩端都低、中間最高，左右對稱。
function applyDayNight(t) {
  const n = t / 100;   // 0 = 左（日落方位）, 0.5 = 中（正午）, 1 = 右（日出方位）

  // ── 1. 太陽仰角與方位角 ──────────────────────────────────
  // 仰角：兩端 0°（地平線）、中間 45°（最高），呈左右對稱的弧線。
  const MAX_ELEVATION = Math.PI / 4;   // 45°，跟原本「中午最亮」時的仰角一致
  const elevation = Math.sin(n * Math.PI) * MAX_ELEVATION;
  // 仰角進度（0→1→0），取代原本直接用 n 當亮度依據；中間（n=0.5）為 1，兩端為 0。
  const elevRatio = elevation / MAX_ELEVATION;

  // 方位角：從「日落」方位（+75°）線性轉到「日出」方位（-75°），中間（正午）
  // 剛好經過 0°（正前方）。-75° 跟 +75° 左右對稱，符合「日出跟日落相對角」。
  const SUNSET_AZIMUTH = THREE.MathUtils.degToRad(75);
  const azimuth = SUNSET_AZIMUTH * (1 - 2 * n);
  const dist = 60;

  const sx = Math.cos(elevation) * Math.sin(azimuth) * dist;
  const sy = Math.sin(elevation) * dist;
  const sz = +Math.cos(elevation) * Math.cos(azimuth) * dist;

  sunLight.position.set(sx, sy, sz);
  sunMesh.position.set(sx, sy, sz);

  // ── 2. 太陽光強度：隨仰角進度變化，兩端（日出/日落）幾乎為 0 ──────
  sunLight.intensity = Math.sin(elevation) * 3.6;

  // ── 3. 太陽色溫：地平線橙紅 → 高空暖白，用仰角進度（兩端都偏橙紅）──
  const dawnColor = new THREE.Color(0xffd0a0);
  const noonColor = new THREE.Color(0xfff5e0);
  const sunColor = dawnColor.clone().lerp(noonColor, elevRatio);
  sunLight.color.copy(sunColor);
  sunMesh.material.color.copy(sunColor);

  // ── 4. 渲染曝光：地平線暗 → 高空亮，用仰角進度 ──────────────
  renderer.toneMappingExposure = 0.2 + elevRatio * 1.0;   // 0.2 → 1.2

  // ── 5. 環境光：隨仰角進度增強 ────────────────────────────────
  const ambLight = scene.children.find(o => o.isAmbientLight);
  if (ambLight) ambLight.intensity = 0.005 + elevRatio * 0.5;

  // ── 6. 天空色：暗橙（地平線）→ 淺藍（高空），用仰角進度 ─────────
  if (scene.background instanceof THREE.Color) {
    scene.background.lerpColors(
      new THREE.Color(0x0d0503),   // 近黑暗橙
      new THREE.Color(0x87ceeb),   // 晴天藍
      elevRatio
    );
  }

  // ── 7. 室內燈泡：太陽低（兩端，日出/日落附近）時維持開燈，正午附近熄滅 ──
  // 開關門檻對應滑桿 LIGHTS_ON_SLIDER_VALUE（目前 30）跟其對稱點（70）。
  if (elevRatio <= 0.5) {
    const refExp = 1.8;
    const curExp = 1.3 + elevRatio;
    targetBulbStrength = Math.min(refExp / curExp, 3.0);
  } else if (elevRatio <= LIGHTS_ON_ELEV_RATIO) {
    targetBulbStrength = 1.0
  } else {
    targetBulbStrength = 0.0;
  }
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
        // ⚡ 效能優化：這裡每一幀都可能執行（燈光漸變期間），
        // opacity 不影響 shader 編譯，拿掉 needsUpdate 可省下大量重複驗證成本
        // c.material.needsUpdate = true;
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
  if (menuPanel.style.display === 'flex') {
    closeMenu();
    return;
  }

  if (!controls.isLocked) {
    hideTapPrompt();
    fadeOutBlackCover(); // ⚡ 使用者點擊時也主動確保渲染已開啟，避免手滑秒點造成畫面空窗
    controls.lock();
    return;
  }

  // 已鎖定 → raycaster 互動
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

  // 門 click 事件
  const doorIntersects = raycaster.intersectObjects(doorObjects);
  if (doorIntersects.length) {
    let obj = doorIntersects[0].object;
    while (obj && !obj.name.toLowerCase().includes('sliding_door') && !obj.name.toLowerCase().includes('sliding_up_door') && !obj.name.toLowerCase().includes('turn_up_door') && !obj.name.toLowerCase().includes('door_')) {
      obj = obj.parent;
    }
    const doorName = obj?.name.toLowerCase();
    const anim = doorAnimations[doorName];
    if (anim) {
      const newIsOpen = !anim.isOpen;
      anim.direction = newIsOpen ? 1 : -1;
      anim.isOpen = newIsOpen;

      // ⚡ 連動門：同一組的門一起開關（例如雙開大門）
      const partners = DOOR_PARTNER_MAP[doorName] || [];
      partners.forEach(partnerName => {
        const partnerAnim = doorAnimations[partnerName];
        if (partnerAnim && partnerAnim.isOpen !== newIsOpen) {
          partnerAnim.direction = newIsOpen ? 1 : -1;
          partnerAnim.isOpen = newIsOpen;
        }
      });

      // ⚡ 修正：使用者按過「其中一扇」有教學提示的門就該永久消失，
      // 但原本只檢查「直接點擊」的那扇門名稱（doorName），沒有把
      // 連動門（partners，例如雙開門的另一片）也算進去——如果玩家
      // 點的是連動門的「另一片」，door_livingroom 會透過連動一起打開，
      // 但提示卻沒消失，因為 doorName 對不上。改成 doorName 本身
      // 或任何一個連動夥伴，只要有一個落在 DOOR_HINT_DEVICES 裡就算數。
      const namesAffected = [doorName, ...partners];
      if (DOOR_HINT_DEVICES.some(d => namesAffected.includes(d.name))) {
        dismissDoorHintPermanently();
      }
    }
    return;
  }


  const intersects = raycaster.intersectObjects(interactiveDevices);
  if (!intersects.length) return;

  const targetName = intersects[0].object.name.toLowerCase();
  const cfg = PIPE_CONFIG[targetName];
  if (!cfg) return;

  // ⚡ 使用者實際按下這個開關了：不管是要打開還是關閉水，
  // 提示的任務已經達成，立刻讓魚形提示消失（見 dismissSwitchHint 內的節流說明）。
  dismissSwitchHint(targetName);

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
  setFilterActive(targetName, isNowActive);

  if (activeTimers[targetName]) {
    if (isNowActive) {
      activeTimers[targetName].startTime = Date.now();
      activeTimers[targetName].alerted = false;
      activeTimers[targetName].repeatMode = false; // 重新開水，從第一次的60秒門檻開始算
    } else {
      activeTimers[targetName].startTime = null;
      activeTimers[targetName].repeatMode = false;
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
const WARNING_MS = 60 * 1000; // 60 秒（原本誤寫成 10*1000，跟彈窗文字「已持續出水超過1分鐘」不符）
// ⚡ 使用者按過「我知道了」之後，改用比較長的重複提醒間隔，不用每60秒就再吵一次。
// 這個值只在 activeTimers[device].repeatMode === true 時才生效（也就是「已經確認過第一次警告」之後）。
const WARNING_REPEAT_MS = 10 * 60 * 1000; // 10 分鐘

// ─────────────────────────────────────────
// 渲染幀率上限
//
// 重要：這不是「等待載入」的修正，而是針對「開 F12 Performance 後變順」
// 這個現象做的修正。Performance 錄製有可能讓瀏覽器的畫面更新節奏
// 與平常不同；如果電腦/螢幕正在以 120/144/165Hz 執行，這個場景每幀
// 都要跑 EffectComposer + UnrealBloom + CSS2D + 粒子 + 碰撞，GPU/CPU
// 可能反而被高刷新率壓滿。
//
// 先固定遊戲主迴圈最高 60 FPS，讓「正常執行」盡量接近 Performance
// 錄製時的負載。如果這版不開 F12 就變順，就能確認原本問題不是
// shader 等待，而是高刷新率下的每幀負載。
// ─────────────────────────────────────────
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;
let lastRenderTimeMs = performance.now();

// Console 可輸入 window.GAME_TARGET_FPS 查看目前上限。
window.GAME_TARGET_FPS = TARGET_FPS;

let isAnimating = true;

function animate(nowMs) {

  if (!isAnimating) return;

  requestAnimationFrame(animate);

  // 在 120/144/165Hz 螢幕上，不讓整個遊戲邏輯與 GPU render 每秒執行
  // 120~165 次。只在達到 60 FPS 的時間點執行一次完整 frame。
  if (nowMs - lastRenderTimeMs < FRAME_INTERVAL) return;

  lastRenderTimeMs = nowMs;

  const time = nowMs / 1000;
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
      // 依每扇門各自記錄的滑動軸向(X、Z或Y)與方向(+1/-1)套用位移
      const offset = anim.slideSign * eased * anim.slideDistance;
      if (anim.slideAxis === 'z') {
        anim.mesh.position.z = anim.startZ + offset;
      } else if (anim.slideAxis === 'y') {
        anim.mesh.position.y = anim.startY + offset;
      } else {
        anim.mesh.position.x = anim.startX + offset;
      }
    } else if (anim.type === 'turn_up') {
      // 上掀式門：依 turnUpAxis 指定的軸（預設 X）旋轉，在「原本角度」基礎上疊加到 60 度
      const delta = (anim.turnUpSign ?? -1) * eased * TURN_UP_OPEN_ANGLE;
      if (anim.turnUpAxis === 'y') {
        anim.mesh.rotation.y = (anim.baseRotationY ?? 0) + delta;
      } else if (anim.turnUpAxis === 'z') {
        anim.mesh.rotation.z = (anim.baseRotationZ ?? 0) + delta;
      } else {
        anim.mesh.rotation.x = (anim.baseRotationX ?? 0) + delta;
      }
    } else {
      // 依每扇門各自記錄的開門方向(+1/-1)，在「原本角度」基礎上疊加旋轉
      // （原本直接覆蓋 rotation.y，若門本身在 Blender 裡角度未歸零會導致開關角度錯亂）
      anim.mesh.rotation.y = (anim.baseRotationY ?? 0) + (anim.swingSign ?? -1) * eased * Math.PI / 2;
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
  // ⚡ 效能優化：材質已共用（PIPE_MATERIALS），不用再逐一迴圈每根管路 mesh，
  // 只需要更新這 6 份共用材質的 opacity，就能同時影響所有使用它們的管路。
  if (isXRayMode) {
    const activeOpacity = 0.5 + Math.sin(time * 10) * 0.3;     // 出水：快速呼吸
    const inactiveOpacity = 0.35 + Math.sin(time * 1.5) * 0.1; // 未出水：慢速微光
    PIPE_MATERIALS.cold.active_shared.opacity = activeOpacity;
    PIPE_MATERIALS.cold.active_own.opacity = activeOpacity;
    PIPE_MATERIALS.drain.active_shared.opacity = activeOpacity;
    PIPE_MATERIALS.drain.active_own.opacity = activeOpacity;
    // PIPE_MATERIALS.cold.inactive.opacity = inactiveOpacity;
    // PIPE_MATERIALS.drain.inactive.opacity = inactiveOpacity;
  };

  // 內部計時 → 第一次超過60秒跳警告，確認過後改成每WARNING_REPEAT_MS再跳一次
  for (const key in activeTimers) {
    const timer = activeTimers[key];
    if (timer.startTime && !timer.alerted) {
      const threshold = timer.repeatMode ? WARNING_REPEAT_MS : WARNING_MS;
      if (Date.now() - timer.startTime >= threshold) {
        timer.alerted = true;
        showWarning(key);
      }
    }
  }

  // ⚡ 濾心用量累加：只在該裝置目前正在出水時才累加 delta（成本極低，單純加法）。
  // 但「更新圓環UI」跟「寫入Firebase」都各自節流，不會每一幀都做，詳見常數區塊說明。
  for (const device of FILTER_DEVICES) {
    const st = filterState[device];
    if (!st.isActive || !st.ready) continue;

    // ⚡ 封頂在 FILTER_LIFETIME_SECONDS（2000小時）：一旦用量達到上限，
    // 就不再繼續往上加，維持在 2000 小時／剩餘 0%，直到使用者按下
    // 「已更換濾心，重新計時」（resetFilterUsage）才會清零重新開始累加。
    // 這樣即使忘記換濾心、水龍頭繼續使用，數字也不會無限累加變成負百分比。
    if (st.remoteTotal + st.pendingDelta < FILTER_LIFETIME_SECONDS) {
      st.pendingDelta += delta;
    }
    st.usedSeconds = Math.min(st.remoteTotal + st.pendingDelta, FILTER_LIFETIME_SECONDS);
    st.uiElapsed += delta;
    st.saveElapsed += delta;

    if (st.uiElapsed >= FILTER_UI_UPDATE_INTERVAL) {
      st.uiElapsed = 0;
      updateFilterUI(device);

      const remainRatio = 1 - st.usedSeconds / FILTER_LIFETIME_SECONDS;
      if (remainRatio <= FILTER_LOW_RATIO && !st.alerted) {
        st.alerted = true;
        showFilterWarning(device);
        saveFilterUsage(device); // 立刻存檔記錄「已經跳過警告」，避免重整頁面又跳一次
      }
    }

    if (st.saveElapsed >= FILTER_SAVE_INTERVAL) {
      st.saveElapsed = 0;
      saveFilterUsage(device);
    }
  }

  // ⚡ 效能優化：UI 更新節流至每 0.15 秒一次
  filterCardVisibilityElapsed += delta;
  if (filterCardVisibilityElapsed >= FILTER_CARD_VISIBILITY_INTERVAL) {
    filterCardVisibilityElapsed = 0;
    updateFilterUIVisibility();
  }

  // ⚡ 開關靠近提示：距離判斷節流至每 SWITCH_HINT_CHECK_INTERVAL(0.2) 秒一次，
  // 不需要每一幀都算，詳見 updateSwitchHintVisibility() 上方的效能說明。
  switchHintCheckElapsed += delta;
  if (switchHintCheckElapsed >= SWITCH_HINT_CHECK_INTERVAL) {
    switchHintCheckElapsed = 0;
    updateSwitchHintVisibility();
  }

  // ⚡ 客廳門靠近提示：裝置數量少，每幀直接算一次距離即可，
  // 不需要額外的節流變數，詳見 updateDoorHintsVisibility() 上方的效能說明。
  updateDoorHintsVisibility();

  // 移動
  if (controls.isLocked) {
    // ⚡ 保險機制：就算某一幀因為任何原因（貼圖上傳、GC、分頁切回前景等）
    // 卡了一大段時間，移動用的 delta 也只封頂在 0.05 秒（約 3 倍正常 frame），
    // 不會再用到最上面 Math.min(time - prevTime, 0.1) 那個較寬鬆的 0.1 秒上限。
    // 其他系統（濾心計時、門動畫等）不受影響，仍使用原本的 delta，避免時間累計失準。
    const moveDelta = Math.min(delta, 0.05);

    velocity.x -= velocity.x * 10.0 * moveDelta;
    velocity.z -= velocity.z * 10.0 * moveDelta;

    direction.z = Number(moveForward) - Number(moveBackward);
    direction.x = Number(moveLeft) - Number(moveRight);

    // ⚡ 效能優化：先判斷是否有輸入，避免無意義的計算
    const hasInput = moveForward || moveBackward || moveLeft || moveRight || (isHoldWalking && !isTouchMoving);

    if (hasInput) {
      direction.normalize();

      if (moveForward || moveBackward) velocity.z -= direction.z * 40.0 * moveDelta;
      if (moveLeft || moveRight) velocity.x -= direction.x * 40.0 * moveDelta;

      if (isHoldWalking && !isTouchMoving) {
        velocity.z -= 3.0;
      }
    }

    const moveVelocity = new THREE.Vector3(
      velocity.x * moveDelta,
      0,
      velocity.z * moveDelta
    );
    moveVelocity.applyQuaternion(camera.quaternion);
    moveVelocity.y = 0;

    // ⚡ 只在有移動時才執行碰撞檢測
    if (!isOnStairRail && moveVelocity.lengthSq() > 0.000001) {
      handleMovementAndCollision(moveVelocity);
    }
    updateStaircase(delta);
    // ...
  }

  //水池載浮載沉效果
  // ── 水池效果：進入 floor_pool_water 範圍時絲滑下沉 + 漂浮 ──
  const inPool = !isNoclipMode && isCameraInPool();
  waterDepthTarget = inPool ? WATER_SINK_DEPTH : 0;

  // ⚡ 偵測「剛入水」「剛出水」的那一瞬間，各觸發一次性的動作
  if (inPool && !wasInPool) {
    // 剛入水：把「目前下沉量」瞬間拉到比停留深度更深，
    // 之後下面既有的 lerp 就會自然把它拉回 WATER_SINK_DEPTH，形成「先下墜、再浮起」的感覺
    waterDepthCurrent = WATER_SINK_DEPTH + WATER_ENTRY_OVERSHOOT;
  } else if (!inPool && wasInPool) {
    // 剛出水：把「目前下沉量」瞬間拉到負值（代表比一般地面高度還高），
    // 之後下面既有的 lerp 就會自然把它拉回 0（一般行進高度），形成「先躍起、再落地」的感覺
    waterDepthCurrent = -WATER_EXIT_JUMP;
  }
  wasInPool = inPool;

  camera.position.y += appliedWaterOffset;   // 先抵銷上一幀套用的下沉量

  // ⚡ 判斷目前是不是在「超衝後回彈」的過程中，用專屬速度取代一般的 WATER_SINK_LERP_SPEED，
  // 這樣下墜/躍起的節奏就能跟平常泡在水裡的絲滑漂浮速度分開調整
  let waterLerpSpeed = WATER_SINK_LERP_SPEED;
  if (inPool && waterDepthCurrent > waterDepthTarget) {
    waterLerpSpeed = WATER_ENTRY_RECOVER_SPEED;   // 正在從入水下墜往回浮
  } else if (!inPool && waterDepthCurrent < waterDepthTarget) {
    waterLerpSpeed = WATER_EXIT_RECOVER_SPEED;    // 正在從出水躍起往下落
  }
  waterDepthCurrent += (waterDepthTarget - waterDepthCurrent) * Math.min(waterLerpSpeed * delta, 1.0);

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

  // ⚡ 黑幕蓋著時完全跳過場景渲染：使用者看不到，渲染等於白工，
  // 把這段 GPU/CPU 時間讓給葉子提示動畫的 requestAnimationFrame，
  // 徹底解決兩者搶執行緒時間造成的每幀卡頓
  if (sceneRenderEnabled) {
    composer.render();
    labelRenderer.render(scene, camera);
  }
}
requestAnimationFrame(animate);

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

// ⚡ 關閉分頁/重新整理前，補存一次還在出水中的裝置濾心用量（best-effort：
// 非同步的 Firebase 寫入不保證能在頁面關閉前送出，但能大幅降低漏記的機率，
// 反正下次開水時 FILTER_SAVE_INTERVAL 節流也還是會繼續存，不會累積成大問題）
window.addEventListener('beforeunload', () => {
  FILTER_DEVICES.forEach(device => {
    if (filterState[device]?.isActive) saveFilterUsage(device);
  });
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
          hideTapPrompt();
          fadeOutBlackCover();
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

// ─────────────────────────────────────────
// 結束畫面環境動畫：葉子持續搖晃 ＋ 橘色魚群隨機游動
// ⚡ 這裡只操作幾個 DOM 元素的 CSS transform，而且只有在 exitApp() 已經把
// isAnimating 設成 false（3D 渲染/碰撞/移動主迴圈完全停掉）之後才會啟動，
// 所以效能成本可以忽略不計，不用像走道/客廳那段那樣顧慮 shader 編譯或 delta 爆衝。
// ─────────────────────────────────────────

let endScreenRafId = null;
let endScreenAmbience = null; // { layer, leaves, fish, startTime }

function createEndScreenAmbience(container) {
  const layer = document.createElement('div');
  layer.id = 'end-screen-ambience'; // 樣式定義在 style.css 的 #end-screen-ambience（position/inset/z-index 等固定屬性都在那裡）
  // ⚡ 刻意掛在 document.body 底下（而不是掛進 container 裡面），
  // 避免 container 或它的祖先若被外部 CSS 設定 transform / filter / overflow:hidden，
  // 導致這個 position:fixed 圖層被裁切或定位跑掉（fixed 定位在有 transform 的祖先底下
  // 會改成相對該祖先定位，等於失去「蓋滿整個視窗」的效果）。
  document.body.appendChild(layer);

  // ── 葉子：重用原本 tap 提示的搖晃邏輯，改成多片、隨機位置/週期，看起來才自然 ──
  const LEAF_COUNT = 6;
  const leaves = [];
  for (let i = 0; i < LEAF_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'end-leaf'; // 固定樣式（position/will-change）在 style.css
    el.textContent = '🌿';
    // 以下都是每片葉子隨機不同的數值，維持用 inline style 設定
    Object.assign(el.style, {
      left: `${5 + Math.random() * 90}%`,
      top: `${5 + Math.random() * 85}%`,
      fontSize: `${20 + Math.random() * 20}px`,
      opacity: `${0.5 + Math.random() * 0.4}`,
    });
    layer.appendChild(el);
    leaves.push({
      el,
      duration: 2200 + Math.random() * 1600, // 2.2~3.8s 一輪，每片節奏不同才不會整齊劃一
      phaseOffset: Math.random() * Math.PI * 2,
      rotateAmp: 3 + Math.random() * 4,        // 度
      translateAmp: 1.5 + Math.random() * 2.5, // px
      baseScale: 0.8 + Math.random() * 0.5,
    });
  }

  // ── 魚：橘色橢圓 + 會擺動的尾鰭，隨機游動（steering wander：每幀小幅隨機轉向，碰邊界自然反彈）──
  const FISH_COUNT = 5;
  const fish = [];
  for (let i = 0; i < FISH_COUNT; i++) {
    const w = 22 + Math.random() * 18;
    const h = w * 0.45;

    // 外層：只負責「位置＋朝向」，身體跟尾巴都是它的子元素，
    // 這樣尾巴的擺動角度會疊加在魚朝向之上，不用自己重算方向。
    const el = document.createElement('div');
    el.className = 'end-fish'; // 固定樣式（position/left/top/will-change）在 style.css
    Object.assign(el.style, {
      width: `${w}px`,
      height: `${h}px`,
    });

    // 魚身體（橢圓）── 固定樣式（inset/border-radius/background/box-shadow）都在 style.css 的 .end-fish-body
    const body = document.createElement('div');
    body.className = 'end-fish-body';

    // ⚡ 只需要調整兩組數據：中間一組、左右共用一組（左右兩片除了分岔角度相反，
    // 長度/寬度/塞進身體多少都完全一樣）。想讓中間跟左右看起來不一樣，
    // 只要改 middleTailConfig 或 sideTailConfig 裡的數字即可。
    const forkAngle = 24; // 左右兩片的分岔角度（度），數字越大叉開越開

    const middleTailConfig = { tailLen: w * 0.93, tailWidth: h * 0.9, tailOverlap: w * 0.2 };
    const sideTailConfig   = { tailLen: w * 0.7, tailWidth: h * 0.7, tailOverlap: w * 0.1 };

    const tailConfigs = [
      { fork: 0,          ...middleTailConfig }, // 中間直的一片
      { fork: forkAngle,  ...sideTailConfig },    // 右側
      { fork: -forkAngle, ...sideTailConfig },    // 左側（跟右側共用同一組長寬/overlap數據）
    ];

    const tailEls = [];
    tailConfigs.forEach(({ fork, tailLen, tailWidth, tailOverlap }) => {
      const fin = document.createElement('div');
      fin.className = 'end-fish-tail'; // 固定樣式（transform-origin/clip-path/background/opacity）在 style.css
      // 以下是每片尾鰭依 tailLen/tailOverlap 算出來的隨機數值，維持用 inline style 設定
      Object.assign(fin.style, {
        left: `${-(tailLen - tailOverlap)}px`,
        width: `${tailLen}px`,
        height: `${tailWidth}px`,
      });
      el.appendChild(fin);
      tailEls.push({ el: fin, fork }); // 記住這片尾鰭的固定分岔角度，更新時要疊加擺動角度
    });

    el.appendChild(body); // body 最後掛，蓋住尾鰭塞進身體範圍內的那段接縫

    layer.appendChild(el);
    fish.push({
      el,
      tailEls, // [{el, fork}, {el, fork}]，取代原本單一的 tailEl
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      angle: Math.random() * Math.PI * 2,
      speed: 18 + Math.random() * 22,       // px/秒
      turnRate: 0.6 + Math.random() * 0.6,  // 每幀轉向弧度
      tailPhase: Math.random() * Math.PI * 2, // 每條魚擺動起始相位錯開，不會同步甩動
      tailAmp: 22 + Math.random() * 10,       // 擺動振幅（度）
    });
  }

  return { layer, leaves, fish, startTime: performance.now() };
}

function stepEndScreenAmbience(state, now, prevNow) {
  const dt = Math.min((now - prevNow) / 1000, 0.1);
  const elapsed = now - state.startTime;

  // 葉子搖晃
  for (const leaf of state.leaves) {
    const phase = ((elapsed % leaf.duration) / leaf.duration) * Math.PI * 2 + leaf.phaseOffset;
    const rotateDeg = Math.sin(phase) * leaf.rotateAmp;
    const translateXpx = Math.sin(phase) * leaf.translateAmp;
    const translateYpx = Math.cos(phase * 0.7) * (leaf.translateAmp * 0.6);
    leaf.el.style.transform =
      `translate(${translateXpx.toFixed(2)}px, ${translateYpx.toFixed(2)}px) ` +
      `scale(${leaf.baseScale.toFixed(2)}) rotate(${rotateDeg.toFixed(2)}deg)`;
  }

  // 魚隨機游動
  const w = state.layer.clientWidth || window.innerWidth;
  const h = state.layer.clientHeight || window.innerHeight;
  const margin = 24;

  for (const f of state.fish) {
    // 隨機小幅轉向，路徑才會自然、不規則（而不是繞固定圓形或直線）
    f.angle += (Math.random() - 0.5) * f.turnRate * dt;

    f.x += Math.cos(f.angle) * f.speed * dt;
    f.y += Math.sin(f.angle) * f.speed * dt;

    // 碰到邊界就把角度「反彈」回畫面內，而不是卡在邊緣抖動
    if (f.x < margin) { f.x = margin; f.angle = Math.PI - f.angle; }
    if (f.x > w - margin) { f.x = w - margin; f.angle = Math.PI - f.angle; }
    if (f.y < margin) { f.y = margin; f.angle = -f.angle; }
    if (f.y > h - margin) { f.y = h - margin; f.angle = -f.angle; }

    const deg = (f.angle * 180) / Math.PI;
    f.el.style.transform = `translate(${f.x.toFixed(1)}px, ${f.y.toFixed(1)}px) rotate(${deg.toFixed(1)}deg)`;

    // 尾鰭擺動：正弦波，速度越快擺得越快（模擬真實游動節奏）。
    // 兩片尾鰭共用同一個 wagDeg（整條尾巴一起甩），但各自疊加自己固定的分岔角度(fork)，
    // 這樣甩動時會維持 V 字分岔的形狀，而不是像剪刀一樣開合。
    const wagFreqHz = 1.2 + f.speed * 0.06; // 速度快→擺動頻率高
    const wagDeg = Math.sin(elapsed / 1000 * wagFreqHz * Math.PI * 2 + f.tailPhase) * f.tailAmp;
    f.tailEls.forEach(({ el: finEl, fork }) => {
      finEl.style.transform = `translateY(-50%) rotate(${(fork + wagDeg).toFixed(1)}deg)`;
    });
  }
}

function startEndScreenAmbience(container) {
  stopEndScreenAmbience(); // 保險：避免重複呼叫時疊加出多組 layer
  endScreenAmbience = createEndScreenAmbience(container);

  let prevNow = performance.now();
  function frame(now) {
    stepEndScreenAmbience(endScreenAmbience, now, prevNow);
    prevNow = now;
    endScreenRafId = requestAnimationFrame(frame);
  }
  endScreenRafId = requestAnimationFrame(frame);
}

function stopEndScreenAmbience() {
  if (endScreenRafId !== null) {
    cancelAnimationFrame(endScreenRafId);
    endScreenRafId = null;
  }
  if (endScreenAmbience) {
    endScreenAmbience.layer.remove();
    endScreenAmbience = null;
  }
}

function showCloseFallback() {
  let fallback = document.getElementById("close-fallback");

  if (fallback) {
    // ⚡ 元素已經存在（不管是先前呼叫過，還是 HTML 裡本來就有靜態版本），
    // 不重新建立文字內容（避免蓋掉你原本設計好的版面），
    // 但一定要確保葉子/魚環境動畫有掛上去，不能整個函式提早結束。
    if (!document.getElementById('end-screen-ambience')) {
      startEndScreenAmbience(fallback);
    }
    return;
  }

  fallback = document.createElement("div");
  fallback.id = "close-fallback";
  fallback.innerHTML = `
    <div class="close-fallback-box">
      <div class="close-fallback-icon">🌿</div>
      <div class="close-fallback-title">體驗結束，期待重逢</div>
      <div class="close-fallback-tip">To be continued</div>
    </div>
  `;
  document.body.appendChild(fallback);

  // ⚡ 保險：確保文字卡片會蓋在葉子/魚群 layer 之上，不論外部 CSS 有沒有設定過 z-index
  const box = fallback.querySelector('.close-fallback-box');
  if (box) {
    if (!box.style.position) box.style.position = 'relative';
    if (!box.style.zIndex) box.style.zIndex = '1';
  }

  // 這裡才啟動環境動畫：此時 exitApp() 早已把 isAnimating 設成 false，
  // 3D 主迴圈已停，效能完全不用顧慮。
  startEndScreenAmbience(fallback);
}

function exitApp() {
  // 1. 解除滑鼠鎖定
  if (document.pointerLockElement) {
    document.exitPointerLock();
  }

  // 2. 停止動畫迴圈，節省 CPU/GPU
  if (typeof isAnimating !== "undefined") {
    isAnimating = false;
  }

  // 3. 主動補存濾心用量
  if (typeof FILTER_DEVICES !== "undefined" && typeof filterState !== "undefined") {
    FILTER_DEVICES.forEach(device => {
      if (filterState[device]?.isActive) saveFilterUsage(device);
    });
  }

  // 4. 釋放 renderer 資源
  if (typeof renderer !== "undefined") {
    renderer.dispose();
  }

  // 5. 直接顯示結尾畫面，不嘗試關閉分頁
  showCloseFallback();
}

// ─────────────────────────────────────────
// ⚡ 重要：把 exitApp 掛到全域 window
// index.html 裡「離開遊戲」按鈕的 click 事件，是在一般 <script>（非 module）裡
// 用 addEventListener 呼叫全域的 exitApp()。但這裡是 <script type="module">，
// 模組內的 function/變數（包含這裡的 exitApp、isAnimating、renderer、
// 剛剛加的 startEndScreenAmbience 等）預設不會流到 window，
// 外面的一般 script 完全看不到、也叫不到。
// 如果 index.html 裡还留著它自己那份重複的 exitApp()/showCloseFallback()，
// 按鈕點下去執行的會是那份「看不到 isAnimating/renderer」的舊版本，
// 導致 3D 渲染迴圈實際上沒有真的停掉、也不會有葉子/魚動畫。
// 所以這裡手動把這個模組內的 exitApp 掛到 window，
// 並請務必把 index.html 裡重複定義的 exitApp()/showCloseFallback() 整段刪掉，
// 讓按鈕真正呼叫到這裡（唯一一份、行為完整）的版本。
window.exitApp = exitApp;
window.showCloseFallback = showCloseFallback;