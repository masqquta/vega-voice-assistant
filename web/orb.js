// Живой 3D-шар ассистента (вариант B): перламутровый шар, хромированный крюк, орбита.
//
//   import { mountOrb } from "./orb.js";
//   const orb = mountOrb(document.querySelector("canvas"));
//   orb.setState("listening");          // idle | listening | thinking | speaking
//   await orb.speak("Готово, напомню завтра в 10:00.");
//
// Голос анимирует шар (поверхность, свечение, кольца-волны), мышь/палец — крюк.
// Всё движение на пружинах с dt, поэтому не зависит от частоты кадров.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export const STATES = ["idle", "listening", "thinking", "speaking"];

// Где капсула в собственной плоскости крюка (см. blender/refine_b.py): дуга 250°→70°,
// стебель-клотоида уводит капсулу к ~102°. Поворот на (ψ − 90° − STEM) ставит её к курсору.
const STEM = THREE.MathUtils.degToRad(102);
const MAX_RINGS = 6;

function spring(st, target, k, c, dt) {               // st = {x, v}; c = 2√k — без перелёта
  st.v += ((target - st.x) * k - st.v * c) * dt;
  st.x += st.v * dt;
  return st.x;
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Студия для отражений, запекается в PMREM один раз.
 * Хром (bright = false): приглушённый тёплый купол, тёмный низ и линия горизонта — по контрасту
 * хром и читается как хром. Стекло (bright = true): светлый купол под белый фон и чёрные
 * флаги по бокам, как в предметной съёмке, — они рисуют тёмный контур прозрачного шара.
 */
function studioEnvironment(bright = false) {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: `varying vec3 vP;
      void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vP;
      void main(){
        float y = vP.y;
        vec3 top = ${bright ? "vec3(1.0, 0.99, 0.97), hor = vec3(0.86, 0.84, 0.82), low = vec3(0.4, 0.39, 0.38)"
                            : "vec3(0.52, 0.5, 0.47), hor = vec3(0.34, 0.31, 0.28), low = vec3(0.05, 0.045, 0.04)"};
        vec3 c = y > 0.0 ? mix(hor, top, pow(y, 0.7)) : mix(hor, low, pow(-y, 0.35));
        c *= 1.0 - 0.8 * smoothstep(0.05, 0.0, abs(y + 0.03));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })));
  const box = (w, h, power, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    m.material.color.setRGB(power, power * 0.97, power * 0.92);
    m.position.set(...pos); m.lookAt(0, 0, 0);
    env.add(m);
  };
  box(5, 3, 7, [-5, 6, 5]);       // ключевой сверху-слева
  box(1.2, 8, 6, [7, 1, -3]);     // контровая полоса справа
  box(8, 1, 3.5, [0, -2, 8]);     // низкая полоса спереди — блик снизу на хроме
  if (bright) {
    box(2.2, 12, 0.02, [-8, 0, -2]);  // чёрные флаги: тёмные дуги по краю стекла
    box(2.2, 12, 0.02, [8, 0, 1]);
  }
  return env;
}

/** Разбивает текст на «слоги» для волн, когда озвучка не даёт событий слов. */
function syllableTimeline(text) {
  const events = [];
  let at = 120;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const n = Math.max(1, (word.match(/[аеёиоуыэюяaeiouy]+/gi) || []).length);
    for (let i = 0; i < n; i++) {
      events.push({ at, strength: i === 0 ? 0.9 : 0.55 });
      at += 150;
    }
    at += /[.,!?:;—]$/.test(word) ? 320 : 90;
  }
  return events;
}

/**
 * Монтирует сцену в canvas. Возвращает API сразу; модель догружается асинхронно (orb.ready).
 * @param {HTMLCanvasElement} canvas
 * @param {object} [opts]
 * @param {string|ArrayBuffer} [opts.model]  URL GLB (по умолчанию orb-b.glb рядом с модулем) или готовые байты
 * @param {number} [opts.offsetY=0]          поднять шар в кадре (0.55 — место под пульт снизу)
 * @param {number} [opts.zoom=1]             крупность модели в кадре (1.35 — герой во весь экран)
 * @param {EventTarget} [opts.pointerTarget=window]  где слушать мышь
 * @param {boolean} [opts.mic=true]          в listening брать уровень с микрофона
 * @param {string|false} [opts.touchAction="none"]  touch-action для canvas; false — не трогать
 * @param {number|string} [opts.background=0xffffff]  цвет фона сцены (под цвет блока на сайте)
 * @param {string} [opts.lang="ru-RU"]       язык озвучки speak()
 * @param {(state: string) => void} [opts.onStateChange]
 */
// Самый живой голос языка: нейросетевые Edge («Online (Natural)», Светлана/Дарья) → Google → любой
function pickVoice(voices, lang) {
  const own = voices.filter((x) => x.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  const score = (x) => (/natural|online|neural/i.test(x.name) ? 4 : 0) + (/svetlana|dariya|светлана|дарья/i.test(x.name) ? 2 : 0)
    + (/google/i.test(x.name) ? 3 : 0) + (x.localService ? 0 : 1);
  return own.sort((a, b) => score(b) - score(a))[0] || null;
}

export function mountOrb(canvas, opts = {}) {
  const {
    model = new URL("./orb-b.glb", import.meta.url).href,
    offsetY = 0,
    zoom = 1,
    pointerTarget = window,
    mic = true,
    lang = "ru-RU",
    onStateChange = null,
  } = opts;
  const reducedMQ = matchMedia("(prefers-reduced-motion: reduce)");

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance",
    preserveDrawingBuffer: !!opts.preserveDrawingBuffer });   // только для скриншотов при отладке
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;   // ACES сжимает белый фон за стеклом в серый, Neutral держит белый
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Стеклу нужен непрозрачный фон: сквозь прозрачный canvas преломление берёт полупрозрачную подложку
  // и шар выглядит серым. Цвет фона = цвет блока на сайте.
  renderer.setClearColor(opts.background ?? 0xffffff, 1);
  if (opts.touchAction !== false) canvas.style.touchAction = opts.touchAction || "none";

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // мягкий свет для перламутра
  const envTex = pmrem.fromScene(studioEnvironment(), 0.02).texture;      // контрастная студия для хрома
  const glassEnv = pmrem.fromScene(studioEnvironment(true), 0.01).texture; // светлая студия с флагами для стекла
  scene.environment = roomTex;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
  key.position.set(-4, 6, 6);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0xd8cfc4, 0.6));

  // ---------- материалы ----------
  const chrome = new THREE.MeshStandardMaterial({ color: 0xf4f6fa, metalness: 1, roughness: 0.07, envMap: envTex, envMapIntensity: 1.2 });
  // Шар — прозрачный пузырь (как вариант A): крюк, пояс, кольцо и спутники видны сквозь него
  // с лёгким преломлением и дисперсией по краю; по плёнке течёт радуга.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.02, metalness: 0,
    transmission: 1, thickness: 1.1, ior: 1.3, dispersion: 2.5,   // линза: крюк за шаром гнётся с цветной каймой
    envMap: glassEnv, envMapIntensity: 1,
    clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 1,
    iridescence: 0.6, iridescenceIOR: 1.35, iridescenceThicknessRange: [220, 680],
    emissive: new THREE.Color(0x9a86ff), emissiveIntensity: 0,
  });
  // Поверхность шара: жидкая рябь + кольца-волны голоса (вершины, нормали пересчитываются),
  // радужная плёнка течёт: её толщина меняется бегущим шумом. Технологичный слой:
  // светящийся ободок по контуру (цвет состояния) и сканирующая линия в «думает».
  const U = {
    uTime: { value: 0 }, uFlow: { value: 0 }, uAmp: { value: 0 }, uFreq: { value: 2.4 },
    uRingScale: { value: 0.04 }, uRingGlow: { value: 0 },
    uListen: { value: 0 }, uThink: { value: 0 }, uSpeak: { value: 0 }, uLevel: { value: 0 }, uBeat: { value: 0 }, uSpin: { value: 0 },
    uRim: { value: 0 }, uRimColor: { value: new THREE.Color(0xffffff) }, uScan: { value: 0 }, uScanY: { value: 0 },
    uRingAge: { value: new Float32Array(MAX_RINGS).fill(99) },
    uRingAmp: { value: new Float32Array(MAX_RINGS) },
  };
  const NOISE = `
    vec4 perm(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
    float noise3(vec3 p){
      vec3 a = floor(p); vec3 d = p - a; d = d*d*(3.0-2.0*d);
      vec4 b = a.xxyy + vec4(0.0,1.0,0.0,1.0);
      vec4 k1 = perm(b.xyxy); vec4 k2 = perm(k1.xyxy + b.zzww);
      vec4 c = k2 + a.zzzz; vec4 k3 = perm(c); vec4 k4 = perm(c + 1.0);
      vec4 o1 = fract(k3*(1.0/41.0)); vec4 o2 = fract(k4*(1.0/41.0));
      vec4 o3 = o2*d.z + o1*(1.0-d.z); vec2 o4 = o3.yw*d.x + o3.xz*(1.0-d.x);
      return o4.y*d.y + o4.x*(1.0-d.y);
    }`;
  // кольца бегут от «лица» шара (+Z, к зрителю) к краям: горб + лёгкая впадина за ним.
  // sharp: ширина фронта — в вершинах широкая волна (сетка 64×32), в пикселях — тонкая светящаяся линия
  const RINGS = `
    uniform float uRingAge[${MAX_RINGS}], uRingAmp[${MAX_RINGS}];
    float rings(vec3 p, float sharp){
      float d = acos(clamp(normalize(p).z, -1.0, 1.0));
      float s = 0.0;
      for (int i = 0; i < ${MAX_RINGS}; i++) {
        float x = d - uRingAge[i] * 2.4;
        float env = uRingAmp[i] * exp(-uRingAge[i] * 1.3);
        float y = x + 1.0 / sqrt(sharp);
        s += env * (exp(-x*x*sharp) - 0.45*exp(-y*y*sharp));
      }
      return s * smoothstep(3.1, 2.2, d);
    }`;
  glass.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uTime, uAmp, uFreq, uRingScale, uListen, uThink, uSpeak, uLevel, uBeat, uSpin;
        varying vec3 vObj;
        ${NOISE}
        ${RINGS}
        float wob(vec3 p){
          return (noise3(p*uFreq + vec3(0.0, uTime*0.9, 0.0)) - 0.5)
               + 0.5*(noise3(p*uFreq*2.3 - vec3(uTime*1.3)) - 0.5);
        }
        // форма по состоянию (веса uListen/uThink/uSpeak плавно меняются пружинами):
        // слушает — по громкости шар раздаётся вширь, как диффузор, по контуру бежит тонкая корона волны;
        // думает  — три жидких лепестка вращаются вокруг вертикали и пульсируют в ритм;
        // говорит — на каждом слоге шар упруго вытягивается по вертикали и подаётся вперёд («артикулирует»).
        float atan2s(float y, float x){ return atan(y, abs(x) + abs(y) < 1e-5 ? 1e-5 : x); }  // без NaN на полюсах
        float shape(vec3 p){
          vec3 n = normalize(p);
          float front = max(n.z, 0.0); front *= front;
          float rim = 1.0 - n.z * n.z;
          float listen = 0.11 * uLevel * (n.x * n.x - 0.4 * n.y * n.y) + 0.05 * uLevel * front
                       + 0.02 * (0.4 + uLevel) * sin(9.0 * atan2s(n.y, n.x) - uTime * 6.0) * rim * rim;
          float think = (0.1 + 0.045 * uBeat) * cos(3.0 * (atan2s(n.z, n.x) - uSpin)) * (1.0 - n.y * n.y)
                      + 0.025 * sin(n.y * 7.0 + uSpin * 2.0);
          float speak = uLevel * (0.09 * n.y * n.y - 0.05 * n.x * n.x + 0.06 * front);   // вытягивается на слоге
          return uListen * listen + uThink * think + uSpeak * speak;
        }
        float disp(vec3 p){ return wob(p)*uAmp + rings(p, 14.0)*uRingScale + shape(p); }`)
      .replace("#include <beginnormal_vertex>", `
        vec3 n0 = normalize(normal);
        vec3 tg = normalize(cross(n0, abs(n0.y) < 0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));
        vec3 bt = cross(n0, tg);
        float e = 0.02;
        vec3 p0 = position + n0 * disp(position);
        vec3 p1 = position + tg*e; p1 += n0 * disp(p1);
        vec3 p2 = position + bt*e; p2 += n0 * disp(p2);
        vec3 objectNormal = normalize(cross(p1 - p0, p2 - p0));
        if (dot(objectNormal, n0) < 0.0) objectNormal = -objectNormal;
        vObj = position;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace("#include <begin_vertex>", "vec3 transformed = p0;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uFlow, uRingGlow, uRim, uScan, uScanY;
        uniform vec3 uRimColor;
        varying vec3 vObj;
        ${NOISE}
        ${RINGS}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float ringLine = uRingGlow * max(rings(vObj, 70.0), 0.0);      // тонкая линия фронта волны
        float fres = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0);
        float sy = (normalize(vObj).y - uScanY) * 24.0;               // не pow(): от отрицательного основания NaN
        float scan = uScan * exp(-sy * sy);
        totalEmissiveRadiance += ringLine * vec3(1.1, 0.9, 2.0) + uRim * fres * uRimColor + scan * vec3(0.8, 0.68, 1.5);`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        #ifdef USE_IRIDESCENCE
          float flow = noise3(vObj*1.5 + vec3(0.0, uFlow, uFlow*0.6))
                     + 0.5*noise3(vObj*3.3 - vec3(uFlow*0.8, 0.0, uFlow*0.3));
          material.iridescenceThickness = mix(iridescenceThicknessMinimum, iridescenceThicknessMaximum,
                                              smoothstep(0.2, 1.3, flow));
        #endif`);
  };

  // ---------- ореол ----------
  const radial = (stops) => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    for (const [o, col] of stops) grd.addColorStop(o, col);
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  // ореол за шаром вместо тяжёлого bloom: виден только по краю силуэта
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radial([[0, "rgba(255,255,255,1)"], [0.64, "rgba(255,255,255,1)"], [0.72, "rgba(255,255,255,0.42)"],
                 [0.85, "rgba(255,255,255,0.1)"], [1, "rgba(255,255,255,0)"]]),
    transparent: true, depthWrite: false, opacity: 0 }));
  halo.scale.setScalar(3.1);                       // шар (r = 1) закрывает центр, светится полоса 1.0–1.5
  halo.renderOrder = -1;

  // ---------- состояние ----------
  let state = "idle", lastState = state, disposed = false;
  let level = 0, impulse = 0, externalLevel = null;
  let invite = false, inviteT = 0;            // приглашение: «сердцебиение» кольцами, пока шар ждёт клика
  const pointer = { x: 0, y: 0, active: false, touching: false, last: -1e9 };
  const ringPool = Array.from({ length: MAX_RINGS }, () => ({ age: 99, amp: 0 }));
  function spawnRing(strength) {
    const r = ringPool.reduce((a, b) => (b.age > a.age ? b : a));
    r.age = 0; r.amp = strength;
    impulse = Math.max(impulse, strength);
  }

  // ---------- микрофон ----------
  let micLevel = null, micStream = null, micCtx = null, micPending = false;
  async function startMic() {
    if (!mic || micLevel || micPending) return;
    micPending = true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (state !== "listening" || disposed) return stopMic();
      micCtx = new AudioContext();
      const an = micCtx.createAnalyser(); an.fftSize = 512;
      micCtx.createMediaStreamSource(micStream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      micLevel = () => {
        an.getByteTimeDomainData(buf);
        let s = 0; for (const v of buf) { const d = (v - 128) / 128; s += d * d; }
        return Math.min(1, Math.sqrt(s / buf.length) * 6);
      };
    } catch (e) { micLevel = null; } finally { micPending = false; }   // нет доступа — уровень имитируем
  }
  function stopMic() {
    micLevel = null;
    micStream?.getTracks().forEach((t) => t.stop()); micStream = null;
    micCtx?.close().catch(() => {}); micCtx = null;
  }

  // ---------- речь ----------
  let speech = null;   // { events, idx, t0, tts, lastBoundary, resolve, deadline }
  const hasTTS = typeof speechSynthesis !== "undefined";
  function endSpeech(cancelTTS) {
    if (!speech) return;
    const s = speech; speech = null;
    if (cancelTTS && s.tts) try { speechSynthesis.cancel(); } catch (e) {}
    s.resolve();
  }
  function speak(text, { tts = true } = {}) {
    endSpeech(true);
    setState("speaking");
    return new Promise((resolve) => {
      const now = performance.now();
      const s = speech = { events: syllableTimeline(text), idx: 0, t0: now, tts: false, lastBoundary: -1e9,
        resolve, deadline: now + 4000 + text.length * 120 };
      if (!tts || !hasTTS) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang; u.rate = 1.02;
        const v = pickVoice(speechSynthesis.getVoices(), lang);
        if (v) u.voice = v;
        u.onboundary = (e) => {
          if (speech !== s || (e.name && e.name !== "word")) return;
          s.lastBoundary = performance.now();
          const word = text.slice(e.charIndex).split(/\s/)[0] || "";
          spawnRing(0.6 + Math.min(0.4, word.length / 14));
        };
        u.onend = u.onerror = () => { if (speech === s) { endSpeech(false); setState("idle"); } };
        speechSynthesis.cancel(); speechSynthesis.speak(u);
        s.tts = true;
      } catch (e) {}
    });
  }
  function tickSpeech(now) {
    const s = speech;
    if (!s) return;
    const ttsTalking = s.tts && speechSynthesis.speaking;
    const useSyllables = !ttsTalking || now - s.lastBoundary > 700;   // озвучка без событий слов — ведём сами
    while (s.idx < s.events.length && s.events[s.idx].at <= now - s.t0) {
      if (useSyllables) spawnRing(s.events[s.idx].strength);
      s.idx++;
    }
    if (s.idx >= s.events.length) {
      if (ttsTalking && now < s.deadline) { s.idx = 0; s.t0 = now; }   // текст кончился раньше голоса
      else { endSpeech(true); setState("idle"); }
    }
  }

  function setState(s) {
    if (!STATES.includes(s) || s === state) return;
    state = s;
    if (s !== "speaking") endSpeech(true);
    if (s === "listening") startMic(); else stopMic();
    onStateChange?.(s);
  }

  // ---------- ввод ----------
  let rect = canvas.getBoundingClientRect();
  const toNdc = (e) => {
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  };
  const prevPtr = { x: 0, y: 0 };
  const onMove = (e) => {
    if (e.pointerType === "touch" && !pointer.touching) return;
    rect = canvas.getBoundingClientRect();
    toNdc(e);
    pointer.active = true; pointer.last = performance.now();
  };
  const onDown = (e) => {
    if (e.pointerType !== "touch") return;
    rect = canvas.getBoundingClientRect();
    toNdc(e); prevPtr.x = pointer.x; prevPtr.y = pointer.y;     // без ложного «взмаха» от прыжка пальца
    pointer.touching = pointer.active = true; pointer.last = performance.now();
  };
  const onUp = (e) => {
    if (e.pointerType !== "touch") return;
    pointer.touching = pointer.active = false;
  };
  const onOut = (e) => { if (!e.relatedTarget && e.pointerType !== "touch") pointer.active = false; };
  pointerTarget.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointerdown", onDown, { passive: true });
  addEventListener("pointerup", onUp, { passive: true });
  addEventListener("pointercancel", onUp, { passive: true });
  document.addEventListener("pointerout", onOut, { passive: true });

  // ---------- раскладка ----------
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(11.5, 3.0 / (half * camera.aspect), (3.25 + offsetY) / half) / zoom;
    camera.position.set(0, 0.35, dist);
    camera.lookAt(0, -offsetY, 0);
    camera.updateProjectionMatrix();
    rect = canvas.getBoundingClientRect();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  let visible = true;
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; });
  io.observe(canvas);

  // ---------- модель ----------
  let parts = null;
  const ready = (async () => {
    const buf = model instanceof ArrayBuffer ? model : await (await fetch(model)).arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(buf, "");
    if (disposed) return;
    const root = gltf.scene;
    const N = (n) => root.getObjectByName(n);
    N("Ball").material = glass;
    for (const n of ["Band", "Hook", "Cap", "Ring", "Sat0", "Sat1", "Sat2"]) N(n).material = chrome;
    N("BallRig").add(halo);
    scene.add(root);

    // спутники — каждый на своей наклонной орбите, за каждым тонкий тающий след
    const TRAIL = 28;
    const sats = [N("Sat0"), N("Sat1"), N("Sat2")].map((obj, i) => {
      const pos = new Float32Array(TRAIL * 3), col = new Float32Array(TRAIL * 4);
      for (let j = 0; j < TRAIL; j++) col.set([0.55, 0.52, 0.48, 0.32 * (1 - j / TRAIL) ** 1.6], j * 4);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute("color", new THREE.BufferAttribute(col, 4));
      const trail = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      trail.frustumCulled = false;
      scene.add(trail);
      return {
        obj, trail, pos, filled: false, world: new THREE.Vector3(),
        r: [1.75, 1.62, 2.05][i], a: i * 2.1, speed: [0.45, -0.8, 1.15][i],
        tilt: new THREE.Quaternion().setFromEuler(new THREE.Euler(...[[0, 0, 0], [0.9, 0.3, 0], [-0.5, 0, 0.7]][i])),
      };
    });

    const hookPivot = N("HookPivot");
    hookPivot.quaternion.identity();
    parts = {
      rig: N("Rig"), ballRig: N("BallRig"), hookPivot, orbit: N("Orbit"), sats,
      orbitBase: N("Orbit").quaternion.clone(),
    };
  })();

  // ---------- анимация ----------
  const sp = {
    listen: { x: 0, v: 0 }, think: { x: 0, v: 0 }, speak: { x: 0, v: 0 }, shapeLevel: { x: 0, v: 0 },
    amp: { x: 0, v: 0 }, ringGlow: { x: 0, v: 0 }, invite: { x: 0, v: 0 }, scan: { x: 0, v: 0 }, glow: { x: 0, v: 0 }, halo: { x: 0, v: 0 }, squash: { x: 0, v: 0 },
    tiltX: { x: 0, v: 0 }, tiltY: { x: 0, v: 0 }, omega: { x: 0.9, v: 0 }, hug: { x: 1, v: 0 },
    psi: { x: 0.8, v: 0 }, lean: { x: 0.35, v: 0 }, satBoost: { x: 1, v: 0 }, flowRate: { x: 0.08, v: 0 },
  };
  const auto = { phase: 0, drift: 0.8 };   // автопилот крюка: «восьмёрка» с медленной прецессией
  let t = 0, theta = 0, flick = 0, fpsEMA = 60, lastNow = performance.now();
  const smoothPtr = { x: 0, y: 0 };
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
  const axis = new THREE.Vector3(), tmp = new THREE.Vector3();
  const GLOW = {
    idle: new THREE.Color(0xfff1df), listening: new THREE.Color(0x6fc3ff),
    thinking: new THREE.Color(0xb59cff), speaking: new THREE.Color(0xa58fff),
  };
  const ZAXIS = new THREE.Vector3(0, 0, 1), YAXIS = new THREE.Vector3(0, 1, 0), XAXIS = new THREE.Vector3(1, 0, 0);

  function frame() {
    const now = performance.now();
    const raw = (now - lastNow) / 1000; lastNow = now;
    if (!visible || document.hidden || !parts) return;
    const dt = Math.max(1 / 240, Math.min(raw, 1 / 30));   // dt не 0 (иначе скорость взмаха = NaN) и не скачет
    fpsEMA += (1 / Math.max(raw, 1e-3) - fpsEMA) * 0.05;
    t += dt;
    const reduced = reducedMQ.matches;
    const motion = reduced ? 0.35 : 1;
    const { rig, ballRig, hookPivot, orbit, sats } = parts;

    // ---- ввод: сглаженный курсор и скорость взмаха ----
    smoothPtr.x += (pointer.x - smoothPtr.x) * Math.min(1, dt * 3.5);
    smoothPtr.y += (pointer.y - smoothPtr.y) * Math.min(1, dt * 3.5);
    const pv = Math.hypot(pointer.x - prevPtr.x, pointer.y - prevPtr.y) / dt;
    prevPtr.x = pointer.x; prevPtr.y = pointer.y;
    flick = Math.max(flick * Math.pow(0.45, dt), Math.min(2.5, Math.max(0, pv - 2) * 0.35) * (reduced ? 0.25 : 1));
    const engaged = pointer.active && now - pointer.last < 2500;

    // ---- уровень «звука» ----
    tickSpeech(now);
    let target = 0;
    if (externalLevel != null) target = externalLevel;
    else if (state === "listening") target = micLevel ? micLevel() : 0.3 + 0.35 * Math.abs(Math.sin(t * 6.1) * Math.sin(t * 2.3 + 1));
    else if (state === "speaking") target = impulse;
    impulse *= Math.pow(0.03, dt);
    level += (target - level) * Math.min(1, dt * 16);
    ringPool.forEach((r, i) => { r.age += dt; U.uRingAge.value[i] = r.age; U.uRingAmp.value[i] = r.amp * motion; });

    // ---- приглашение: двойной удар (тук-тук) раз в 1.8 с, между ударами — тишина ----
    const inviting = invite && state === "idle";
    if (inviting) {
      const prev = inviteT; inviteT += dt;
      const P = 1.8, a = prev % P, b = inviteT % P;
      if (b < a) { spawnRing(0.75 * motion); sp.squash.v += 0.9 * motion; }
      if (a < 0.26 && b >= 0.26) spawnRing(0.45 * motion);
    } else inviteT = 0;
    const invBeat = inviting ? Math.exp(-((inviteT % 1.8) * 4.2)) + 0.6 * Math.exp(-Math.max(0, (inviteT % 1.8) - 0.26) * 5) * ((inviteT % 1.8) > 0.26 ? 1 : 0) : 0;
    const inv = Math.max(0, spring(sp.invite, inviting ? 0.35 + 0.65 * invBeat : 0, 60, 12, dt));
    const beatNow = Math.pow(0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.4), 3);  // ритм «думает»
    // смена состояния — пружинный «вдох» шара
    if (state !== lastState) { sp.squash.v += state === "idle" ? -1.2 : 2.2; lastState = state; }

    // ---- шар ----
    const ampT = (0.008 + (state === "listening" ? 0.022 * level : 0) + (state === "thinking" ? 0.012 : 0)) * motion;
    U.uAmp.value = spring(sp.amp, ampT, 60, 14, dt);
    // веса форм — недодемпфированные пружины: смена состояния «перетекает» с лёгким отыгрышем
    U.uListen.value = spring(sp.listen, state === "listening" ? motion : 0, 26, 6.5, dt);
    U.uThink.value = spring(sp.think, state === "thinking" ? motion : 0, 22, 6, dt);
    U.uSpeak.value = spring(sp.speak, state === "speaking" ? motion : 0, 26, 6.5, dt);
    U.uLevel.value = spring(sp.shapeLevel, level, 160, 14, dt);           // упругий отклик на слог/громкость
    U.uSpin.value += dt * (0.9 + 1.6 * beatNow) * motion;
    U.uBeat.value = beatNow;
    U.uRingGlow.value = Math.max(0, spring(sp.ringGlow, state === "speaking" ? 1.1 : inviting ? 0.8 : 0, 30, 11, dt));
    U.uTime.value += dt * (state === "thinking" ? 1.8 : 0.5);
    U.uFlow.value += dt * spring(sp.flowRate, ({ idle: 0.07, listening: 0.12, thinking: 0.5, speaking: 0.18 })[state] * motion, 8, 5.6, dt);
    const sq = spring(sp.squash, 0, 120, 9, dt) * 0.035 * motion;            // недодемпфировано: отыгрыш
    const breath = 1 + 0.012 * Math.sin(t * 0.9) * motion + 0.03 * level * motion;
    ballRig.scale.set(breath * (1 + sq), breath * (1 - sq), breath * (1 + sq));
    ballRig.rotation.y = spring(sp.tiltY, 0.22 * smoothPtr.x * motion, 12, 6.5, dt);
    ballRig.rotation.x = spring(sp.tiltX, -0.16 * smoothPtr.y * motion, 12, 6.5, dt);
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    const gT = ({ idle: 0, listening: 0.15 + 0.5 * level, thinking: 0.18 + 0.2 * pulse, speaking: 0.3 + 0.6 * level })[state];
    const glow = Math.max(0, spring(sp.glow, gT, 40, 11, dt)) + inv * 0.55;
    glass.emissiveIntensity = glow * 0.12;                      // стекло почти не заливаем: цвет состояния — в ободке
    const glowColor = inviting ? GLOW.thinking : GLOW[state];
    glass.emissive.lerp(glowColor, Math.min(1, dt * 4));
    U.uRimColor.value.lerp(glowColor, Math.min(1, dt * 4));
    U.uRim.value = 0.35 + 2.2 * glow;
    glass.iridescence = 0.55 + 0.35 * glow;
    U.uScan.value = Math.max(0, spring(sp.scan, state === "thinking" ? 1.4 : 0, 20, 9, dt));
    U.uScanY.value = 0.92 * Math.sin(t * 2.1);                  // линия сканирует шар сверху вниз и обратно
    const hT = ({ idle: 0.1, listening: 0.3 + 0.35 * level, thinking: 0.3 + 0.25 * pulse, speaking: 0.32 + 0.45 * level })[state];
    halo.material.opacity = Math.max(0, spring(sp.halo, hT + inv * 0.4, 30, 10, dt));
    halo.material.color.lerp(glowColor, Math.min(1, dt * 4));

    // ---- крюк: непрерывный кувырок вокруг шара по диагональной оси ----
    // курсор задаёт плоскость кувырка, взмах раскручивает, без мыши — «восьмёрка»
    const beat = beatNow;
    const omegaT = ({ idle: 0.5, listening: 0.4 + 0.4 * level, thinking: 2.0 + 1.2 * beat, speaking: 0.8 + 0.5 * level })[state];
    theta += spring(sp.omega, (reduced ? Math.min(omegaT, 1.1) : omegaT) * motion + flick * 0.6, 5, 4.5, dt) * dt;
    auto.phase += dt * 0.32 * motion;
    let psiT, leanT;
    if (engaged && state !== "thinking") {
      const c = tmp.set(0, 0, 0).project(camera);
      psiT = Math.atan2(pointer.y - c.y, (pointer.x - c.x) * camera.aspect) + Math.PI / 2;
      leanT = 0.2 + 0.35 * Math.min(1, Math.hypot(smoothPtr.x, smoothPtr.y));
      auto.drift = sp.psi.x - 0.75 * Math.sin(auto.phase);      // отпустили мышь — восьмёрка продолжится отсюда
    } else {
      auto.drift += dt * 0.07 * motion;
      psiT = auto.drift + 0.75 * Math.sin(auto.phase);
      leanT = 0.35 + 0.3 * Math.sin(2 * auto.phase);
    }
    const psi = spring(sp.psi, sp.psi.x + wrap(psiT - sp.psi.x), 5, 3.9, dt);    // мягко, с лёгким перелётом, кратчайший путь
    const lean = spring(sp.lean, leanT * motion, 4, 3.4, dt);
    axis.set(Math.cos(psi), Math.sin(psi), lean).normalize();
    qA.setFromAxisAngle(axis, theta);
    qB.setFromAxisAngle(ZAXIS, psi - Math.PI / 2 - STEM);                 // капсула встречает курсор в начале оборота
    hookPivot.quaternion.copy(qA).multiply(qB);
    // крюк расходится, пока шар деформирован: сквозь стекло пересечение было бы видно
    hookPivot.scale.setScalar(spring(sp.hug, ({ idle: 1, listening: 1.05, thinking: 1.09, speaking: 1.06 })[state], 40, 9, dt));

    // ---- орбита и спутники ----
    qC.setFromAxisAngle(YAXIS, t * 0.1 * motion);
    qA.setFromAxisAngle(XAXIS, 0.15 * Math.sin(t * 0.35) * motion + 0.08 * smoothPtr.y * motion);
    orbit.quaternion.copy(qA).multiply(qC).multiply(parts.orbitBase);
    const boost = spring(sp.satBoost, ({ idle: 0.7, listening: 0.5, thinking: 2.6, speaking: 1.3 })[state] + flick * 0.3, 5, 4.5, dt);
    for (const s of sats) {
      s.a += dt * s.speed * boost * motion;
      s.obj.position.set(Math.cos(s.a) * s.r, 0, -Math.sin(s.a) * s.r).applyQuaternion(s.tilt);
      s.obj.scale.setScalar(1 + 0.25 * level);
    }

    // парение
    rig.position.y = 0.06 * Math.sin(t * 0.8) * motion;

    scene.updateMatrixWorld();
    for (const s of sats) {                       // следы: сдвиг истории на одну точку
      s.obj.getWorldPosition(s.world);
      if (!s.filled) { for (let j = 0; j < s.pos.length; j += 3) s.world.toArray(s.pos, j); s.filled = true; }
      s.pos.copyWithin(3, 0, s.pos.length - 3);
      s.world.toArray(s.pos, 0);
      s.trail.geometry.attributes.position.needsUpdate = true;
      s.trail.visible = !reduced;
    }


    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);

  function destroy() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    endSpeech(true); stopMic();
    ro.disconnect(); io.disconnect();
    pointerTarget.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", onDown);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", onUp);
    document.removeEventListener("pointerout", onOut);
    scene.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); }
    });
    envTex.dispose(); glassEnv.dispose(); roomTex.dispose(); pmrem.dispose(); renderer.dispose();
  }

  return {
    ready,
    setState,
    /** 0..1 — внешний уровень звука (например, громкость своего плеера); null — снова свой */
    setLevel: (v) => { externalLevel = v == null ? null : Math.max(0, Math.min(1, v)); },
    speak,
    /** Приглашение нажать: шар бьётся «сердцем» — кольца по стеклу и вспышка ободка (только в idle). */
    invite: (on) => { invite = !!on; },
    /** Отклик на нажатие: шар вжимается и отпускает сильное кольцо. */
    poke: () => { sp.squash.v -= 3.2; spawnRing(1.1); sp.glow.v += 4; },
    destroy,
    get state() { return state; },
    get fps() { return fpsEMA; },
  };
}
