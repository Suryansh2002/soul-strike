import * as THREE from 'three';
import { ARENA_BOXES, JUMP_PADS, ORB_SPAWNS } from '../shared/arena.js';
import { EMOTES, GAME_MODES, PLAYER_EYE_HEIGHT, TEAMS } from '../shared/constants.js';
import { raycastArena } from '../shared/physics.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.isMobile =
      'ontouchstart' in window ||
      (navigator.maxTouchPoints || 0) > 0 ||
      window.matchMedia?.('(pointer: coarse)').matches;
    this.dprCap = this.isMobile ? 1.75 : 2.5;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.dprCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.autoClear = false;

    this.maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy() || 4);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#7dd3fc');
    this.scene.fog = new THREE.FogExp2('#bfe6ff', 0.0042);

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(78, aspect, 0.08, 260);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    // Separate viewmodel scene & camera so first-person weapons never clip into walls
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(68, aspect, 0.05, 10);
    this.vmScene.add(this.vmCamera);

    this.playerMeshes = new Map();
    this.projectileMeshes = new Map();
    this.orbMeshes = [];
    this.jumpPadRings = [];
    this.brazierFlames = [];
    this.obeliskRings = [];
    this.effects = [];
    this.damageNumbers = [];
    this.confetti = [];
    this.clouds = [];
    this.goats = [];
    this.chickens = [];
    this.windmillBlades = null;

    this.recoil = 0;
    this.swingAnim = 0;
    this.panSwingAnim = 0;
    this.walkTime = 0;
    this.screenShake = 0;
    this.perspectiveMode = 'fpp';
    this.baseFov = 75;
    this.baseVmFov = 66;
    this.scopeBlend = 0;
    this.localEmote = null;
    this.localAvatarRec = null;
    this.panPickupGroup = null;
    this.panPickupRotator = null;
    this.panPickupPulse = null;
    this.panTexture = null;

    this.setupEnvironmentMap();
    this.setupLights();
    this.buildSkyAndClouds();
    this.buildArena();
    this.buildFunProps();
    this.buildSunPollen();
    this.buildViewmodel();

    this.updateViewportSize();

    const onResize = () => this.updateViewportSize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => {
      this.updateViewportSize();
      setTimeout(() => this.updateViewportSize(), 140);
    });
    window.visualViewport?.addEventListener('resize', onResize);
  }

  setPerspective(mode) {
    this.perspectiveMode = mode === 'tpp' ? 'tpp' : 'fpp';
  }

  updateViewportSize() {
    const w = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const h = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const newAspect = w / h;
    const isPhoneScreen = this.isMobile || Math.min(w, h) <= 560;

    let fov;
    if (newAspect < 1) {
      // Vertical phone: tighter vertical FOV (~60-68 deg) for larger, clearer targets
      fov = Math.min(68, Math.max(60, 71 - newAspect * 9));
    } else if (isPhoneScreen) {
      // Horizontal phone: keep horizontal FOV around ~84-90 deg (~50-58 deg vfov)
      const halfTanH = Math.tan((84 * Math.PI) / 360);
      const calcVfov = (2 * Math.atan(halfTanH / newAspect) * 180) / Math.PI;
      fov = Math.min(60, Math.max(50, calcVfov));
    } else {
      fov = Math.min(78, Math.max(71, 79 - Math.max(0, newAspect - 1.35) * 4));
    }

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.dprCap));
    this.baseFov = fov;
    this.camera.fov = this.baseFov * (1 - (this.scopeBlend || 0) * 0.64);
    this.camera.aspect = newAspect;
    this.camera.updateProjectionMatrix();

    this.baseVmFov =
      newAspect < 1
        ? Math.min(65, Math.max(58, 67 - newAspect * 6))
        : isPhoneScreen
          ? 56
          : 66;
    this.vmCamera.fov = this.baseVmFov * (1 - (this.scopeBlend || 0) * 0.45);
    this.vmCamera.aspect = newAspect;
    this.vmCamera.updateProjectionMatrix();

    this.renderer.setSize(w, h);
  }

  setupEnvironmentMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();

    const envSky = new THREE.Mesh(
      new THREE.SphereGeometry(20, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#bae6fd', side: THREE.BackSide })
    );
    const envGround = new THREE.Mesh(
      new THREE.CircleGeometry(18, 16),
      new THREE.MeshBasicMaterial({ color: '#4ade80' })
    );
    envGround.rotation.x = -Math.PI / 2;
    envGround.position.y = -3;

    const envSun = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 10, 10),
      new THREE.MeshBasicMaterial({ color: '#fef08a' })
    );
    envSun.position.set(8, 11, 6);

    const envHemi = new THREE.HemisphereLight('#ffffff', '#4ade80', 2.0);
    envScene.add(envSky, envGround, envSun, envHemi);

    const envRT = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = envRT.texture;
    this.vmScene.environment = envRT.texture;

    envSky.geometry.dispose();
    envSky.material.dispose();
    envGround.geometry.dispose();
    envGround.material.dispose();
    envSun.geometry.dispose();
    envSun.material.dispose();
    pmrem.dispose();
  }

  makeTex(drawFn, size = this.isMobile ? 512 : 1024) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    drawFn(ctx, size);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.maxAnisotropy;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  createTextures() {
    const grass = this.makeTex((ctx, s) => {
      const k = s / 512;
      ctx.fillStyle = '#47b849';
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, 0, s / 2, s);
      const bladeCount = Math.round(2800 * k);
      for (let i = 0; i < bladeCount; i++) {
        ctx.fillStyle = Math.random() > 0.5 ? '#5fd35c' : '#359b38';
        ctx.fillRect(Math.random() * s, Math.random() * s, 3 * k, 7 * k);
      }
      const flowerCount = Math.round(42 * k);
      for (let i = 0; i < flowerCount; i++) {
        const fx = Math.random() * s;
        const fy = Math.random() * s;
        ctx.fillStyle = Math.random() > 0.35 ? '#fef08a' : '#ffffff';
        ctx.beginPath();
        ctx.arc(fx, fy, 2.6 * k, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    const cobble = this.makeTex((ctx, s) => {
      const k = s / 512;
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(0, 0, s, s);
      const colors = ['#e2e8f0', '#cbd5e1', '#d6d3d1', '#b8c4d4'];
      const cell = s / 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const ox = y % 2 === 0 ? 0 : cell * 0.5;
          const rx = (x * cell + ox) % s + 3 * k;
          const ry = y * cell + 3 * k;
          const rw = cell - 6 * k;
          const rh = cell - 6 * k;
          ctx.fillStyle = colors[(x + y * 3) % colors.length];
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeStyle = '#64748b';
          ctx.lineWidth = 3 * k;
          ctx.strokeRect(rx, ry, rw, rh);
        }
      }
    });

    const hay = this.makeTex((ctx, s) => {
      const k = s / 512;
      ctx.fillStyle = '#eab308';
      ctx.fillRect(0, 0, s, s);
      const strawCount = Math.round(2000 * k);
      for (let i = 0; i < strawCount; i++) {
        ctx.fillStyle = Math.random() > 0.5 ? '#facc15' : '#ca8a04';
        ctx.fillRect(Math.random() * s, Math.random() * s, 26 * k, 3 * k);
      }
      ctx.fillStyle = '#78350f';
      ctx.fillRect(0, s * 0.25, s, 14 * k);
      ctx.fillRect(0, s * 0.75, s, 14 * k);
    });

    const wood = this.makeTex((ctx, s) => {
      const k = s / 512;
      ctx.fillStyle = '#9a5b2d';
      ctx.fillRect(0, 0, s, s);
      const plankH = s / 6;
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#a86534' : '#8d5125';
        ctx.fillRect(0, i * plankH + 2 * k, s, plankH - 4 * k);
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.fillRect(0, (i + 1) * plankH - 2 * k, s, 3 * k);
      }
      for (let i = 0; i < Math.round(450 * k); i++) {
        ctx.fillStyle = 'rgba(60,25,5,0.14)';
        ctx.fillRect(Math.random() * s, Math.random() * s, 45 * k, 2 * k);
      }
    });

    const gardenWall = this.makeTex((ctx, s) => {
      const k = s / 512;
      ctx.fillStyle = '#a8a29e';
      ctx.fillRect(0, 0, s, s);
      const bh = s / 8;
      const bw = s / 4;
      for (let r = 0; r < 8; r++) {
        const shift = (r % 2) * (bw * 0.5);
        for (let c = -1; c < 5; c++) {
          ctx.fillStyle = (r + c) % 3 === 0 ? '#e7e5e4' : '#d6d3d1';
          ctx.fillRect(c * bw + shift + 3 * k, r * bh + 3 * k, bw - 6 * k, bh - 6 * k);
        }
      }
    });

    const barnRed = this.makeTex((ctx, s) => {
      const k = s / 512;
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(0, 0, s, s);
      const step = 64 * k;
      for (let x = 0; x < s; x += step) {
        ctx.fillStyle = '#991b1b';
        ctx.fillRect(x, 0, 5 * k, s);
      }
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 14 * k;
      ctx.strokeRect(12 * k, 12 * k, s - 24 * k, s - 24 * k);
    });

    const millBlue = this.makeTex((ctx, s) => {
      const k = s / 512;
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(0, 0, s, s);
      const step = 64 * k;
      for (let x = 0; x < s; x += step) {
        ctx.fillStyle = '#1e40af';
        ctx.fillRect(x, 0, 5 * k, s);
      }
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 14 * k;
      ctx.strokeRect(12 * k, 12 * k, s - 24 * k, s - 24 * k);
    });

    return { grass, cobble, hay, wood, gardenWall, barnRed, millBlue };
  }

  scaleBoxUVs(geometry, w, h, d, tileSize = 3.6) {
    const uv = geometry.attributes.uv;
    const norm = geometry.attributes.normal;
    for (let i = 0; i < uv.count; i++) {
      const nx = Math.abs(norm.getX(i));
      const ny = Math.abs(norm.getY(i));
      const nz = Math.abs(norm.getZ(i));
      let uScale = 1;
      let vScale = 1;
      if (nx > 0.5) {
        uScale = d / tileSize;
        vScale = h / tileSize;
      } else if (ny > 0.5) {
        uScale = w / tileSize;
        vScale = d / tileSize;
      } else if (nz > 0.5) {
        uScale = w / tileSize;
        vScale = h / tileSize;
      }
      uv.setXY(i, uv.getX(i) * uScale, uv.getY(i) * vScale);
    }
    uv.needsUpdate = true;
  }

  setupLights() {
    const hemi = new THREE.HemisphereLight('#e0f2fe', '#4ade80', 1.25);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight('#fffbeb', 2.25);
    sun.position.set(26, 46, 20);
    sun.castShadow = true;
    const shadowSize = this.isMobile ? 1024 : 2048;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.bias = -0.0005;
    sun.shadow.camera.near = 5;
    sun.shadow.camera.far = 110;
    const d = 32;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight('#bae6fd', 0.65);
    fill.position.set(-24, 18, -22);
    this.scene.add(fill);

    // Matching lights for the dedicated viewmodel scene
    const vmHemi = new THREE.HemisphereLight('#e0f2fe', '#4ade80', 1.2);
    const vmSun = new THREE.DirectionalLight('#fffbeb', 2.0);
    vmSun.position.set(2, 4, 2);
    const vmRim = new THREE.DirectionalLight('#bae6fd', 0.8);
    vmRim.position.set(-3, 2, -2);
    this.vmScene.add(vmHemi, vmSun, vmRim);
  }

  buildSkyAndClouds() {
    const skyGeo = new THREE.SphereGeometry(160, 24, 16);
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 16;
    skyCanvas.height = 256;
    const ctx = skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, '#1d4ed8');
    grad.addColorStop(0.35, '#38bdf8');
    grad.addColorStop(0.55, '#bae6fd');
    grad.addColorStop(1.0, '#fef9c3');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 256);
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const skyDome = new THREE.Mesh(
      skyGeo,
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    this.scene.add(skyDome);

    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(5.5, 16, 16),
      new THREE.MeshBasicMaterial({ color: '#fef08a', fog: false })
    );
    sunDisc.position.set(52, 74, 38);
    this.scene.add(sunDisc);

    const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, metalness: 0.0 });
    for (let i = 0; i < 12; i++) {
      const grp = new THREE.Group();
      const puffs = 3 + (i % 3);
      for (let p = 0; p < puffs; p++) {
        const puff = new THREE.Mesh(new THREE.DodecahedronGeometry(2.4 + (p % 2) * 1.1, 1), cloudMat);
        puff.position.set((p - 1) * 2.5, Math.sin(p) * 0.6, (p % 2) * 1.1);
        puff.scale.set(1.2, 0.72, 1.0);
        grp.add(puff);
      }
      const angle = (i / 12) * Math.PI * 2;
      const dist = 42 + (i % 3) * 16;
      grp.position.set(Math.cos(angle) * dist, 28 + (i % 4) * 5, Math.sin(angle) * dist);
      grp.userData = { speed: 0.6 + (i % 3) * 0.35 };
      this.scene.add(grp);
      this.clouds.push(grp);
    }
  }

  buildArena() {
    const t = this.createTextures();
    this.textures = t;

    const materials = {
      grass_floor: new THREE.MeshStandardMaterial({
        map: t.grass,
        bumpMap: t.grass,
        bumpScale: 0.035,
        roughness: 0.88,
        metalness: 0.02,
      }),
      garden_wall: new THREE.MeshStandardMaterial({
        map: t.gardenWall,
        bumpMap: t.gardenWall,
        bumpScale: 0.035,
        roughness: 0.78,
        metalness: 0.05,
      }),
      cobble: new THREE.MeshStandardMaterial({
        map: t.cobble,
        bumpMap: t.cobble,
        bumpScale: 0.035,
        roughness: 0.68,
        metalness: 0.1,
      }),
      timber_pillar: new THREE.MeshStandardMaterial({
        map: t.wood,
        bumpMap: t.wood,
        bumpScale: 0.035,
        roughness: 0.7,
        metalness: 0.08,
      }),
      hay: new THREE.MeshStandardMaterial({
        map: t.hay,
        bumpMap: t.hay,
        bumpScale: 0.035,
        roughness: 0.92,
        metalness: 0.0,
      }),
      wood_deck: new THREE.MeshStandardMaterial({
        map: t.wood,
        bumpMap: t.wood,
        bumpScale: 0.035,
        roughness: 0.65,
        metalness: 0.08,
      }),
      wood_rail: new THREE.MeshStandardMaterial({
        map: t.hay,
        bumpMap: t.hay,
        bumpScale: 0.035,
        roughness: 0.85,
      }),
      sun_pillar: new THREE.MeshStandardMaterial({
        color: '#fef08a',
        emissive: '#f59e0b',
        emissiveIntensity: 0.38,
        roughness: 0.25,
        metalness: 0.65,
      }),
      crimson_stone: new THREE.MeshStandardMaterial({
        map: t.barnRed,
        bumpMap: t.barnRed,
        bumpScale: 0.035,
        roughness: 0.65,
      }),
      azure_stone: new THREE.MeshStandardMaterial({
        map: t.millBlue,
        bumpMap: t.millBlue,
        bumpScale: 0.035,
        roughness: 0.65,
      }),
    };

    const tileSizes = {
      grass_floor: 4.8,
      garden_wall: 4.5,
      cobble: 3.2,
      timber_pillar: 3.0,
      hay: 2.6,
      wood_deck: 3.2,
      wood_rail: 2.6,
      crimson_stone: 3.5,
      azure_stone: 3.5,
    };

    for (const b of ARENA_BOXES) {
      // Braziers and sky-bridge fences have dedicated multi-part sculpted meshes that match these colliders.
      if (b.kind === 'brazier' || b.kind === 'fence') continue;
      // The Central Sun Obelisk has a dedicated sculpted marble + gold mesh (see buildCentralObelisk).
      if (b.id === 'altar_obelisk') continue;
      const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
      this.scaleBoxUVs(geo, b.w, b.h, b.d, tileSizes[b.kind] || 3.4);
      const mesh = new THREE.Mesh(geo, materials[b.kind] || materials.cobble);
      mesh.position.set(b.x, b.y, b.z);
      mesh.castShadow = b.kind !== 'grass_floor';
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }

    // Coping borders & 4 golden corner braziers on the Central Sunlit Shrine Plaza (y = 2.0)
    const copingMat = new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.55, metalness: 0.18 });
    const copingStrips = [
      { x: 0, z: -4.85, w: 10.2, d: 0.32 },
      { x: 0, z: 4.85, w: 10.2, d: 0.32 },
      { x: -4.85, z: 0, w: 0.32, d: 10.2 },
      { x: 4.85, z: 0, w: 0.32, d: 10.2 },
    ];
    for (const cs of copingStrips) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(cs.w, 0.14, cs.d), copingMat);
      strip.position.set(cs.x, 2.02, cs.z);
      strip.receiveShadow = true;
      this.scene.add(strip);
    }

    const goldBrazierMat = new THREE.MeshStandardMaterial({ color: '#f59e0b', metalness: 0.78, roughness: 0.25 });
    const emberMat = new THREE.MeshStandardMaterial({
      color: '#ea580c',
      emissive: '#c2410c',
      emissiveIntensity: 0.9,
      roughness: 0.6,
    });
    const flameMat = new THREE.MeshStandardMaterial({
      color: '#fef08a',
      emissive: '#f97316',
      emissiveIntensity: 1.5,
      roughness: 0.2,
    });
    for (const [bx, bz] of [[-4.2, -4.2], [4.2, -4.2], [-4.2, 4.2], [4.2, 4.2]]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.32, 0.08, 12), goldBrazierMat);
      foot.position.set(bx, 2.04, bz);
      foot.castShadow = true;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.2, 0.34, 12), goldBrazierMat);
      bowl.position.set(bx, 2.24, bz);
      bowl.castShadow = true;
      const embers = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.05, 12), emberMat);
      embers.position.set(bx, 2.39, bz);
      const flame = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), flameMat);
      flame.position.set(bx, 2.6, bz);
      flame.userData = { baseY: 2.6, phase: bx + bz };
      this.scene.add(foot, bowl, embers, flame);
      this.brazierFlames.push(flame);
    }

    // Surrounding sunlit meadow ground plane so perimeter props and trees never hover over sky
    const meadowMat = new THREE.MeshStandardMaterial({
      color: '#63b136',
      roughness: 0.92,
      metalness: 0.0,
    });
    const meadow = new THREE.Mesh(new THREE.CircleGeometry(120, 48), meadowMat);
    meadow.rotation.x = -Math.PI / 2;
    meadow.position.y = -0.15;
    meadow.receiveShadow = true;
    this.scene.add(meadow);

    // Sculpted marble + gold Central Sun Obelisk, floating Sun Crystal and gimbal astrolabe
    this.buildCentralObelisk();

    // Bouncy Arcane Trampoline Jump Pads
    for (const jp of JUMP_PADS) {
      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(jp.radius, jp.radius * 1.12, 0.22, 24),
        new THREE.MeshStandardMaterial({ color: '#f59e0b', metalness: 0.55, roughness: 0.3 })
      );
      rim.position.set(jp.x, jp.y, jp.z);
      rim.receiveShadow = true;
      this.scene.add(rim);

      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(jp.radius * 0.82, jp.radius * 0.82, 0.25, 24),
        new THREE.MeshStandardMaterial({ color: '#38bdf8', emissive: '#0ea5e9', emissiveIntensity: 0.8 })
      );
      pad.position.set(jp.x, jp.y + 0.03, jp.z);
      this.scene.add(pad);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(jp.radius * 0.78, 0.065, 8, 24),
        new THREE.MeshBasicMaterial({ color: '#fef08a', transparent: true, opacity: 0.9 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(jp.x, jp.y + 0.4, jp.z);
      ring.userData.baseY = jp.y + 0.28;
      this.scene.add(ring);
      this.jumpPadRings.push(ring);
    }

    // Spinning Golden Soul Essence Orbs
    for (const sp of ORB_SPAWNS) {
      const grp = new THREE.Group();
      grp.position.set(sp.x, sp.y, sp.z);
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.45, 0),
        new THREE.MeshStandardMaterial({
          color: '#fef08a',
          emissive: '#f59e0b',
          emissiveIntensity: 1.2,
          roughness: 0.15,
          metalness: 0.65,
        })
      );
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.68, 0.055, 8, 24),
        new THREE.MeshBasicMaterial({ color: '#38bdf8' })
      );
      grp.add(core, halo);
      this.scene.add(grp);
      this.orbMeshes.push(grp);
    }

    // Random Golden Battle Pan Pickup (hidden until spawned by server)
    this.panPickupGroup = new THREE.Group();
    this.panPickupGroup.visible = false;

    const panRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.84, 0.055, 8, 32),
      new THREE.MeshStandardMaterial({
        color: '#fde047',
        emissive: '#f59e0b',
        emissiveIntensity: 1.0,
        metalness: 0.85,
        roughness: 0.2,
      })
    );
    panRing.rotation.x = Math.PI / 2;
    panRing.position.y = 0.06;

    this.panPickupPulse = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.82, 28),
      new THREE.MeshBasicMaterial({
        color: '#fde047',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      })
    );
    this.panPickupPulse.rotation.x = -Math.PI / 2;
    this.panPickupPulse.position.y = 0.05;

    const panBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.72, 10.0, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: '#facc15',
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    panBeacon.position.y = 5.02;

    this.panPickupRotator = new THREE.Group();
    this.panPickupRotator.position.y = 1.15;
    const pickupPanMesh = this.createPanModel({ scale: 1.75, centerOnBowl: true });
    pickupPanMesh.rotation.set(0.45, 0, 0.28);
    this.panPickupRotator.add(pickupPanMesh);

    this.panPickupGroup.add(panRing, this.panPickupPulse, panBeacon, this.panPickupRotator);
    this.scene.add(this.panPickupGroup);
  }

  makeCanvasTexture(w, h, drawFn, srgb = true) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    drawFn(c.getContext('2d'), w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = this.maxAnisotropy;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * Central Sun Obelisk (visual only — the server collider stays the 1.8 x 5.0 x 1.8 `altar_obelisk` box,
   * x/z ∈ [-0.9, 0.9], y ∈ [2.0, 7.0]). Everything that rotates lives inside a sphere centred on the crystal
   * whose radius is smaller than the gap to the pyramidion tip, so the rings can never sweep into the pillar.
   */
  buildCentralObelisk() {
    const hiRes = !this.isMobile;
    const SHAFT_BOTTOM = 2.59;
    const SHAFT_TOP = 6.25;
    const HW_BOTTOM = 0.9;
    const HW_TOP = 0.76;
    const CRYSTAL_Y = 9.0;
    this.obeliskCrystalY = CRYSTAL_Y;
    const hwAt = (y) => HW_BOTTOM - ((y - SHAFT_BOTTOM) / (SHAFT_TOP - SHAFT_BOTTOM)) * (HW_BOTTOM - HW_TOP);
    const SQRT2 = Math.SQRT2;

    // Deterministic RNG so the colour map and glow map share identical rune shapes
    const seeded = (seed) => () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const drawSun = (ctx, cx, cy, r, fill, stroke, lw) => {
      ctx.save();
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const len = i % 2 === 0 ? r * 1.75 : r * 1.38;
        const half = (Math.PI / 16) * 0.55;
        ctx.moveTo(cx + Math.cos(a - half) * r * 1.05, cy + Math.sin(a - half) * r * 1.05);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        ctx.lineTo(cx + Math.cos(a + half) * r * 1.05, cy + Math.sin(a + half) * r * 1.05);
      }
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };

    const drawRuneColumn = (ctx, w, h, strokeStyle, lw) => {
      const rnd = seeded(7331);
      const pts = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0], [0, 0], [1, 0],
        [-1, 1], [0, 1], [1, 1],
      ];
      ctx.save();
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const count = 7;
      for (let i = 0; i < count; i++) {
        const cx = w / 2;
        const cy = h * (0.385 + i * 0.083);
        const gx = w * 0.12;
        const gy = h * 0.026;
        ctx.beginPath();
        // central stem keeps every glyph reading as part of one carved script
        ctx.moveTo(cx, cy - gy);
        ctx.lineTo(cx, cy + gy);
        const strokes = 2 + Math.floor(rnd() * 3);
        for (let s = 0; s < strokes; s++) {
          const a = pts[Math.floor(rnd() * pts.length)];
          const b = pts[Math.floor(rnd() * pts.length)];
          if (a === b) continue;
          ctx.moveTo(cx + a[0] * gx, cy + a[1] * gy);
          ctx.lineTo(cx + b[0] * gx, cy + b[1] * gy);
        }
        ctx.stroke();
        if (rnd() > 0.55) {
          ctx.beginPath();
          ctx.arc(cx + (rnd() > 0.5 ? gx : -gx) * 0.7, cy, gy * 0.32, 0, Math.PI * 2);
          ctx.stroke();
        }
        // little diamond separators between glyphs
        if (i < count - 1) {
          const dy = cy + h * 0.0415;
          ctx.beginPath();
          ctx.moveTo(cx, dy - gy * 0.22);
          ctx.lineTo(cx + gx * 0.18, dy);
          ctx.lineTo(cx, dy + gy * 0.22);
          ctx.lineTo(cx - gx * 0.18, dy);
          ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    const FW = hiRes ? 512 : 256;
    const FH = FW * 2.5;
    const k = FW / 256;

    // Polished ivory marble face with gold inset panel, engraved sun crest and rune column
    const faceMap = this.makeCanvasTexture(FW, FH, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#fffaf0');
      g.addColorStop(0.55, '#f4ecdb');
      g.addColorStop(1, '#e6dac0');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const rnd = seeded(4242);
      for (let i = 0; i < 26; i++) {
        ctx.strokeStyle = i % 3 === 0 ? 'rgba(156, 132, 98, 0.22)' : 'rgba(170, 160, 140, 0.14)';
        ctx.lineWidth = (0.6 + rnd() * 1.8) * k;
        ctx.beginPath();
        let x = rnd() * w;
        let y = rnd() * h;
        ctx.moveTo(x, y);
        for (let s = 0; s < 4; s++) {
          const nx = x + (rnd() - 0.5) * w * 0.8;
          const ny = y + (rnd() - 0.2) * h * 0.18;
          ctx.quadraticCurveTo((x + nx) / 2 + (rnd() - 0.5) * 40 * k, (y + ny) / 2, nx, ny);
          x = nx;
          y = ny;
        }
        ctx.stroke();
      }

      // recessed panel
      const inset = w * 0.1;
      ctx.fillStyle = 'rgba(120, 90, 40, 0.06)';
      ctx.fillRect(inset, inset * 1.4, w - inset * 2, h - inset * 2.8);
      ctx.strokeStyle = '#b8860b';
      ctx.lineWidth = 7 * k;
      ctx.strokeRect(inset, inset * 1.4, w - inset * 2, h - inset * 2.8);
      ctx.strokeStyle = '#f7d774';
      ctx.lineWidth = 2 * k;
      ctx.strokeRect(inset + 9 * k, inset * 1.4 + 9 * k, w - inset * 2 - 18 * k, h - inset * 2.8 - 18 * k);

      drawSun(ctx, w / 2, h * 0.165, w * 0.13, '#d4a52a', '#8a5a12', 3 * k);
      // engraved runes: dark groove + light bevel highlight
      drawRuneColumn(ctx, w, h, '#8a5a12', 7 * k);
      ctx.save();
      ctx.translate(-1.5 * k, -1.5 * k);
      drawRuneColumn(ctx, w, h, 'rgba(255, 236, 170, 0.75)', 2.2 * k);
      ctx.restore();
    });
    faceMap.wrapS = THREE.RepeatWrapping;
    faceMap.repeat.set(4, 1);

    // Glow map: only the sun crest, runes and inner panel line emit light
    const faceGlow = this.makeCanvasTexture(FW, FH, (ctx, w, h) => {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      ctx.shadowColor = '#ffb020';
      ctx.shadowBlur = 14 * k;
      const inset = w * 0.1;
      ctx.strokeStyle = 'rgba(255, 190, 80, 0.55)';
      ctx.lineWidth = 2 * k;
      ctx.strokeRect(inset + 9 * k, inset * 1.4 + 9 * k, w - inset * 2 - 18 * k, h - inset * 2.8 - 18 * k);
      drawSun(ctx, w / 2, h * 0.165, w * 0.13, '#ffd27a', '#fff3c4', 3 * k);
      drawRuneColumn(ctx, w, h, '#ffe2a0', 6 * k);
    });
    faceGlow.wrapS = THREE.RepeatWrapping;
    faceGlow.repeat.set(4, 1);

    const marbleMat = new THREE.MeshPhysicalMaterial({
      color: '#f1eadb',
      roughness: 0.32,
      metalness: 0.04,
      clearcoat: 0.55,
      clearcoatRoughness: 0.18,
    });
    const lapisMat = new THREE.MeshPhysicalMaterial({
      color: '#1e3a6b',
      roughness: 0.28,
      metalness: 0.25,
      clearcoat: 0.8,
      clearcoatRoughness: 0.12,
    });
    const goldMat = new THREE.MeshStandardMaterial({
      color: '#f5c542',
      metalness: 1.0,
      roughness: 0.2,
      emissive: '#7c4a03',
      emissiveIntensity: 0.18,
    });
    const glowStripMat = new THREE.MeshBasicMaterial({ color: '#ffcf6b' });
    this.obeliskShaftMat = new THREE.MeshPhysicalMaterial({
      map: faceMap,
      emissiveMap: faceGlow,
      emissive: '#ffb347',
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.05,
      clearcoat: 0.6,
      clearcoatRoughness: 0.15,
    });

    const obelisk = new THREE.Group();
    const addMesh = (geo, mat, x, y, z, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      m.receiveShadow = true;
      obelisk.add(m);
      return m;
    };
    // Square frustum aligned to the world axes (4-sided cylinder rotated 45°)
    const squareFrustum = (hwTop, hwBottom, height, segs = 1, open = false) => {
      const geo = new THREE.CylinderGeometry(hwTop * SQRT2, hwBottom * SQRT2, height, 4, segs, open);
      geo.rotateY(Math.PI / 4);
      return geo;
    };

    // Inlaid sun-dial mosaic on the plaza floor around the plinth
    const dialTex = this.makeTexture2D(hiRes ? 1024 : 512, (ctx, s) => {
      const c = s / 2;
      const R = s / 2;
      const g = ctx.createRadialGradient(c, c, R * 0.2, c, c, R);
      g.addColorStop(0, '#fbf6e9');
      g.addColorStop(1, '#e9ddbf');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const long = i % 2 === 0;
        const len = long ? R * 0.86 : R * 0.66;
        const half = long ? 0.11 : 0.07;
        ctx.fillStyle = long ? '#e2b13c' : '#c9b48a';
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a - half) * R * 0.34, c + Math.sin(a - half) * R * 0.34);
        ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
        ctx.lineTo(c + Math.cos(a + half) * R * 0.34, c + Math.sin(a + half) * R * 0.34);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineWidth = R * 0.07;
      ctx.strokeStyle = '#1e3a6b';
      ctx.beginPath();
      ctx.arc(c, c, R * 0.935, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#d4a52a';
      ctx.lineWidth = R * 0.012;
      for (const rr of [0.895, 0.975, 0.34]) {
        ctx.beginPath();
        ctx.arc(c, c, R * rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.lineWidth = R * 0.01;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const r0 = i % 4 === 0 ? R * 0.905 : R * 0.925;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * R * 0.965, c + Math.sin(a) * R * 0.965);
        ctx.stroke();
      }
    });
    const dial = new THREE.Mesh(
      new THREE.CircleGeometry(3.5, 72),
      new THREE.MeshStandardMaterial({
        map: dialTex,
        roughness: 0.38,
        metalness: 0.12,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    dial.rotation.x = -Math.PI / 2;
    dial.position.set(0, 2.004, 0);
    dial.receiveShadow = true;
    obelisk.add(dial);

    // Slowly turning glowing rune circle on the dial
    const runeRingTex = this.makeTexture2D(hiRes ? 1024 : 512, (ctx, s) => {
      const c = s / 2;
      ctx.clearRect(0, 0, s, s);
      ctx.strokeStyle = '#ffd27a';
      ctx.shadowColor = '#ff9f1c';
      ctx.shadowBlur = s * 0.012;
      ctx.lineWidth = s * 0.006;
      for (const rr of [0.76, 0.97]) {
        ctx.beginPath();
        ctx.arc(c, c, c * rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      const rnd = seeded(9001);
      ctx.lineWidth = s * 0.007;
      ctx.lineCap = 'round';
      const n = 28;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        ctx.save();
        ctx.translate(c + Math.cos(a) * c * 0.865, c + Math.sin(a) * c * 0.865);
        ctx.rotate(a + Math.PI / 2);
        const gw = s * 0.018;
        const gh = s * 0.03;
        ctx.beginPath();
        ctx.moveTo(0, -gh);
        ctx.lineTo(0, gh);
        for (let st = 0; st < 2 + Math.floor(rnd() * 2); st++) {
          ctx.moveTo((rnd() - 0.5) * 2 * gw, (rnd() - 0.5) * 2 * gh);
          ctx.lineTo((rnd() - 0.5) * 2 * gw, (rnd() - 0.5) * 2 * gh);
        }
        ctx.stroke();
        ctx.restore();
      }
    });
    this.obeliskRuneDisc = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.62, 96),
      new THREE.MeshBasicMaterial({
        map: runeRingTex,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.obeliskRuneDisc.rotation.x = -Math.PI / 2;
    this.obeliskRuneDisc.position.set(0, 2.014, 0);
    this.obeliskRuneDisc.renderOrder = 2;
    obelisk.add(this.obeliskRuneDisc);

    // Stepped plinth: marble footing -> gold lip -> lapis drum with glowing inlays -> gold collar
    addMesh(new THREE.BoxGeometry(2.5, 0.2, 2.5), marbleMat, 0, 2.1, 0);
    addMesh(new THREE.BoxGeometry(2.3, 0.05, 2.3), goldMat, 0, 2.225, 0, false);
    addMesh(new THREE.BoxGeometry(2.1, 0.28, 2.1), lapisMat, 0, 2.39, 0);
    for (const [sx, sz, rotY] of [[0, -1.052, 0], [0, 1.052, 0], [-1.052, 0, Math.PI / 2], [1.052, 0, Math.PI / 2]]) {
      const strip = addMesh(new THREE.BoxGeometry(1.5, 0.035, 0.012), glowStripMat, sx, 2.39, sz, false);
      strip.rotation.y = rotY;
      for (const off of [-0.86, 0.86]) {
        const stud = addMesh(new THREE.OctahedronGeometry(0.055, 0), goldMat, 0, 2.39, 0, false);
        const ox = rotY ? 0 : off;
        const oz = rotY ? off : 0;
        stud.position.set(sx + ox, 2.39, sz + oz);
      }
    }
    addMesh(new THREE.BoxGeometry(1.98, 0.06, 1.98), goldMat, 0, 2.56, 0, false);

    // Tapered marble shaft carrying the glowing rune faces
    addMesh(
      squareFrustum(HW_TOP, HW_BOTTOM, SHAFT_TOP - SHAFT_BOTTOM, 10, true),
      this.obeliskShaftMat,
      0,
      (SHAFT_TOP + SHAFT_BOTTOM) / 2,
      0
    );

    // Gold corner mouldings running up every edge
    const up = new THREE.Vector3(0, 1, 0);
    for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = new THREE.Vector3(cx * (HW_BOTTOM + 0.01), SHAFT_BOTTOM, cz * (HW_BOTTOM + 0.01));
      const b = new THREE.Vector3(cx * (HW_TOP + 0.01), SHAFT_TOP, cz * (HW_TOP + 0.01));
      const len = a.distanceTo(b);
      const edge = addMesh(new THREE.CylinderGeometry(0.038, 0.045, len, 8), goldMat, 0, 0, 0, false);
      edge.position.copy(a).add(b).multiplyScalar(0.5);
      edge.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
    }

    // Gold band separating the sun crest from the rune column
    const bandY = 5.12;
    addMesh(squareFrustum(hwAt(bandY + 0.04) + 0.03, hwAt(bandY - 0.04) + 0.03, 0.08), goldMat, 0, bandY, 0, false);

    // Capital collar + gleaming gold pyramidion (tip exactly at the collider top y = 7.0)
    addMesh(squareFrustum(0.84, 0.8, 0.14), goldMat, 0, 6.32, 0);
    const pyramidion = addMesh(new THREE.ConeGeometry(0.8 * SQRT2, 0.61, 4), goldMat, 0, 6.695, 0);
    pyramidion.rotation.y = Math.PI / 4;

    // Soft energy beam rising from the tip into the crystal
    this.obeliskBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.16, 1.1, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: '#ffcf6b',
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.obeliskBeam.position.set(0, 7.55, 0);
    obelisk.add(this.obeliskBeam);

    this.scene.add(obelisk);

    // ---- Floating Sun Crystal (faceted glass shell around a white-hot core) ----
    const crystalGroup = new THREE.Group();
    crystalGroup.position.set(0, CRYSTAL_Y, 0);
    const shell = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.58, 0),
      new THREE.MeshPhysicalMaterial({
        color: '#ffe7a3',
        emissive: '#f59e0b',
        emissiveIntensity: 0.75,
        roughness: 0.06,
        metalness: 0.05,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        flatShading: true,
        transparent: true,
        opacity: 0.8,
      })
    );
    shell.scale.set(1, 1.65, 1);
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.26, 0),
      new THREE.MeshBasicMaterial({ color: '#fff6d5' })
    );
    core.scale.set(1, 1.6, 1);
    crystalGroup.add(core, shell);
    this.obeliskCrystal = crystalGroup;
    this.obeliskCrystalCore = core;
    this.scene.add(crystalGroup);

    // Tiny satellite shards orbiting inside the innermost ring
    this.obeliskShards = new THREE.Group();
    this.obeliskShards.position.set(0, CRYSTAL_Y, 0);
    const shardMat = new THREE.MeshStandardMaterial({
      color: '#fde68a',
      emissive: '#f59e0b',
      emissiveIntensity: 0.9,
      metalness: 0.3,
      roughness: 0.15,
      flatShading: true,
    });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), shardMat);
      shard.scale.set(1, 1.7, 1);
      shard.position.set(Math.cos(a) * 0.84, (i % 2 ? 0.08 : -0.08), Math.sin(a) * 0.84);
      this.obeliskShards.add(shard);
    }
    this.scene.add(this.obeliskShards);

    // Additive halo glow around the crystal
    const haloTex = this.makeTexture2D(128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255, 248, 220, 0.95)');
      g.addColorStop(0.22, 'rgba(255, 210, 110, 0.55)');
      g.addColorStop(0.55, 'rgba(255, 170, 60, 0.16)');
      g.addColorStop(1, 'rgba(255, 150, 40, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
    this.obeliskHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: haloTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.6,
      })
    );
    this.obeliskHalo.position.set(0, CRYSTAL_Y, 0);
    this.obeliskHalo.scale.set(4.2, 4.2, 1);
    this.scene.add(this.obeliskHalo);

    this.obeliskLight = new THREE.PointLight('#ffc861', 14, 18, 2);
    this.obeliskLight.position.set(0, CRYSTAL_Y, 0);
    this.scene.add(this.obeliskLight);

    // ---- Nested gimbal astrolabe, all rings concentric on the crystal ----
    // Max swept radius = 1.72 + 0.095 (ticks) ≈ 1.82 < CRYSTAL_Y - 7.0 (= 2.0), so rings stay clear of the pillar.
    const ringMat = new THREE.MeshStandardMaterial({
      color: '#f8c948',
      metalness: 1.0,
      roughness: 0.18,
      emissive: '#7c4a03',
      emissiveIntensity: 0.22,
    });
    const planetMat = (c) => new THREE.MeshBasicMaterial({ color: c });
    const astro = new THREE.Group();
    astro.position.set(0, CRYSTAL_Y, 0);
    astro.rotation.z = 0.22;

    const outerPivot = new THREE.Group();
    const outerRing = new THREE.Mesh(new THREE.TorusGeometry(1.72, 0.05, 12, 128), ringMat);
    outerPivot.add(outerRing);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.03, i % 3 === 0 ? 0.13 : 0.08, 0.05), ringMat);
      const r = 1.72 + (i % 3 === 0 ? 0.03 : 0.01);
      tick.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      tick.rotation.z = a - Math.PI / 2;
      outerPivot.add(tick);
    }
    const p1 = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 12), planetMat('#67e8f9'));
    p1.position.set(1.72, 0, 0);
    const p2 = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), planetMat('#fb7185'));
    p2.position.set(-1.72, 0, 0);
    outerPivot.add(p1, p2);

    const middlePivot = new THREE.Group();
    const middleRing = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.04, 10, 112), ringMat);
    middleRing.rotation.x = Math.PI / 2;
    const p3 = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), planetMat('#fde047'));
    p3.position.set(0, 0, 1.42);
    middlePivot.add(middleRing, p3);

    const innerPivot = new THREE.Group();
    const innerRing = new THREE.Mesh(new THREE.TorusGeometry(1.14, 0.035, 10, 96), ringMat);
    innerRing.rotation.y = Math.PI / 2;
    const p4 = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), planetMat('#c4b5fd'));
    p4.position.set(0, 1.14, 0);
    innerPivot.add(innerRing, p4);

    middlePivot.add(innerPivot);
    outerPivot.add(middlePivot);
    astro.add(outerPivot);
    this.scene.add(astro);
    this.obeliskRings = [outerPivot, middlePivot, innerPivot];

    // Sun motes spiralling lazily up around the shaft
    this.obeliskMotes = [];
    const moteGeo = new THREE.SphereGeometry(0.045, 8, 6);
    const moteMat = new THREE.MeshBasicMaterial({
      color: '#ffe08a',
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const moteCount = this.isMobile ? 10 : 16;
    for (let i = 0; i < moteCount; i++) {
      const mote = new THREE.Mesh(moteGeo, moteMat);
      mote.userData = {
        angle: (i / moteCount) * Math.PI * 2,
        radius: 1.45 + (i % 3) * 0.18,
        speed: 0.35 + (i % 4) * 0.08,
        phase: i / moteCount,
      };
      this.scene.add(mote);
      this.obeliskMotes.push(mote);
    }
  }

  makeTexture2D(size, drawFn) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    drawFn(c.getContext('2d'), size);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = this.maxAnisotropy;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  buildFunProps() {
    const whiteTrimMat = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.6 });
    const darkTimberMat = new THREE.MeshStandardMaterial({ color: '#78350f', roughness: 0.78 });
    const slateBlueMat = new THREE.MeshStandardMaterial({ color: '#1e3a8a', roughness: 0.65 });
    const brassMat = new THREE.MeshStandardMaterial({ color: '#fbbf24', metalness: 0.75, roughness: 0.25 });

    // 1) West Red Barn Pavilion atop gate_w_top (centered at x = -21.5, base y = 5.2, d = 10.8)
    const barnWallMat = new THREE.MeshStandardMaterial({ color: '#dc2626', roughness: 0.72 });
    const barnRoofMat = new THREE.MeshStandardMaterial({ color: '#991b1b', roughness: 0.65 });
    const barnGroup = new THREE.Group();
    barnGroup.position.set(-21.5, 5.2, 0);

    // Timber-framed red barn loft walls (fits strictly inside gate_w_top's 2.2 x 10.8m footprint)
    const barnBody = new THREE.Mesh(new THREE.BoxGeometry(2.08, 1.35, 10.1), barnWallMat);
    barnBody.position.y = 0.675;
    barnBody.castShadow = true;
    barnBody.receiveShadow = true;
    barnGroup.add(barnBody);

    // Triangular barn gable prism running along Z (-5.05..+5.05)
    const gableShape = new THREE.Shape();
    gableShape.moveTo(-1.04, 0);
    gableShape.lineTo(1.04, 0);
    gableShape.lineTo(0, 1.15);
    gableShape.closePath();
    const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: 10.1, bevelEnabled: false });
    const gableMesh = new THREE.Mesh(gableGeo, barnWallMat);
    gableMesh.position.set(0, 1.35, -5.05);
    gableMesh.castShadow = true;
    barnGroup.add(gableMesh);

    // Pitched red shingle roof panels seated flush on gable edges (x spans -1.38..+1.38, zero clip into wall_w)
    const pitchAngle = Math.atan2(1.15, 1.04); // ~0.835 rad
    const roofSlopeGeo = new THREE.BoxGeometry(1.9, 0.14, 10.7);
    for (const side of [-1, 1]) {
      const slope = new THREE.Mesh(roofSlopeGeo, barnRoofMat);
      slope.position.set(side * 0.689, 1.842, 0);
      slope.rotation.z = -side * pitchAngle;
      slope.castShadow = true;
      barnGroup.add(slope);
    }

    // White ridge beam, corner pilasters, and East-facing hayloft X-braced doors
    const ridgeBeam = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 10.76), whiteTrimMat);
    ridgeBeam.position.set(0, 2.54, 0);
    barnGroup.add(ridgeBeam);
    for (const zPil of [-4.98, -2.5, 2.5, 4.98]) {
      for (const xSide of [-1.03, 1.03]) {
        const pil = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.38, 0.14), whiteTrimMat);
        pil.position.set(xSide, 0.69, zPil);
        barnGroup.add(pil);
      }
    }
    const loftFrame = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 1.36), whiteTrimMat);
    loftFrame.position.set(1.06, 0.68, 0);
    const loftDoor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.94, 1.18), darkTimberMat);
    loftDoor.position.set(1.09, 0.68, 0);
    const loftBar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.24), whiteTrimMat);
    loftBar.position.set(1.1, 0.68, 0);
    const barnVanePost = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.75, 8), brassMat);
    barnVanePost.position.set(0, 2.94, 0);
    const barnVaneArrow = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.75), brassMat);
    barnVaneArrow.position.set(0, 3.21, 0);
    barnGroup.add(loftFrame, loftDoor, loftBar, barnVanePost, barnVaneArrow);
    this.scene.add(barnGroup);

    // 2) East Blue Windmill Pavilion atop gate_e_top (centered at x = 21.5, base y = 5.2, d = 10.8)
    const millTowerMat = new THREE.MeshStandardMaterial({ color: '#2563eb', roughness: 0.65 });
    const millRoofMat = new THREE.MeshStandardMaterial({ color: '#1d4ed8', roughness: 0.6 });
    const warmWindowMat = new THREE.MeshStandardMaterial({
      color: '#fef08a',
      emissive: '#f59e0b',
      emissiveIntensity: 0.8,
      roughness: 0.3,
    });
    const millGroup = new THREE.Group();
    millGroup.position.set(21.5, 5.2, 0);

    // Flanking stone balustrade copings + hipped side-pavilion caps along gate_e_top's north/south wings
    for (const zSide of [-1, 1]) {
      const wingBase = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.7, 3.3), slateBlueMat);
      wingBase.position.set(0, 0.35, zSide * 3.55);
      wingBase.castShadow = true;
      const wingCap = new THREE.Mesh(new THREE.ConeGeometry(1.75, 0.95, 4), millRoofMat);
      wingCap.position.set(0, 1.15, zSide * 3.55);
      wingCap.rotation.y = Math.PI / 4;
      wingCap.scale.set(0.84, 1, 1.32);
      wingCap.castShadow = true;
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), brassMat);
      finial.position.set(0, 1.66, zSide * 3.55);
      millGroup.add(wingBase, wingCap, finial);
    }

    // Tapered octagonal central windmill tower (fits cleanly inside gate_e_top's 2.2m depth)
    const millPlinth = new THREE.Mesh(new THREE.CylinderGeometry(1.06, 1.12, 1.1, 8), slateBlueMat);
    millPlinth.rotation.y = Math.PI / 8;
    millPlinth.position.y = 0.55;
    millPlinth.castShadow = true;
    const millBelt = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.16, 0.16, 8), darkTimberMat);
    millBelt.rotation.y = Math.PI / 8;
    millBelt.position.y = 1.12;
    const millBody = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.06, 2.7, 8), millTowerMat);
    millBody.rotation.y = Math.PI / 8;
    millBody.position.y = 2.55;
    millBody.castShadow = true;
    const millCornice = new THREE.Mesh(new THREE.CylinderGeometry(1.04, 0.94, 0.18, 8), darkTimberMat);
    millCornice.rotation.y = Math.PI / 8;
    millCornice.position.y = 3.95;
    const millCap = new THREE.Mesh(new THREE.ConeGeometry(1.24, 2.05, 8), millRoofMat);
    millCap.rotation.y = Math.PI / 8;
    millCap.position.y = 5.02;
    millCap.castShadow = true;
    const millSpire = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.08, 0.65, 8), brassMat);
    millSpire.position.y = 6.2;
    const millOrb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), brassMat);
    millOrb.position.y = 6.52;

    // Plaza-facing glowing loft window and protruding timber axle dormer
    const millWinFrame = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.72, 0.56), whiteTrimMat);
    millWinFrame.position.set(-1.02, 1.9, 0);
    const millWinGlass = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.54, 0.4), warmWindowMat);
    millWinGlass.position.set(-1.03, 1.9, 0);
    const axleDormer = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.42, 0.44), darkTimberMat);
    axleDormer.position.set(-1.25, 3.25, 0);
    axleDormer.castShadow = true;
    millGroup.add(
      millPlinth, millBelt, millBody, millCornice, millCap, millSpire, millOrb,
      millWinFrame, millWinGlass, axleDormer
    );
    this.scene.add(millGroup);

    // Proportional 4-blade windmill rotor mounted ahead of dormer (sweeps y = 5.35..11.55, clear of doorway & tower)
    this.windmillBlades = new THREE.Group();
    this.windmillBlades.position.set(19.72, 8.45, 0);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.48, 12), brassMat);
    hub.rotation.z = Math.PI / 2;
    this.windmillBlades.add(hub);

    const bladeWood = new THREE.MeshStandardMaterial({ color: '#fef3c7', roughness: 0.7 });
    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Group();
      arm.rotation.x = (i * Math.PI) / 2;
      const spar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.1, 0.14), darkTimberMat);
      spar.position.y = 1.55;
      spar.castShadow = true;
      const sail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.25, 0.72), bladeWood);
      sail.position.set(-0.04, 1.82, 0.38);
      sail.rotation.y = 0.12;
      sail.castShadow = true;
      const crossRung = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.74), darkTimberMat);
      crossRung.position.set(-0.02, 2.88, 0.38);
      arm.add(spar, sail, crossRung);
      this.windmillBlades.add(arm);
    }
    this.scene.add(this.windmillBlades);

    // 3) Sky-bridge outer balustrades matching fence_n / fence_s colliders (z = ±20.05) + low inner deck curbs
    const railWoodMat = new THREE.MeshStandardMaterial({
      map: this.textures?.wood,
      roughness: 0.7,
      metalness: 0.05,
    });
    for (const zEdge of [-20.05, 20.05]) {
      const topBar = new THREE.Mesh(new THREE.BoxGeometry(27.2, 0.14, 0.18), railWoodMat);
      topBar.position.set(0, 4.43, zEdge);
      topBar.castShadow = true;
      const midBar = new THREE.Mesh(new THREE.BoxGeometry(27.2, 0.09, 0.12), railWoodMat);
      midBar.position.set(0, 4.02, zEdge);
      this.scene.add(topBar, midBar);
      for (let x = -13.6; x <= 13.61; x += 3.4) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 0.18), railWoodMat);
        post.position.set(x, 4.05, zEdge);
        post.castShadow = true;
        this.scene.add(post);
      }
    }
    for (const zCurb of [-16.9, 16.9]) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(27.6, 0.1, 0.16), railWoodMat);
      curb.position.set(0, 3.65, zCurb);
      curb.receiveShadow = true;
      this.scene.add(curb);
    }

    // Diagonal timber knee braces under bastion decks for grounded structural detail
    for (const [cx, cz] of [[-20.5, -20.5], [20.5, -20.5], [-20.5, 20.5], [20.5, 20.5]]) {
      for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const px = cx + ox * 4.1;
        const pz = cz + oz * 4.1;
        if (Math.abs(px) > Math.abs(cx) && Math.abs(pz) > Math.abs(cz)) continue;
        const brace = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.3, 0.22), darkTimberMat);
        brace.position.set(px - ox * 0.42, 2.55, pz);
        brace.rotation.z = ox * 0.72;
        brace.castShadow = true;
        this.scene.add(brace);
      }
    }

    // 4) Bound round 3D hay-bale cylinders atop the hay cover blocks
    const hayMat = new THREE.MeshStandardMaterial({
      map: this.textures?.hay,
      bumpMap: this.textures?.hay,
      bumpScale: 0.035,
      roughness: 0.9,
    });
    const ropeMat = new THREE.MeshStandardMaterial({ color: '#78350f', roughness: 0.85 });
    for (const [hx, hz] of [[-14.5, -5.5], [-14.5, 5.5], [14.5, -5.5], [14.5, 5.5]]) {
      for (const dz of [-1.05, 1.05]) {
        const bale = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.55, 16), hayMat);
        bale.rotation.x = Math.PI / 2;
        bale.position.set(hx, 2.1, hz + dz);
        bale.castShadow = true;
        bale.receiveShadow = true;
        const band1 = new THREE.Mesh(new THREE.TorusGeometry(0.63, 0.035, 6, 18), ropeMat);
        band1.position.set(hx, 2.1, hz + dz - 0.38);
        const band2 = band1.clone();
        band2.position.z = hz + dz + 0.38;
        this.scene.add(bale, band1, band2);
      }
    }

    // 5) Stylized Oak & Pine Trees just outside the garden walls
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#78350f', roughness: 0.9 });
    const leafMats = [
      new THREE.MeshStandardMaterial({ color: '#22c55e', roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ color: '#16a34a', roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ color: '#4ade80', roughness: 0.8 }),
    ];
    const treeCoords = [
      [-28, -24], [-14, -29], [14, -29], [28, -24],
      [-28, 24], [-14, 29], [14, 29], [28, 24],
      [-30, -9], [-30, 9], [30, -9], [30, 9],
    ];
    treeCoords.forEach(([tx, tz], idx) => {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.8, 5.0, 8), trunkMat);
      trunk.position.y = 2.5;
      const crown1 = new THREE.Mesh(new THREE.DodecahedronGeometry(3.0, 1), leafMats[idx % 3]);
      crown1.position.y = 6.2;
      const crown2 = new THREE.Mesh(new THREE.DodecahedronGeometry(2.1, 1), leafMats[(idx + 1) % 3]);
      crown2.position.set(1.1, 7.6, 0.7);
      tree.add(trunk, crown1, crown2);
      tree.position.set(tx, 0, tz);
      this.scene.add(tree);
    });

    // 6) Colorful Tournament Bunting Flags above center bridges
    const flagColors = ['#ef4444', '#facc15', '#38bdf8', '#a855f7', '#22c55e'];
    for (const zPos of [-18.5, 18.5]) {
      for (let i = -12; i <= 12; i += 2.4) {
        const flag = new THREE.Mesh(
          new THREE.ConeGeometry(0.28, 0.65, 3),
          new THREE.MeshStandardMaterial({ color: flagColors[Math.abs(Math.round(i)) % flagColors.length] })
        );
        flag.rotation.x = Math.PI;
        flag.position.set(i, 6.2 - Math.cos((i / 14) * Math.PI * 0.5) * 0.5, zPos);
        this.scene.add(flag);
      }
    }

    // 7) Detailed 3D Goats perched on the outer garden walls
    const goatSpots = [
      { x: -12, y: 9.0, z: -25.0, ry: 0.2 },
      { x: 14, y: 9.0, z: 25.0, ry: Math.PI - 0.3 },
      { x: -25.0, y: 9.0, z: 12, ry: Math.PI / 2 },
      { x: 25.0, y: 9.0, z: -12, ry: -Math.PI / 2 },
    ];
    goatSpots.forEach((gs, idx) => {
      const goat = this.createGoatMesh();
      goat.position.set(gs.x, gs.y, gs.z);
      goat.rotation.y = gs.ry;
      goat.userData = { baseY: gs.y, phase: idx * 1.7 };
      this.scene.add(goat);
      this.goats.push(goat);
    });

    // 8) Cute Animated 3D Chickens perched cleanly on haystacks & bastion deck corners
    const chickenSpots = [
      { x: -14.5, y: 2.72, z: -5.5, ry: 0.7 },
      { x: 14.5, y: 2.72, z: 5.5, ry: -2.1 },
      { x: -17.2, y: 3.6, z: 17.5, ry: 0.9 },
      { x: 17.2, y: 3.6, z: -17.5, ry: -2.2 },
    ];
    chickenSpots.forEach((cs, idx) => {
      const chicken = this.createChickenMesh();
      chicken.position.set(cs.x, cs.y, cs.z);
      chicken.rotation.y = cs.ry;
      chicken.userData = { baseY: cs.y, phase: idx * 2.1 };
      this.scene.add(chicken);
      this.chickens.push(chicken);
    });
  }

  createGoatMesh() {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.78 });
    const cream = new THREE.MeshStandardMaterial({ color: '#fde68a', roughness: 0.65 });
    const hornMat = new THREE.MeshStandardMaterial({ color: '#d97706', roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.3 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.58, 1.24), white);
    body.position.y = 0.74;

    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.42, 0.34), white);
    neck.position.set(0, 0.98, 0.52);
    neck.rotation.x = 0.32;

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.48), white);
    head.position.set(0, 1.18, 0.74);

    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.26), cream);
    snout.position.set(0, 1.09, 1.03);

    // Goatee beard
    const beard = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 5), cream);
    beard.rotation.x = Math.PI;
    beard.position.set(0, 0.92, 0.96);

    // Floppy ears
    const earL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.14), cream);
    earL.position.set(-0.27, 1.24, 0.65);
    earL.rotation.z = 0.35;
    const earR = earL.clone();
    earR.position.x = 0.27;
    earR.rotation.z = -0.35;

    // 2-segment curved horns
    for (const side of [-1, 1]) {
      const hornBase = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 0.26, 6), hornMat);
      hornBase.position.set(side * 0.14, 1.45, 0.66);
      hornBase.rotation.set(-0.45, 0, side * -0.18);
      const hornTip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.22, 6), hornMat);
      hornTip.position.set(side * 0.18, 1.56, 0.5);
      hornTip.rotation.set(-1.05, 0, side * -0.22);
      g.add(hornBase, hornTip);
    }

    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), dark);
    eyeL.position.set(-0.21, 1.24, 0.84);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.21;

    // Tail
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.24, 0.14), cream);
    tail.position.set(0, 0.96, -0.62);
    tail.rotation.x = -0.5;

    // 4 articulated leg pivots
    const legs = [];
    for (const [lx, lz] of [[-0.22, -0.4], [0.22, -0.4], [-0.22, 0.4], [0.22, 0.4]]) {
      const legPivot = new THREE.Group();
      legPivot.position.set(lx, 0.48, lz);
      const legMesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.16), white);
      legMesh.position.y = -0.21;
      const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.09, 0.18), dark);
      hoof.position.y = -0.43;
      legPivot.add(legMesh, hoof);
      g.add(legPivot);
      legs.push(legPivot);
    }

    g.add(body, neck, head, snout, beard, earL, earR, eyeL, eyeR, tail);
    g.userData.legs = legs;
    g.scale.setScalar(1.35);
    return g;
  }

  createChickenMesh() {
    const c = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.75 });
    const red = new THREE.MeshStandardMaterial({ color: '#ef4444', roughness: 0.55 });
    const orange = new THREE.MeshStandardMaterial({ color: '#f97316', roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: '#0f172a' });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.52), white);
    body.position.y = 0.34;
    body.castShadow = true;

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), white);
    head.position.set(0, 0.58, 0.2);

    const comb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.22), red);
    comb.position.set(0, 0.76, 0.2);

    const wattle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.08), red);
    wattle.position.set(0, 0.46, 0.35);

    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 4), orange);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.56, 0.4);

    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), dark);
    eyeL.position.set(-0.14, 0.62, 0.28);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.14;

    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.14), white);
    tail.position.set(0, 0.46, -0.3);
    tail.rotation.x = 0.4;

    const wingL = new THREE.Group();
    wingL.position.set(-0.22, 0.42, 0);
    const wingLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.34), white);
    wingLMesh.position.y = -0.08;
    wingL.add(wingLMesh);

    const wingR = new THREE.Group();
    wingR.position.set(0.22, 0.42, 0);
    const wingRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.34), white);
    wingRMesh.position.y = -0.08;
    wingR.add(wingRMesh);

    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.05), orange);
    legL.position.set(-0.1, 0.09, 0.04);
    const legR = legL.clone();
    legR.position.x = 0.1;

    c.add(body, head, comb, wattle, beak, eyeL, eyeR, tail, wingL, wingR, legL, legR);
    c.userData.wingL = wingL;
    c.userData.wingR = wingR;
    c.scale.setScalar(1.2);
    return c;
  }

  buildSunPollen() {
    const count = 180;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 56;
      positions[i * 3 + 1] = 1 + Math.random() * 18;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 56;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: '#fef08a', size: 0.16, transparent: true, opacity: 0.75 });
    this.embers = new THREE.Points(geo, mat);
    this.scene.add(this.embers);
  }

  getPanTexture() {
    if (this.panTexture) return this.panTexture;
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2;
    const cy = size / 2;

    const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, cx);
    grad.addColorStop(0, '#3a4252');
    grad.addColorStop(0.55, '#2b313e');
    grad.addColorStop(0.9, '#1f242e');
    grad.addColorStop(1, '#313846');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Subtle concentric lathe-turned skillet rings
    for (let r = 10; r < cx; r += 4) {
      ctx.strokeStyle = r % 8 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.16)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Subtle cast-iron micro-grain
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.08)';
      ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.panTexture = tex;
    return tex;
  }

  /**
   * Sculpted high-detail cast-iron & gold-trimmed Battle Pan.
   * Handle grip sits at local (0, 0, 0), bowl extends forward along -Z.
   */
  createPanModel({ scale = 1, centerOnBowl = false } = {}) {
    const outer = new THREE.Group();
    const pan = new THREE.Group();
    if (centerOnBowl) {
      pan.position.set(0, -0.02, 0.34);
    }

    const skilletTex = this.getPanTexture();
    const ironMat = new THREE.MeshStandardMaterial({
      color: '#343b49',
      map: skilletTex,
      bumpMap: skilletTex,
      bumpScale: 0.008,
      metalness: 0.88,
      roughness: 0.28,
    });
    const baseSteelMat = new THREE.MeshStandardMaterial({
      color: '#64748b',
      metalness: 0.92,
      roughness: 0.22,
    });
    const goldMat = new THREE.MeshStandardMaterial({
      color: '#facc15',
      emissive: '#b45309',
      emissiveIntensity: 0.16,
      metalness: 0.9,
      roughness: 0.18,
    });
    const brassMat = new THREE.MeshStandardMaterial({
      color: '#d97706',
      metalness: 0.85,
      roughness: 0.25,
    });
    const woodMat = new THREE.MeshStandardMaterial({
      color: '#6b3a1e',
      roughness: 0.48,
      metalness: 0.05,
    });

    // 1) Sculpted Skillet Bowl (LatheGeometry ordered inner-top -> rim -> outer-wall -> bottom for outward normals)
    const bowlGroup = new THREE.Group();
    bowlGroup.position.set(0, 0.015, -0.42);
    const profile = [
      new THREE.Vector2(0.0, 0.004),
      new THREE.Vector2(0.172, 0.004),
      new THREE.Vector2(0.194, 0.016),
      new THREE.Vector2(0.228, 0.084),
      new THREE.Vector2(0.244, 0.091),
      new THREE.Vector2(0.253, 0.082),
      new THREE.Vector2(0.242, 0.066),
      new THREE.Vector2(0.205, 0.004),
      new THREE.Vector2(0.18, -0.013),
      new THREE.Vector2(0.165, -0.022),
      new THREE.Vector2(0.0, -0.022),
    ];
    const skilletGeo = new THREE.LatheGeometry(profile, 32);
    const skilletMesh = new THREE.Mesh(skilletGeo, ironMat);
    skilletMesh.castShadow = true;
    bowlGroup.add(skilletMesh);

    // Polished golden collar lip around the skillet rim
    const rimGold = new THREE.Mesh(new THREE.TorusGeometry(0.246, 0.011, 10, 32), goldMat);
    rimGold.rotation.x = Math.PI / 2;
    rimGold.position.y = 0.085;
    bowlGroup.add(rimGold);

    // Dual side pour spouts on left & right rim
    for (const side of [-1, 1]) {
      const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.036, 0.034, 8), ironMat);
      spout.position.set(side * 0.246, 0.084, 0);
      spout.rotation.z = side * -1.05;
      spout.scale.set(0.9, 1, 1.45);
      const spoutTrim = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.068), goldMat);
      spoutTrim.position.set(side * 0.256, 0.088, 0);
      spoutTrim.rotation.z = side * -0.25;
      bowlGroup.add(spout, spoutTrim);
    }

    // Brushed steel interior searing ring + golden center rune inlay
    const innerRing = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.0045, 6, 28), baseSteelMat);
    innerRing.rotation.x = Math.PI / 2;
    innerRing.position.y = 0.005;
    const innerEmblem = new THREE.Mesh(new THREE.OctahedronGeometry(0.042, 0), goldMat);
    innerEmblem.scale.set(1, 0.18, 1);
    innerEmblem.position.y = 0.005;
    bowlGroup.add(innerRing, innerEmblem);

    // Underside heat-diffuser concentric rings & golden sun medallion (looks crisp when held upright!)
    const baseRing1 = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.006, 8, 28), goldMat);
    baseRing1.rotation.x = Math.PI / 2;
    baseRing1.position.y = -0.022;
    const baseRing2 = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.005, 6, 24), baseSteelMat);
    baseRing2.rotation.x = Math.PI / 2;
    baseRing2.position.y = -0.022;
    const baseStar = new THREE.Mesh(new THREE.OctahedronGeometry(0.048, 0), goldMat);
    baseStar.scale.set(1, 0.22, 1);
    baseStar.position.y = -0.023;
    bowlGroup.add(baseRing1, baseRing2, baseStar);

    // 2) Cast-Brass Handle Bolster + Dual Dome Rivets
    const bolsterPlate = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.036, 0.03), brassMat);
    bolsterPlate.position.set(0, 0.072, -0.182);
    bolsterPlate.rotation.x = 0.25;
    pan.add(bolsterPlate);

    for (const rx of [-0.028, 0.028]) {
      const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), goldMat);
      rivet.position.set(rx, 0.075, -0.194);
      pan.add(rivet);
    }

    const neckTang = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.024, 0.135), brassMat);
    neckTang.position.set(0, 0.038, -0.132);
    neckTang.rotation.x = -0.42;
    pan.add(neckTang);

    // 3) Contoured Walnut Grip, Brass Ferrules & Hanging Eyelet Loop (grip centered at z = 0)
    const frontFerrule = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.023, 0.036, 12), goldMat);
    frontFerrule.rotation.x = Math.PI / 2;
    frontFerrule.position.set(0, 0.002, -0.075);

    const gripProfile = [
      new THREE.Vector2(0.023, -0.062),
      new THREE.Vector2(0.027, -0.02),
      new THREE.Vector2(0.024, 0.03),
      new THREE.Vector2(0.029, 0.085),
      new THREE.Vector2(0.025, 0.108),
    ];
    const gripGeo = new THREE.LatheGeometry(gripProfile, 14);
    const gripMesh = new THREE.Mesh(gripGeo, woodMat);
    gripMesh.rotation.x = Math.PI / 2;
    gripMesh.position.set(0, 0, 0.015);
    gripMesh.castShadow = true;

    const pommelCap = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.021, 0.032, 12), goldMat);
    pommelCap.rotation.x = Math.PI / 2;
    pommelCap.position.set(0, 0, 0.132);

    const eyelet = new THREE.Mesh(new THREE.TorusGeometry(0.023, 0.0065, 8, 16), goldMat);
    eyelet.rotation.x = Math.PI / 2;
    eyelet.position.set(0, 0, 0.165);

    pan.add(bowlGroup, frontFerrule, gripMesh, pommelCap, eyelet);
    outer.add(pan);
    outer.scale.setScalar(scale);
    return outer;
  }

  buildViewmodel() {
    this.viewmodelRoot = new THREE.Group();
    this.vmScene.add(this.viewmodelRoot);

    const goldMat = new THREE.MeshStandardMaterial({ color: '#facc15', metalness: 0.88, roughness: 0.18 });
    const steelMat = new THREE.MeshStandardMaterial({ color: '#e2e8f0', metalness: 0.92, roughness: 0.14 });
    const darkWood = new THREE.MeshStandardMaterial({ color: '#5c3317', roughness: 0.58 });
    const leatherMat = new THREE.MeshStandardMaterial({ color: '#451a03', roughness: 0.8 });
    const gauntletMat = new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.75, roughness: 0.3 });

    // Multi-part plated forearm & gauntlet
    const gauntletGroup = new THREE.Group();
    const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.088, 0.32), gauntletMat);
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.102, 0.102, 0.045), goldMat);
    cuff.position.z = -0.14;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.075, 0.09), gauntletMat);
    hand.position.set(0, 0.008, -0.2);
    for (let f = 0; f < 4; f++) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.036, 0.045), steelMat);
      finger.position.set(-0.027 + f * 0.018, 0.022, -0.245);
      finger.rotation.x = 0.55;
      gauntletGroup.add(finger);
    }
    gauntletGroup.add(forearm, cuff, hand);
    gauntletGroup.position.set(0.32, -0.34, -0.24);
    gauntletGroup.rotation.set(0.18, -0.1, 0);
    this.gauntletGroup = gauntletGroup;
    this.viewmodelRoot.add(gauntletGroup);

    // 1) Sculpted Arcane Staff (all head/shaft parts share one aligned axis group)
    this.vmStaff = new THREE.Group();
    const staffAxis = new THREE.Group();
    staffAxis.rotation.x = -Math.PI * 0.42;

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.84, 12), darkWood);
    shaft.position.y = 0.08;
    staffAxis.add(shaft);
    for (let b = 0; b < 5; b++) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.028 - b * 0.001, 0.005, 6, 14), goldMat);
      band.position.set(0, -0.14 + b * 0.095, 0);
      band.rotation.x = Math.PI / 2;
      staffAxis.add(band);
    }
    const lotusCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.024, 0.075, 12), goldMat);
    lotusCollar.position.set(0, 0.48, 0);
    staffAxis.add(lotusCollar);

    // 4 Golden Lotus Prongs cradling the floating crystal cleanly around the collar axis
    for (let p = 0; p < 4; p++) {
      const prongPivot = new THREE.Group();
      prongPivot.position.set(0, 0.51, 0);
      prongPivot.rotation.y = (p * Math.PI) / 2 + Math.PI / 4;
      const prong = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.14, 5), goldMat);
      prong.position.set(0.044, 0.055, 0);
      prong.rotation.z = -0.38;
      prongPivot.add(prong);
      staffAxis.add(prongPivot);
    }

    this.vmStaffCrystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.072, 0),
      new THREE.MeshStandardMaterial({ color: '#7dd3fc', emissive: '#0ea5e9', emissiveIntensity: 1.5, metalness: 0.45, roughness: 0.15 })
    );
    this.vmStaffCrystal.position.set(0, 0.61, 0);
    this.vmStaffRing = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.01, 8, 24), goldMat);
    this.vmStaffRing.position.set(0, 0.61, 0);
    this.vmStaffRing2 = new THREE.Mesh(
      new THREE.TorusGeometry(0.092, 0.008, 8, 24),
      new THREE.MeshBasicMaterial({ color: '#38bdf8' })
    );
    this.vmStaffRing2.position.set(0, 0.61, 0);
    staffAxis.add(this.vmStaffCrystal, this.vmStaffRing, this.vmStaffRing2);
    this.vmStaff.add(staffAxis);
    this.vmStaff.position.set(0.32, -0.26, -0.44);

    // 2) Sculpted Runeblade Greatsword
    this.vmBlade = new THREE.Group();
    const bladeMain = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.68, 0.016), steelMat);
    bladeMain.position.y = 0.26;
    const bladeTip = new THREE.Mesh(new THREE.ConeGeometry(0.048, 0.14, 4), steelMat);
    bladeTip.rotation.y = Math.PI / 4;
    bladeTip.scale.set(1, 1, 0.25);
    bladeTip.position.y = 0.67;
    const fuller = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.56, 0.022),
      new THREE.MeshStandardMaterial({ color: '#fbbf24', emissive: '#f59e0b', emissiveIntensity: 1.0 })
    );
    fuller.position.y = 0.26;
    // Dragon-wing crossguard + center jewel
    const guardCore = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.044, 0.052), goldMat);
    const wingL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.032, 0.042), goldMat);
    wingL.position.set(-0.1, 0.018, 0);
    wingL.rotation.z = -0.35;
    const wingR = wingL.clone();
    wingR.position.x = 0.1;
    wingR.rotation.z = 0.35;
    const guardGem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.026, 0),
      new THREE.MeshStandardMaterial({ color: '#38bdf8', emissive: '#0284c7', emissiveIntensity: 1.2 })
    );
    guardGem.position.z = 0.022;

    const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.025, 0.22, 10), leatherMat);
    hilt.position.y = -0.12;
    const pommel = new THREE.Mesh(new THREE.OctahedronGeometry(0.04, 0), goldMat);
    pommel.position.y = -0.25;
    this.vmBlade.add(bladeMain, bladeTip, fuller, guardCore, wingL, wingR, guardGem, hilt, pommel);
    this.vmBlade.position.set(0.36, -0.28, -0.52);
    this.vmBlade.rotation.set(-0.45, 0.25, 0.28);

    // 3) Sculpted Astral Rail Cannon
    this.vmRail = new THREE.Group();
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.09, 0.44),
      new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.85, roughness: 0.22 })
    );
    chassis.position.z = 0.14;
    const railL = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.028, 0.82), goldMat);
    railL.position.set(-0.032, 0.038, -0.1);
    const railR = railL.clone();
    railR.position.x = 0.032;
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(0.026, 0.026, 0.78),
      new THREE.MeshStandardMaterial({ color: '#e879f9', emissive: '#a855f7', emissiveIntensity: 1.6 })
    );
    core.position.set(0, 0.038, -0.1);
    for (let r = 0; r < 5; r++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.006, 6, 12), steelMat);
      rib.position.set(0, 0.038, -0.42 + r * 0.14);
      this.vmRail.add(rib);
    }
    const rearCrystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.042, 0),
      new THREE.MeshStandardMaterial({ color: '#c084fc', emissive: '#9333ea', emissiveIntensity: 1.4 })
    );
    rearCrystal.position.set(0, 0.06, 0.25);

    // Sculpted 3D Astral Sniper Scope Assembly
    const darkScopeMat = new THREE.MeshStandardMaterial({ color: '#0f172a', metalness: 0.86, roughness: 0.24 });
    const scopeLensMat = new THREE.MeshStandardMaterial({
      color: '#38bdf8',
      emissive: '#9333ea',
      emissiveIntensity: 1.15,
      metalness: 0.9,
      roughness: 0.08,
      transparent: true,
      opacity: 0.88,
    });
    const mountF = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.036, 0.03), goldMat);
    mountF.position.set(0, 0.082, -0.14);
    const mountR = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.036, 0.03), goldMat);
    mountR.position.set(0, 0.082, 0.06);

    const scopeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.34, 16), darkScopeMat);
    scopeBody.rotation.x = -Math.PI / 2;
    scopeBody.position.set(0, 0.112, -0.04);

    const objBell = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.023, 0.085, 16), darkScopeMat);
    objBell.rotation.x = -Math.PI / 2;
    objBell.position.set(0, 0.112, -0.24);
    const objRing = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.0045, 8, 20), goldMat);
    objRing.position.set(0, 0.112, -0.282);
    const objLens = new THREE.Mesh(new THREE.CircleGeometry(0.027, 16), scopeLensMat);
    objLens.rotation.y = Math.PI;
    objLens.position.set(0, 0.112, -0.283);

    const eyeBell = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.029, 0.07, 16), darkScopeMat);
    eyeBell.rotation.x = -Math.PI / 2;
    eyeBell.position.set(0, 0.112, 0.155);
    const eyeRing = new THREE.Mesh(new THREE.TorusGeometry(0.029, 0.0045, 8, 20), goldMat);
    eyeRing.position.set(0, 0.112, 0.19);
    const eyeLens = new THREE.Mesh(new THREE.CircleGeometry(0.025, 16), scopeLensMat);
    eyeLens.position.set(0, 0.112, 0.191);
    const holoDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.0045, 8, 8),
      new THREE.MeshBasicMaterial({ color: '#facc15' })
    );
    holoDot.position.set(0, 0.112, 0.192);

    const topTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.022, 10), goldMat);
    topTurret.position.set(0, 0.14, -0.04);
    const sideTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 10), goldMat);
    sideTurret.rotation.z = Math.PI / 2;
    sideTurret.position.set(0.028, 0.112, -0.04);

    this.vmRail.add(
      chassis,
      railL,
      railR,
      core,
      rearCrystal,
      mountF,
      mountR,
      scopeBody,
      objBell,
      objRing,
      objLens,
      eyeBell,
      eyeRing,
      eyeLens,
      holoDot,
      topTurret,
      sideTurret
    );
    this.vmRail.position.set(0.32, -0.24, -0.52);

    // Off-hand Arcane Aegis Shield with counter-rotating golden rings
    this.vmShield = new THREE.Group();
    const shieldHex = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 0.018, 6),
      new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.34 })
    );
    shieldHex.rotation.x = Math.PI / 2;
    this.vmShieldOuter = new THREE.Mesh(
      new THREE.TorusGeometry(0.28, 0.014, 6, 6),
      new THREE.MeshBasicMaterial({ color: '#facc15', transparent: true, opacity: 0.9 })
    );
    this.vmShieldInner = new THREE.Mesh(
      new THREE.TorusGeometry(0.18, 0.01, 6, 6),
      new THREE.MeshBasicMaterial({ color: '#fef08a', transparent: true, opacity: 0.85 })
    );
    this.vmShield.add(shieldHex, this.vmShieldOuter, this.vmShieldInner);
    this.vmShield.position.set(-0.22, -0.06, -0.48);
    this.vmShield.visible = false;

    // 4) Sculpted Golden Battle Pan gripped directly inside the plated gauntlet hand
    this.vmPan = this.createPanModel({ scale: 0.88 });
    this.vmPan.position.set(0, 0.012, -0.215);
    this.vmPan.rotation.set(0.75, 0.16, -0.45);
    this.vmPan.visible = false;
    this.gauntletGroup.add(this.vmPan);

    this.viewmodelRoot.add(this.vmStaff, this.vmBlade, this.vmRail, this.vmShield);
  }

  createPlayerMesh(p, mode, registerRemote = true) {
    const root = new THREE.Group();
    const team = p.tm ?? p.team ?? 0;
    const color = this.getTeamColor(team, p.id, mode);

    let seedHash = 0;
    const rawId = String(p.id || 'player');
    for (let i = 0; i < rawId.length; i++) seedHash = (seedHash * 31 + rawId.charCodeAt(i)) | 0;
    const animSeed = (Math.abs(seedHash) % 628) * 0.01;

    const armorMat = new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.38, metalness: 0.72 });
    const steelMat = new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.26, metalness: 0.85 });
    const clothMat = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.72 });
    const goldMat = new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.24, metalness: 0.86 });
    const accentMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      roughness: 0.3,
      metalness: 0.48,
    });
    const darkVisorMat = new THREE.MeshStandardMaterial({ color: '#090d16', roughness: 0.15, metalness: 0.85 });
    const eyeGlowMat = new THREE.MeshBasicMaterial({ color: '#fef08a' });
    const potionMat = new THREE.MeshStandardMaterial({
      color: '#38bdf8',
      emissive: '#0ea5e9',
      emissiveIntensity: 0.85,
      roughness: 0.15,
      transparent: true,
      opacity: 0.88,
    });
    const leatherMat = new THREE.MeshStandardMaterial({ color: '#78350f', roughness: 0.65, metalness: 0.1 });

    // Articulated Hip + Knee Pivots (hip at y = 0.72, knee at -0.32, boot sole at y = 0)
    const makeLegPivot = (xOffset, isRight) => {
      const hip = new THREE.Group();
      hip.position.set(xOffset, 0.72, 0);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.24), armorMat);
      thigh.position.y = -0.16;
      thigh.castShadow = true;
      const thighTrim = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.22, 0.12), goldMat);
      thighTrim.position.set(isRight ? 0.115 : -0.115, -0.15, 0);

      const kneePivot = new THREE.Group();
      kneePivot.position.set(0, -0.32, 0);
      const knee = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.27), goldMat);
      knee.position.set(0, 0, -0.02);
      const kneeWingL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, 0.15), goldMat);
      kneeWingL.position.set(-0.125, 0.01, -0.01);
      kneeWingL.rotation.x = 0.25;
      const kneeWingR = kneeWingL.clone();
      kneeWingR.position.x = 0.125;

      const greave = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.22), steelMat);
      greave.position.y = -0.17;
      greave.castShadow = true;
      const greaveGlow = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.22, 0.025), accentMat);
      greaveGlow.position.set(0, -0.17, -0.11);

      const bootCuff = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.055, 0.25), goldMat);
      bootCuff.position.set(0, -0.27, 0);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.3), armorMat);
      boot.position.set(0, -0.33, -0.03);
      const bootToe = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.12, 0.11, 8), steelMat);
      bootToe.scale.set(1.0, 0.65, 1.15);
      bootToe.position.set(0, -0.345, -0.14);
      const bootSole = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.04, 0.36), darkVisorMat);
      bootSole.position.set(0, -0.385, -0.05);
      kneePivot.add(knee, kneeWingL, kneeWingR, greave, greaveGlow, bootCuff, boot, bootToe, bootSole);

      hip.add(thigh, thighTrim, kneePivot);
      return { hip, kneePivot };
    };
    const legL = makeLegPivot(-0.15, false);
    const legR = makeLegPivot(0.15, true);
    const hipL = legL.hip;
    const kneeL = legL.kneePivot;
    const hipR = legR.hip;
    const kneeR = legR.kneePivot;

    // Isolated Pelvis Pivot at y = 0.72 (belt, buckle, tassets, potion flask & hip pouch)
    const pelvisGroup = new THREE.Group();
    pelvisGroup.position.set(0, 0.72, 0);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.1, 0.42), goldMat);
    belt.position.y = 0.04;
    const beltBuckle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.045), steelMat);
    beltBuckle.position.set(0, 0.04, -0.22);
    const beltGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), accentMat);
    beltGem.position.set(0, 0.04, -0.245);
    const rearHip = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.22, 0.26), armorMat);
    rearHip.position.set(0, -0.01, 0.08);
    rearHip.castShadow = true;

    // Waist tassets with gold trim strips mounted clear of hip swing arc
    const tassetL = new THREE.Group();
    tassetL.position.set(-0.35, 0, 0);
    tassetL.rotation.z = 0.28;
    const tassetPlateL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.34), accentMat);
    const tassetTrimL = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.045, 0.35), goldMat);
    tassetTrimL.position.y = -0.11;
    tassetL.add(tassetPlateL, tassetTrimL);
    const tassetR = tassetL.clone();
    tassetR.position.x = 0.35;
    tassetR.rotation.z = -0.28;

    // Fun Soul Potion Flask swinging on left hip
    const potionGroup = new THREE.Group();
    potionGroup.position.set(-0.33, -0.04, -0.12);
    const flaskBulb = new THREE.Mesh(new THREE.SphereGeometry(0.068, 10, 10), potionMat);
    flaskBulb.position.y = -0.06;
    const flaskNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.045, 8), goldMat);
    flaskNeck.position.y = 0.008;
    const flaskCork = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.018, 0.03, 8), leatherMat);
    flaskCork.position.y = 0.038;
    potionGroup.add(flaskBulb, flaskNeck, flaskCork);

    // Adventurer leather pouch on right hip
    const hipPouch = new THREE.Group();
    hipPouch.position.set(0.33, -0.04, 0.1);
    const pouchBody = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.15, 0.16), leatherMat);
    const pouchFlap = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.06, 0.17), leatherMat);
    pouchFlap.position.y = 0.05;
    const pouchStud = new THREE.Mesh(new THREE.OctahedronGeometry(0.028, 0), goldMat);
    pouchStud.position.set(0.068, 0.02, 0);
    hipPouch.add(pouchBody, pouchFlap, pouchStud);

    pelvisGroup.add(belt, beltBuckle, beltGem, rearHip, tassetL, tassetR, potionGroup, hipPouch);

    // Articulated Upper Body Pivot at waist y = 0.72 (offsets shifted by -0.72)
    const upperBody = new THREE.Group();
    upperBody.position.set(0, 0.72, 0);

    // Sculpted Torso, Breastplate, Gorget, Spinning Arcane Core & Winged Thruster Backpack
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.66, 0.38), armorMat);
    torso.position.y = 0.33;
    torso.castShadow = true;
    const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.42, 0.42), steelMat);
    chestPlate.position.y = 0.4;
    const gorget = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.1, 10), goldMat);
    gorget.position.y = 0.66;
    const chestTrimL = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.045, 0.03), goldMat);
    chestTrimL.position.set(-0.13, 0.5, -0.215);
    chestTrimL.rotation.z = -0.42;
    const chestTrimR = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.045, 0.03), goldMat);
    chestTrimR.position.set(0.13, 0.5, -0.215);
    chestTrimR.rotation.z = 0.42;

    const chestCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), accentMat);
    chestCore.position.set(0, 0.41, -0.22);
    const chestRing = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.018, 8, 24), goldMat);
    chestRing.position.set(0, 0.41, -0.22);

    // Backpack power crystal, orbiting gold ring, arcane mini-wings & jet thruster nozzles
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.38, 0.14), armorMat);
    pack.position.set(0, 0.4, 0.24);
    const packCrystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), accentMat);
    packCrystal.position.set(0, 0.46, 0.34);
    const packRing = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.016, 6, 20), goldMat);
    packRing.position.set(0, 0.46, 0.34);

    const makeWing = (side) => {
      const wing = new THREE.Group();
      wing.position.set(side * 0.16, 0.44, 0.28);
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.045, 0.035), goldMat);
      strut.position.set(side * 0.15, 0.06, 0);
      strut.rotation.z = side * 0.38;
      const blade1 = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.09, 0.025), accentMat);
      blade1.position.set(side * 0.26, 0.17, 0);
      blade1.rotation.z = side * 0.56;
      const blade2 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.075, 0.025), accentMat);
      blade2.position.set(side * 0.22, 0.03, 0);
      blade2.rotation.z = side * 0.22;
      wing.add(strut, blade1, blade2);
      return wing;
    };
    const wingL = makeWing(-1);
    const wingR = makeWing(1);

    for (const side of [-1, 1]) {
      const thruster = new THREE.Group();
      thruster.position.set(side * 0.11, 0.18, 0.25);
      thruster.rotation.set(0.45, 0, side * -0.15);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.12, 8), steelMat);
      const nozzleCore = new THREE.Mesh(new THREE.SphereGeometry(0.046, 8, 6), eyeGlowMat);
      nozzleCore.position.y = -0.055;
      thruster.add(nozzle, nozzleCore);
      upperBody.add(thruster);
    }

    // Articulated Shoulder Pivots at local y = 0.6 (world y = 1.32)
    const makeArmPivot = (xOffset, isRight) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(xOffset, 0.6, 0);
      const pauldron = new THREE.Mesh(new THREE.DodecahedronGeometry(0.19, 0), accentMat);
      pauldron.position.set(isRight ? 0.04 : -0.04, 0.04, 0);
      const pauldronTrim = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, 0.36), goldMat);
      pauldronTrim.position.set(isRight ? 0.04 : -0.04, -0.06, 0);
      const pauldronCrest = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.26), goldMat);
      pauldronCrest.position.set(isRight ? 0.04 : -0.04, 0.18, 0);
      const pauldronGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), accentMat);
      pauldronGem.position.set(isRight ? 0.21 : -0.21, 0.04, 0);

      const upperArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.18), clothMat);
      upperArm.position.y = -0.16;
      const vambrace = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.26, 0.2), steelMat);
      vambrace.position.y = -0.4;
      vambrace.castShadow = true;
      const gauntletCuff = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.22), goldMat);
      gauntletCuff.position.y = -0.29;
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.16), armorMat);
      hand.position.y = -0.56;
      const knucklePlate = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.06, 0.045), goldMat);
      knucklePlate.position.set(0, -0.56, -0.08);
      shoulder.add(pauldron, pauldronTrim, pauldronCrest, pauldronGem, upperArm, vambrace, gauntletCuff, hand, knucklePlate);
      return shoulder;
    };
    const shoulderL = makeArmPivot(-0.42, false);
    const shoulderR = makeArmPivot(0.42, true);

    // Detailed Multi-Part 3rd-Person Weapons attached to shoulderR hand
    const tpStaff = new THREE.Group();
    tpStaff.position.set(0, -0.56, -0.02);
    const tpStaffAxis = new THREE.Group();
    tpStaffAxis.rotation.x = -Math.PI * 0.42;
    const tpStaffRod = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, 1.3, 8), goldMat);
    tpStaffRod.position.y = 0.26;
    const tpStaffCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.036, 0.1, 8), goldMat);
    tpStaffCollar.position.y = 0.92;
    const tpStaffOrb = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.12, 0),
      new THREE.MeshStandardMaterial({ color: '#38bdf8', emissive: '#38bdf8', emissiveIntensity: 1.3 })
    );
    tpStaffOrb.position.y = 1.08;
    const tpStaffRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 6, 14), goldMat);
    tpStaffRing.position.copy(tpStaffOrb.position);
    tpStaffAxis.add(tpStaffRod, tpStaffCollar, tpStaffOrb, tpStaffRing);
    tpStaff.add(tpStaffAxis);

    const tpBlade = new THREE.Group();
    const tpBladeSteel = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 1.05, 0.028),
      new THREE.MeshStandardMaterial({ color: '#f8fafc', emissive: '#f59e0b', emissiveIntensity: 0.65, metalness: 0.88 })
    );
    tpBladeSteel.position.y = 0.45;
    const tpBladeGuard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.08), goldMat);
    const tpBladeHilt = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 8), armorMat);
    tpBladeHilt.position.y = -0.14;
    tpBlade.add(tpBladeSteel, tpBladeGuard, tpBladeHilt);
    tpBlade.rotation.x = -Math.PI * 0.36;
    tpBlade.position.set(0, -0.56, -0.1);

    const tpRail = new THREE.Group();
    const tpRailBody = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 1.05), armorMat);
    const tpRailGlow = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.98),
      new THREE.MeshStandardMaterial({ color: '#e879f9', emissive: '#a855f7', emissiveIntensity: 1.4 })
    );
    tpRailGlow.position.y = 0.06;
    const tpRailMountF = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.045, 0.045), goldMat);
    tpRailMountF.position.set(0, 0.095, -0.18);
    const tpRailMountR = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.045, 0.045), goldMat);
    tpRailMountR.position.set(0, 0.095, 0.08);
    const tpRailScopeTube = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.56, 10), armorMat);
    tpRailScopeTube.rotation.x = -Math.PI / 2;
    tpRailScopeTube.position.set(0, 0.145, -0.05);
    const tpRailScopeBell = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.034, 0.14, 10), armorMat);
    tpRailScopeBell.rotation.x = -Math.PI / 2;
    tpRailScopeBell.position.set(0, 0.145, -0.38);
    const tpRailScopeLens = new THREE.Mesh(
      new THREE.CircleGeometry(0.042, 10),
      new THREE.MeshBasicMaterial({ color: '#38bdf8' })
    );
    tpRailScopeLens.rotation.y = Math.PI;
    tpRailScopeLens.position.set(0, 0.145, -0.451);
    const tpRailScopeTurret = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 8), goldMat);
    tpRailScopeTurret.position.set(0, 0.185, -0.05);
    tpRail.add(
      tpRailBody,
      tpRailGlow,
      tpRailMountF,
      tpRailMountR,
      tpRailScopeTube,
      tpRailScopeBell,
      tpRailScopeLens,
      tpRailScopeTurret
    );
    tpRail.position.set(0, -0.52, -0.34);

    const tpPan = this.createPanModel({ scale: 1.05 });
    tpPan.position.set(0, -0.56, -0.02);
    tpPan.rotation.set(-0.28, 0, -0.18);
    tpPan.visible = false;

    shoulderR.add(tpStaff, tpBlade, tpRail, tpPan);

    // Sculpted Helmet Group: shell, cheek guard, recessed dark visor, expressive blinking LED eyes, horns, plume & halo
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.88, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.245, 16, 14), armorMat);
    head.castShadow = true;
    const cheekGuard = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.205, 0.16, 14), armorMat);
    cheekGuard.position.y = -0.11;
    const brow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.256, 0.256, 0.065, 14, 1, false, Math.PI * 0.72, Math.PI * 0.56),
      goldMat
    );
    brow.position.y = 0.065;
    const visorGlass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.248, 0.248, 0.095, 14, 1, false, Math.PI * 0.73, Math.PI * 0.54),
      darkVisorMat
    );
    visorGlass.position.y = 0.0;
    const chinGuard = new THREE.Mesh(
      new THREE.CylinderGeometry(0.236, 0.205, 0.048, 14, 1, false, Math.PI * 0.75, Math.PI * 0.5),
      goldMat
    );
    chinGuard.position.y = -0.065;

    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.032, 0.018), eyeGlowMat);
    eyeL.position.set(-0.068, 0.005, -0.246);
    eyeL.rotation.y = 0.24;
    const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.032, 0.018), eyeGlowMat);
    eyeR.position.set(0.068, 0.005, -0.246);
    eyeR.rotation.y = -0.24;
    for (const side of [-1, 1]) {
      const browFin = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.016, 0.024), goldMat);
      browFin.position.set(side * 0.07, 0.034, -0.25);
      browFin.rotation.set(0, side * -0.24, side * 0.22);
      headGroup.add(browFin);
    }

    const crestLower = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.36), accentMat);
    crestLower.position.set(0, 0.22, 0.03);
    const crestTip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.24), accentMat);
    crestTip.position.set(0, 0.31, 0.09);

    // Flowing Multi-Segment Heroic Plume Tail
    const plumeTail = new THREE.Group();
    plumeTail.position.set(0, 0.26, 0.22);
    const plume1 = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.22), accentMat);
    plume1.position.set(0, -0.02, 0.1);
    plume1.rotation.x = -0.35;
    const plume2 = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.075, 0.2), goldMat);
    plume2.position.set(0, -0.1, 0.26);
    plume2.rotation.x = -0.68;
    const plume3 = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.06, 0.16), accentMat);
    plume3.position.set(0, -0.2, 0.38);
    plume3.rotation.x = -0.95;
    plumeTail.add(plume1, plume2, plume3);

    // Floating Golden Sun Halo
    const haloRing = new THREE.Group();
    haloRing.position.set(0, 0.42, 0);
    haloRing.rotation.x = 0.18;
    const haloTorus = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 8, 24), goldMat);
    haloTorus.rotation.x = Math.PI / 2;
    haloRing.add(haloTorus);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const bead = new THREE.Mesh(new THREE.OctahedronGeometry(0.032, 0), accentMat);
      bead.position.set(Math.cos(a) * 0.21, 0, Math.sin(a) * 0.21);
      haloRing.add(bead);
    }

    headGroup.add(head, cheekGuard, brow, visorGlass, chinGuard, eyeL, eyeR, crestLower, crestTip, plumeTail, haloRing);
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.052, 0.24, 6), goldMat);
      horn.position.set(side * 0.23, 0.13, 0);
      horn.rotation.z = side * -0.68;
      horn.rotation.x = -0.18;
      headGroup.add(horn);
    }

    // Embroidered Cape suspended from top-shoulder clasps behind the power crystal
    const cape = new THREE.Group();
    cape.position.set(0, 0.62, 0.31);
    const capeCloth = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.92, 0.045), accentMat);
    capeCloth.position.set(0, -0.46, 0.02);
    capeCloth.castShadow = true;
    const capeTrim = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.055), goldMat);
    capeTrim.position.set(0, -0.9, 0.02);
    const capeBorderL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.88, 0.052), goldMat);
    capeBorderL.position.set(-0.26, -0.46, 0.02);
    const capeBorderR = capeBorderL.clone();
    capeBorderR.position.x = 0.26;
    const capeEmblem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), goldMat);
    capeEmblem.scale.set(1, 1.35, 0.22);
    capeEmblem.position.set(0, -0.42, 0.046);
    cape.add(capeCloth, capeTrim, capeBorderL, capeBorderR, capeEmblem);
    for (const side of [-1, 1]) {
      const clasp = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 10), goldMat);
      clasp.rotation.x = Math.PI / 2;
      clasp.position.set(side * 0.24, 0.0, 0.025);
      const claspGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.032, 0), accentMat);
      claspGem.position.set(side * 0.24, 0.0, 0.042);
      cape.add(clasp, claspGem);
    }
    cape.rotation.x = -0.18;

    // Blocking Aegis Aura
    const shield = new THREE.Mesh(
      new THREE.CylinderGeometry(0.64, 0.64, 0.06, 6),
      new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.45 })
    );
    shield.rotation.x = Math.PI / 2;
    shield.position.set(0, 0.38, -0.58);
    shield.visible = false;

    // Full-Body 2s Revive Shimmer Protection Aura
    const spawnAura = new THREE.Group();
    spawnAura.position.set(0, 0.98, 0);
    spawnAura.visible = false;

    const auraShellMat = new THREE.MeshBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    const auraShell = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12), auraShellMat);
    auraShell.scale.set(0.95, 1.62, 0.95);

    const auraLatticeMat = new THREE.MeshBasicMaterial({
      color: '#fef08a',
      wireframe: true,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const auraLattice = new THREE.Mesh(new THREE.SphereGeometry(0.64, 12, 8), auraLatticeMat);
    auraLattice.scale.set(0.97, 1.64, 0.97);

    const auraRingMat = new THREE.MeshBasicMaterial({
      color: '#7dd3fc',
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const auraRing1 = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.02, 8, 28), auraRingMat);
    auraRing1.rotation.x = Math.PI / 2;
    const auraRing2 = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.02, 8, 28), auraRingMat);
    auraRing2.rotation.x = Math.PI / 2;

    spawnAura.add(auraShell, auraLattice, auraRing1, auraRing2);

    // Crisp 320x80 Name & Health Sprite
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 80;
    const spriteTex = new THREE.CanvasTexture(canvas);
    spriteTex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTex, transparent: true, depthTest: false }));
    sprite.position.set(0, 2.38, 0);
    sprite.scale.set(1.95, 0.49, 1);

    // Crisp Emote Pop Badge above Nameplate
    const emoCanvas = document.createElement('canvas');
    emoCanvas.width = 240;
    emoCanvas.height = 56;
    const emoTex = new THREE.CanvasTexture(emoCanvas);
    emoTex.colorSpace = THREE.SRGBColorSpace;
    const emoteSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: emoTex, transparent: true, depthTest: false }));
    emoteSprite.position.set(0, 2.95, 0);
    emoteSprite.scale.set(1.4, 0.33, 1);
    emoteSprite.visible = false;

    upperBody.add(
      torso,
      chestPlate,
      gorget,
      chestTrimL,
      chestTrimR,
      chestCore,
      chestRing,
      pack,
      packCrystal,
      packRing,
      wingL,
      wingR,
      shoulderL,
      shoulderR,
      headGroup,
      cape,
      shield
    );

    root.add(
      hipL,
      hipR,
      pelvisGroup,
      upperBody,
      spawnAura,
      sprite,
      emoteSprite
    );
    this.scene.add(root);

    const record = {
      root,
      hipL,
      hipR,
      kneeL,
      kneeR,
      pelvisGroup,
      upperBody,
      shoulderL,
      shoulderR,
      headGroup,
      cape,
      chestCore,
      chestRing,
      packCrystal,
      packRing,
      wingL,
      wingR,
      eyeL,
      eyeR,
      haloRing,
      plumeTail,
      potionGroup,
      animSeed,
      tpStaff,
      tpBlade,
      tpRail,
      tpPan,
      shield,
      spawnAura,
      auraShellMat,
      auraLattice,
      auraLatticeMat,
      auraRing1,
      auraRing2,
      auraRingMat,
      bodyMats: [armorMat, steelMat, clothMat, goldMat],
      sprite,
      emoteSprite,
      emoteCanvas: emoCanvas,
      emoteTex: emoTex,
      lastEmoteKey: '',
      emote: null,
      labelCanvas: canvas,
      labelTex: spriteTex,
      lastLabelKey: '',
      armorMat,
      accentMat,
      lastColor: color,
      wasAlive: true,
      deathTumble: 0,
      attackAnim: 0,
      panSwingAnim: 0,
    };
    if (registerRemote) this.playerMeshes.set(p.id, record);
    return record;
  }

  getTeamColor(team, id, mode) {
    if (mode === GAME_MODES.TDM) {
      return team === TEAMS.CRIMSON ? '#ef4444' : '#38bdf8';
    }
    const palette = ['#f59e0b', '#a855f7', '#10b981', '#ec4899', '#0ea5e9', '#f97316'];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
  }

  updateSpawnProtectionVisuals(rec, spawnShield, slowTimer, timeSec) {
    if (spawnShield > 0) {
      const shimmer = 0.5 + 0.5 * Math.sin(timeSec * 22);
      const blink = spawnShield < 0.5 ? 0.55 + 0.45 * Math.sin(timeSec * 38) : 1.0;
      const emissiveHex = shimmer > 0.5 ? '#38bdf8' : '#fef08a';
      const intensity = (0.65 + shimmer * 0.6) * blink;

      for (const mat of rec.bodyMats) {
        mat.emissive.set(emissiveHex);
        mat.emissiveIntensity = intensity;
      }

      if (rec.spawnAura) {
        rec.spawnAura.visible = true;
        rec.auraLattice.rotation.y = timeSec * 2.8;
        rec.auraRing1.position.y = Math.sin(timeSec * 6.5) * 0.65;
        rec.auraRing2.position.y = -Math.sin(timeSec * 6.5) * 0.65;
        rec.auraRing1.rotation.z = timeSec * 2.1;
        rec.auraRing2.rotation.z = -timeSec * 2.1;
        rec.auraShellMat.color.set(shimmer > 0.5 ? '#38bdf8' : '#7dd3fc');
        rec.auraShellMat.opacity = (0.18 + shimmer * 0.16) * blink;
        rec.auraLatticeMat.opacity = (0.28 + (1 - shimmer) * 0.25) * blink;
        rec.auraRingMat.opacity = (0.62 + shimmer * 0.3) * blink;
      }
    } else {
      if (rec.spawnAura?.visible) {
        rec.spawnAura.visible = false;
        for (const mat of rec.bodyMats) {
          if (mat !== rec.armorMat) {
            mat.emissive.set('#000000');
            mat.emissiveIntensity = 0;
          }
        }
      }
      rec.armorMat.emissive.set(slowTimer > 0 ? '#38bdf8' : '#000000');
      rec.armorMat.emissiveIntensity = slowTimer > 0 ? 0.55 : 0;
    }
  }

  updatePlayerLabel(rec, name, hp, maxHp, color, shielded = false) {
    const key = `${name}:${hp}:${maxHp}:${color}:${shielded ? 1 : 0}`;
    if (rec.lastLabelKey === key) return;
    rec.lastLabelKey = key;

    const ctx = rec.labelCanvas.getContext('2d');
    ctx.clearRect(0, 0, 320, 80);

    // Rounded pill background
    ctx.fillStyle = shielded ? 'rgba(12, 30, 58, 0.84)' : 'rgba(10, 14, 26, 0.72)';
    ctx.beginPath();
    ctx.roundRect(24, 6, 272, 66, 14);
    ctx.fill();
    ctx.strokeStyle = shielded ? '#7dd3fc' : color;
    ctx.lineWidth = shielded ? 4 : 3;
    ctx.stroke();

    ctx.font = 'bold 24px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const labelText = shielded ? `✦ ${name} · SHIELD` : name;
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillText(labelText, 161, 35);
    ctx.fillStyle = shielded ? '#fef08a' : '#ffffff';
    ctx.fillText(labelText, 160, 34);

    // Segmented HP bar
    const barW = 220;
    const barH = 14;
    const x = 50;
    const y = 46;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(x - 2, y - 2, barW + 4, barH + 4);
    const ratio = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
    ctx.fillStyle = shielded ? '#fde047' : color;
    ctx.fillRect(x, y, barW * ratio, barH);

    // Subtle segment ticks
    ctx.fillStyle = 'rgba(10, 14, 26, 0.55)';
    for (let s = 1; s < 5; s++) {
      ctx.fillRect(x + (barW * s) / 5 - 1, y, 2, barH);
    }

    rec.labelTex.needsUpdate = true;
  }

  triggerFireAnim(weaponId) {
    this.recoil = weaponId === 'rail' ? 0.22 : weaponId === 'runeblade' || weaponId === 'pan' ? 0.14 : 0.08;
    if (weaponId === 'runeblade') this.swingAnim = 1.0;
    if (weaponId === 'pan') this.panSwingAnim = 1.0;
    if (this.localAvatarRec) {
      this.localAvatarRec.attackAnim = 1.0;
      if (weaponId === 'pan') this.localAvatarRec.panSwingAnim = 1.0;
    }
  }

  applyLocomotionPose(rec, x, y, z, yaw, pitch, vx, vz, blocking, weaponId, timeSec) {
    const seed = rec.animSeed || 0;
    rec.root.rotation.x = 0;
    rec.root.rotation.z = 0;
    rec.root.position.set(x, y, z);
    rec.root.rotation.y = yaw;

    const headPitch = Math.max(-0.55, Math.min(0.55, (pitch || 0) * 0.5));
    rec.headGroup.rotation.set(headPitch, 0, 0);
    rec.hipL.position.set(-0.15, 0.72, 0);
    rec.hipR.position.set(0.15, 0.72, 0);
    rec.hipL.rotation.y = 0;
    rec.hipR.rotation.y = 0;
    rec.hipL.rotation.z = 0;
    rec.hipR.rotation.z = 0;
    rec.pelvisGroup.position.set(0, 0.72, 0);
    rec.pelvisGroup.rotation.set(0, 0, 0);
    rec.upperBody.rotation.set(0, 0, 0);
    rec.shoulderL.rotation.y = 0;
    rec.shoulderR.rotation.y = 0;

    const spd = Math.hypot(vx || 0, vz || 0);
    const stride = spd > 0.6 ? Math.sin(timeSec * 11 + x * 0.3) * Math.min(0.75, spd * 0.1) : 0;
    const idleBob = spd <= 0.6 ? Math.sin(timeSec * 2.8 + seed) * 0.018 : Math.abs(stride) * 0.035;
    rec.upperBody.position.set(0, 0.72 + idleBob, 0);

    rec.hipL.rotation.x = stride;
    rec.hipR.rotation.x = -stride;
    rec.kneeL.rotation.set(Math.min(0, stride * 0.55), 0, 0);
    rec.kneeR.rotation.set(Math.min(0, -stride * 0.55), 0, 0);

    if (blocking) {
      rec.shoulderL.rotation.x = 0.78;
      rec.shoulderL.rotation.z = 0.28;
    } else {
      rec.shoulderL.rotation.x = -stride * 0.7;
      rec.shoulderL.rotation.z = 0;
    }

    const showPan = weaponId === 'pan' || (rec.panSwingAnim || 0) > 0;
    rec.shoulderR.rotation.z = showPan ? -0.14 : 0;
    rec.shoulderR.rotation.x =
      (showPan ? 0.32 : 0) + stride * 0.4 + Math.sin(rec.attackAnim * Math.PI) * (showPan ? 1.65 : 1.45);
    rec.cape.rotation.x = -0.18 - Math.min(0.48, spd * 0.05) - Math.sin(timeSec * 6) * 0.04;

    if (rec.chestCore) rec.chestCore.rotation.y = timeSec * 2.2 + seed;
    if (rec.chestRing) rec.chestRing.rotation.z = -timeSec * 1.6 + seed;
    if (rec.packCrystal) rec.packCrystal.rotation.y = -timeSec * 2.6 + seed;
    if (rec.packRing) rec.packRing.rotation.z = timeSec * 1.9 + seed;
    if (rec.haloRing) {
      rec.haloRing.position.y = 0.42 + Math.sin(timeSec * 3.4 + seed) * 0.025;
      rec.haloRing.rotation.y = timeSec * 1.4 + seed;
    }
    if (rec.wingL && rec.wingR) {
      const wingSweep = 0.32 + Math.min(0.35, spd * 0.04) + Math.sin(timeSec * 9 + seed) * 0.08;
      const wingFlap = Math.sin(timeSec * 9 + seed) * 0.1;
      rec.wingL.rotation.set(0, wingSweep, wingFlap);
      rec.wingR.rotation.set(0, -wingSweep, -wingFlap);
    }
    if (rec.plumeTail) {
      rec.plumeTail.rotation.x = -0.06 - Math.min(0.42, spd * 0.045) + Math.sin(timeSec * 7.5 + seed) * 0.08;
    }
    if (rec.potionGroup) {
      rec.potionGroup.rotation.x = stride * 0.35 + Math.sin(timeSec * 4.5 + seed) * 0.05;
      rec.potionGroup.rotation.z = 0.06 + Math.sin(timeSec * 3.2 + seed) * 0.05;
    }
    if (rec.eyeL && rec.eyeR) {
      const isAttacking = (rec.attackAnim || 0) > 0.1 || (rec.panSwingAnim || 0) > 0.1;
      const blink = isAttacking ? 0.42 : Math.sin(timeSec * 1.7 + seed) > 0.96 ? 0.12 : 1.0;
      const sx = isAttacking ? 1.15 : 1.0;
      rec.eyeL.scale.set(sx, blink, 1);
      rec.eyeR.scale.set(sx, blink, 1);
    }

    rec.tpStaff.visible = !showPan && (!weaponId || weaponId === 'staff');
    rec.tpBlade.visible = !showPan && weaponId === 'runeblade';
    rec.tpRail.visible = !showPan && weaponId === 'rail';
    if (rec.tpPan) rec.tpPan.visible = showPan;
  }

  triggerRemoteAttack(playerId, isPan = false) {
    const rec = this.playerMeshes.get(playerId);
    if (rec) {
      rec.attackAnim = 1.0;
      if (isPan) rec.panSwingAnim = 1.0;
    }
  }

  triggerLocalEmote(emoteId, camYaw, pos) {
    const em = EMOTES[emoteId];
    if (!em) return;
    this.localEmote = {
      id: emoteId,
      elapsed: 0,
      duration: em.duration,
      camYaw: camYaw ?? this.camera.rotation.y,
    };
    if (pos) this.spawnEmoteVfx(emoteId, pos.x, pos.y, pos.z);
  }

  cancelLocalEmote() {
    this.localEmote = null;
    if (this.localAvatarRec) this.localAvatarRec.root.visible = false;
  }

  triggerRemoteEmote(playerId, emoteId) {
    const em = EMOTES[emoteId];
    const rec = this.playerMeshes.get(playerId);
    if (!em || !rec) return;
    rec.emote = { id: emoteId, elapsed: 0, duration: em.duration };
    this.updateEmoteBadge(rec, em);
    this.spawnEmoteVfx(emoteId, rec.root.position.x, rec.root.position.y, rec.root.position.z);
  }

  updateEmoteBadge(rec, em) {
    if (rec.lastEmoteKey === em.id) return;
    rec.lastEmoteKey = em.id;

    const ctx = rec.emoteCanvas.getContext('2d');
    ctx.clearRect(0, 0, 240, 56);
    ctx.fillStyle = '#fffdf6';
    ctx.beginPath();
    ctx.roundRect(14, 6, 212, 44, 12);
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = em.color;
    ctx.beginPath();
    ctx.arc(40, 28, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '900 22px "Trebuchet MS", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0f172a';
    ctx.fillText(em.name.toUpperCase(), 132, 36);
    rec.emoteTex.needsUpdate = true;
  }

  spawnEmoteVfx(emoteId, x, y, z) {
    if (emoteId === 'dance' || emoteId === 'cheer' || emoteId === 'twerk') {
      this.addConfettiBurst(x, y + 0.35, z);
    }
    if (emoteId === 'twerk') {
      this.addRing(x, y + 0.08, z, 1.9, '#f43f5e', 0.45);
    } else if (emoteId === 'spin') {
      this.addRing(x, y + 0.08, z, 2.0, '#0ea5e9', 0.5);
    }
  }

  applyEmotePose(rec, emoteId, elapsed, duration, x, y, z, yaw, weaponId) {
    const t = elapsed;
    const seed = rec.animSeed || 0;
    const p = Math.min(1, elapsed / Math.max(0.01, duration));
    let extraY = 0;
    let rotX = 0;
    let rotY = yaw;
    let rotZ = 0;

    rec.headGroup.rotation.set(0, 0, 0);
    rec.hipL.position.set(-0.15, 0.72, 0);
    rec.hipR.position.set(0.15, 0.72, 0);
    rec.hipL.rotation.set(0, 0, 0);
    rec.hipR.rotation.set(0, 0, 0);
    rec.kneeL.rotation.set(0, 0, 0);
    rec.kneeR.rotation.set(0, 0, 0);
    rec.pelvisGroup.position.set(0, 0.72, 0);
    rec.pelvisGroup.rotation.set(0, 0, 0);
    rec.upperBody.position.set(0, 0.72, 0);
    rec.upperBody.rotation.set(0, 0, 0);
    rec.shoulderL.rotation.set(0, 0, 0);
    rec.shoulderR.rotation.set(0, 0, 0);
    rec.cape.rotation.x = -0.22;

    if (rec.chestCore) rec.chestCore.rotation.y = t * 3.0 + seed;
    if (rec.chestRing) rec.chestRing.rotation.z = -t * 2.4 + seed;
    if (rec.packCrystal) rec.packCrystal.rotation.y = -t * 3.2 + seed;
    if (rec.packRing) rec.packRing.rotation.z = t * 2.5 + seed;
    if (rec.haloRing) {
      rec.haloRing.position.y = 0.42 + Math.sin(t * 4.5 + seed) * 0.03;
      rec.haloRing.rotation.y = t * 2.2 + seed;
    }
    if (rec.wingL && rec.wingR) {
      rec.wingL.rotation.set(0, 0.35, 0);
      rec.wingR.rotation.set(0, -0.35, 0);
    }
    if (rec.plumeTail) rec.plumeTail.rotation.set(-0.08, 0, 0);
    if (rec.potionGroup) rec.potionGroup.rotation.set(0, 0, 0.06);
    let eyeScaleY = Math.sin(t * 2.1 + seed) > 0.96 ? 0.12 : 1.0;

    if (emoteId === 'wave') {
      extraY = Math.abs(Math.sin(t * 6)) * 0.07;
      rec.shoulderR.rotation.z = 2.52 + Math.sin(t * 11) * 0.36;
      rec.shoulderR.rotation.x = 0.25;
      rec.shoulderL.rotation.z = -0.18;
      rec.headGroup.rotation.z = Math.sin(t * 5.5) * 0.14;
      eyeScaleY = 0.45;
      if (rec.wingL && rec.wingR) {
        const w = 0.32 + Math.sin(t * 8) * 0.12;
        rec.wingL.rotation.set(0, w, Math.sin(t * 8) * 0.1);
        rec.wingR.rotation.set(0, -w, -Math.sin(t * 8) * 0.1);
      }
      if (rec.plumeTail) rec.plumeTail.rotation.z = Math.sin(t * 6) * 0.12;
    } else if (emoteId === 'dance') {
      const beat = t * 9.5;
      extraY = Math.abs(Math.sin(beat)) * 0.22;
      rotZ = Math.sin(beat * 0.5) * 0.16;
      rotY = yaw + Math.sin(beat * 0.5) * 0.28;
      rec.hipL.rotation.x = Math.sin(beat) * 0.55;
      rec.hipR.rotation.x = -Math.sin(beat) * 0.55;
      rec.shoulderL.rotation.z = -0.65 - Math.max(0, Math.sin(beat)) * 1.45;
      rec.shoulderR.rotation.z = 0.65 + Math.max(0, -Math.sin(beat)) * 1.45;
      rec.shoulderL.rotation.x = Math.cos(beat) * 0.5;
      rec.shoulderR.rotation.x = -Math.cos(beat) * 0.5;
      rec.headGroup.rotation.z = -Math.sin(beat * 0.5) * 0.18;
      rec.cape.rotation.x = -0.45 - Math.abs(Math.sin(beat)) * 0.32;
      eyeScaleY = 0.38;
      if (rec.wingL && rec.wingR) {
        const flap = Math.sin(beat * 2) * 0.28;
        rec.wingL.rotation.set(0, 0.28, flap);
        rec.wingR.rotation.set(0, -0.28, -flap);
      }
      if (rec.plumeTail) rec.plumeTail.rotation.x = -0.18 - Math.abs(Math.sin(beat)) * 0.25;
      if (rec.potionGroup) rec.potionGroup.rotation.x = Math.sin(beat) * 0.25;
    } else if (emoteId === 'twerk') {
      // Grounded wide bent-knee squat with isolated pelvic snaps, hands on knees & over-shoulder lookback
      const drop = Math.min(1, t / 0.14);
      const beat = t * Math.PI * 5.2;
      const pulse = drop * Math.pow(0.5 - 0.5 * Math.cos(beat), 1.75);
      const sway = drop * Math.sin(beat * 0.5);

      rotY = yaw + 1.15 * drop + sway * 0.08;
      const hipY = 0.72 - drop * (0.12 - pulse * 0.032);
      const hipZ = drop * (0.14 + pulse * 0.02);
      const hipSpread = drop * 0.04;
      const hipPitch = drop * (0.86 - pulse * 0.11);
      const kneeBend = -drop * (0.91 - pulse * 0.12);

      rec.hipL.position.set(-0.15 - hipSpread + sway * 0.015, hipY, hipZ);
      rec.hipR.position.set(0.15 + hipSpread + sway * 0.015, hipY, hipZ);
      rec.hipL.rotation.set(hipPitch, drop * 0.18, -drop * 0.24 - sway * 0.05);
      rec.hipR.rotation.set(hipPitch, -drop * 0.18, drop * 0.24 - sway * 0.05);
      rec.kneeL.rotation.set(kneeBend, 0, drop * 0.12);
      rec.kneeR.rotation.set(kneeBend, 0, -drop * 0.12);

      rec.pelvisGroup.position.set(
        sway * 0.055,
        hipY + drop * (0.01 + pulse * 0.08),
        hipZ + drop * (0.02 + pulse * 0.07)
      );
      rec.pelvisGroup.rotation.set(-drop * (0.20 + pulse * 0.62), sway * 0.18, sway * 0.22);

      rec.upperBody.position.set(
        sway * 0.018,
        hipY + drop * (0.01 + pulse * 0.03),
        hipZ * 0.72
      );
      rec.upperBody.rotation.set(-drop * (0.80 - pulse * 0.12), -sway * 0.06, -sway * 0.07);

      rec.shoulderL.rotation.set(drop * (0.44 + pulse * 0.08), 0, drop * 0.22);
      rec.shoulderR.rotation.set(drop * (0.44 + pulse * 0.08), 0, -drop * 0.22);
      rec.headGroup.rotation.set(
        0.35 * drop,
        1.85 * drop,
        (0.35 + sway * 0.14) * drop
      );
      rec.cape.rotation.x = -0.22 - drop * (0.35 + pulse * 0.45);
      eyeScaleY = 0.35;
      if (rec.wingL && rec.wingR) {
        rec.wingL.rotation.set(0, 0.25 + pulse * 0.38, pulse * 0.24);
        rec.wingR.rotation.set(0, -0.25 - pulse * 0.38, -pulse * 0.24);
      }
      if (rec.plumeTail) rec.plumeTail.rotation.x = -0.25 - pulse * 0.35;
      if (rec.potionGroup) rec.potionGroup.rotation.set(pulse * 0.35, 0, sway * 0.25);
    } else if (emoteId === 'cheer') {
      const hop = Math.abs(Math.sin(t * 7.5));
      extraY = hop * 0.42;
      rec.shoulderL.rotation.z = -2.45 - Math.sin(t * 14) * 0.22;
      rec.shoulderR.rotation.z = 2.45 + Math.sin(t * 14) * 0.22;
      rec.shoulderL.rotation.x = 0.25;
      rec.shoulderR.rotation.x = 0.25;
      rec.hipL.rotation.x = -hop * 0.35;
      rec.hipR.rotation.x = -hop * 0.35;
      rec.cape.rotation.x = -0.35 - hop * 0.3;
      eyeScaleY = 0.35;
      if (rec.wingL && rec.wingR) {
        const wingFlap = Math.sin(t * 16) * 0.35;
        rec.wingL.rotation.set(0, 0.22, wingFlap);
        rec.wingR.rotation.set(0, -0.22, -wingFlap);
      }
      if (rec.plumeTail) rec.plumeTail.rotation.x = -0.2 - hop * 0.25;
    } else if (emoteId === 'spin') {
      rotY = yaw + p * Math.PI * 6;
      extraY = Math.sin(p * Math.PI) * 0.28;
      rec.shoulderL.rotation.z = -1.45;
      rec.shoulderR.rotation.z = 1.45;
      rec.cape.rotation.x = -0.82;
      eyeScaleY = 0.65;
      if (rec.wingL && rec.wingR) {
        rec.wingL.rotation.set(0, 0.18, 0.14);
        rec.wingR.rotation.set(0, -0.18, -0.14);
      }
      if (rec.plumeTail) rec.plumeTail.rotation.x = -0.55;
    } else if (emoteId === 'bow') {
      const hold = Math.min(1, Math.sin(p * Math.PI) * 1.45);
      rotX = -0.62 * hold;
      rec.headGroup.rotation.x = -0.22 * hold;
      rec.shoulderL.rotation.x = 0.9 * hold;
      rec.shoulderL.rotation.z = 0.35 * hold;
      rec.shoulderR.rotation.x = -0.55 * hold;
      rec.shoulderR.rotation.z = 0.42 * hold;
      eyeScaleY = 0.35;
      if (rec.wingL && rec.wingR) {
        rec.wingL.rotation.set(0, 0.55, 0);
        rec.wingR.rotation.set(0, -0.55, 0);
      }
    }

    if (rec.eyeL && rec.eyeR) {
      rec.eyeL.scale.set(1, eyeScaleY, 1);
      rec.eyeR.scale.set(1, eyeScaleY, 1);
    }

    rec.root.position.set(x, y + extraY, z);
    rec.root.rotation.set(rotX, rotY, rotZ);

    const showWeapon = emoteId === 'spin' || emoteId === 'bow';
    rec.tpStaff.visible = showWeapon && (!weaponId || weaponId === 'staff');
    rec.tpBlade.visible = showWeapon && weaponId === 'runeblade';
    rec.tpRail.visible = showWeapon && weaponId === 'rail';
    if (rec.tpPan) rec.tpPan.visible = showWeapon && weaponId === 'pan';
  }

  addBeam(ax, ay, az, bx, by, bz, color = '#38bdf8', thickness = 0.045) {
    const start = new THREE.Vector3(ax, ay, az);
    const end = new THREE.Vector3(bx, by, bz);
    const dist = start.distanceTo(end);
    if (dist < 0.05) return;

    const geo = new THREE.CylinderGeometry(thickness, thickness, dist, 8);
    geo.translate(0, dist / 2, 0);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(start);
    mesh.lookAt(end);
    this.scene.add(mesh);
    this.effects.push({ mesh, life: 0.16, maxLife: 0.16, type: 'fade' });
  }

  addExplosion(x, y, z, radius, color = '#f97316') {
    const geo = new THREE.SphereGeometry(radius * 0.55, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.88 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.effects.push({ mesh, life: 0.36, maxLife: 0.36, type: 'expand' });
  }

  addConfettiBurst(x, y, z) {
    const colors = ['#facc15', '#38bdf8', '#f43f5e', '#4ade80', '#a855f7'];
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.14, 0.04),
        new THREE.MeshBasicMaterial({ color: colors[i % colors.length] })
      );
      mesh.position.set(x, y + 1.2, z);
      this.scene.add(mesh);
      const ang = Math.random() * Math.PI * 2;
      const spd = 3 + Math.random() * 6;
      this.confetti.push({
        mesh,
        vx: Math.cos(ang) * spd,
        vy: 5 + Math.random() * 5,
        vz: Math.sin(ang) * spd,
        life: 1.1,
      });
    }
  }

  addRing(x, y, z, radius, color = '#f43f5e', duration = 0.45) {
    const geo = new THREE.RingGeometry(radius * 0.65, radius, 28);
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.88 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + 0.06, z);
    this.scene.add(mesh);
    this.effects.push({ mesh, life: duration, maxLife: duration, type: 'fade' });
  }

  addSlashArc(x, y, z, yaw, pitch, color = '#fbbf24') {
    const geo = new THREE.TorusGeometry(1.4, 0.08, 8, 20, Math.PI * 0.85);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = yaw;
    mesh.rotation.x = pitch + Math.PI * 0.5;
    mesh.rotation.z = -Math.PI * 0.42;
    this.scene.add(mesh);
    this.effects.push({ mesh, life: 0.22, maxLife: 0.22, type: 'expand' });
  }

  addDamageNumber(x, y, z, dmg, headshot) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = headshot ? '900 38px Inter, system-ui' : '800 30px Inter, system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.fillText(headshot ? `${dmg}!` : `${dmg}`, 65, 42);
    ctx.fillStyle = headshot ? '#facc15' : '#ffffff';
    ctx.fillText(headshot ? `${dmg}!` : `${dmg}`, 64, 40);

    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.position.set(x, y + 0.5, z);
    sprite.scale.set(1.05, 0.52, 1);
    this.scene.add(sprite);
    this.damageNumbers.push({ sprite, tex, life: 0.78, maxLife: 0.78, vy: 1.5 });
  }

  addClangBurst(x, y, z, hitPlayer = true) {
    this.addRing(x, y, z, hitPlayer ? 2.4 : 1.35, '#facc15', 0.35);
    const count = hitPlayer ? 12 : 7;
    const sparkColors = ['#fef08a', '#f59e0b', '#ffffff'];
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.1, 0.1),
        new THREE.MeshBasicMaterial({ color: sparkColors[i % sparkColors.length] })
      );
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      const ang = Math.random() * Math.PI * 2;
      const spd = (hitPlayer ? 4.5 : 2.8) + Math.random() * 5.5;
      this.confetti.push({
        mesh,
        vx: Math.cos(ang) * spd,
        vy: 3.5 + Math.random() * 5.5,
        vz: Math.sin(ang) * spd,
        life: 0.55,
      });
    }
  }

  createProjectileMesh(pr) {
    const grp = new THREE.Group();
    if (pr.k === 'fireball') {
      const inner = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 12, 12),
        new THREE.MeshBasicMaterial({ color: '#fef08a' })
      );
      const outer = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.4, 0),
        new THREE.MeshBasicMaterial({ color: '#f97316', transparent: true, opacity: 0.78 })
      );
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.46, 0.045, 6, 16),
        new THREE.MeshBasicMaterial({ color: '#ef4444' })
      );
      grp.add(inner, outer, halo);
    } else if (pr.k === 'frostlance') {
      const core = new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 0.9, 6),
        new THREE.MeshBasicMaterial({ color: '#e0f2fe' })
      );
      core.rotation.x = Math.PI / 2;
      const shell = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32, 0),
        new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.72 })
      );
      grp.add(core, shell);
    } else if (pr.k === 'wave') {
      // Horizontal crescent arc whose leading convex edge faces +Z (flight direction)
      const arc1 = new THREE.Mesh(
        new THREE.TorusGeometry(0.62, 0.09, 8, 18, Math.PI),
        new THREE.MeshBasicMaterial({ color: '#fef08a' })
      );
      arc1.rotation.x = Math.PI / 2;
      const arc2 = new THREE.Mesh(
        new THREE.TorusGeometry(0.46, 0.06, 6, 14, Math.PI),
        new THREE.MeshBasicMaterial({ color: pr.c || '#fbbf24', transparent: true, opacity: 0.85 })
      );
      arc2.rotation.x = Math.PI / 2;
      grp.add(arc1, arc2);
    } else if (pr.k === 'pan') {
      const flyingPan = this.createPanModel({ scale: 1.15, centerOnBowl: true });
      flyingPan.rotation.x = 0.18;
      const trailRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.46, 0.028, 6, 24),
        new THREE.MeshBasicMaterial({ color: '#fde047', transparent: true, opacity: 0.85 })
      );
      trailRing.rotation.x = Math.PI / 2;
      grp.add(flyingPan, trailRing);
      if (typeof pr.sc === 'number') {
        grp.scale.setScalar(pr.sc);
      }
    } else {
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 12, 12),
        new THREE.MeshBasicMaterial({ color: pr.c || '#f97316' })
      );
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.34, 0.04, 6, 14),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 })
      );
      grp.add(orb, ring);
    }
    return grp;
  }

  disposeObject3D(obj) {
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
  }

  render(dt, timeSec, localState, localMeta, remotePlayers, projectiles, orbStates, mode, panPickup = null) {
    // Animate cheerful daytime environment & Central Sun Obelisk
    const crystalBaseY = this.obeliskCrystalY || 9.0;
    const crystalBob = Math.sin(timeSec * 2.2) * 0.16;

    if (this.obeliskCrystal) {
      this.obeliskCrystal.rotation.y = timeSec * 1.1;
      this.obeliskCrystal.position.y = crystalBaseY + crystalBob;
    }
    if (this.obeliskCrystalCore) {
      this.obeliskCrystalCore.rotation.y = -timeSec * 2.3;
      this.obeliskCrystalCore.rotation.x = Math.sin(timeSec * 1.7) * 0.35;
    }
    if (this.obeliskShards) {
      this.obeliskShards.position.y = crystalBaseY + crystalBob;
      this.obeliskShards.rotation.y = -timeSec * 1.45;
      this.obeliskShards.rotation.z = Math.sin(timeSec * 1.8) * 0.16;
    }
    if (this.obeliskHalo) {
      this.obeliskHalo.position.y = crystalBaseY + crystalBob;
      const hs = 4.1 + Math.sin(timeSec * 3.1) * 0.32;
      this.obeliskHalo.scale.set(hs, hs, 1);
    }
    if (this.obeliskBeam) {
      this.obeliskBeam.material.opacity = 0.34 + Math.sin(timeSec * 4.0) * 0.12;
      const bs = 0.92 + Math.sin(timeSec * 5.2) * 0.1;
      this.obeliskBeam.scale.set(bs, 1, bs);
    }
    if (this.obeliskRuneDisc) {
      this.obeliskRuneDisc.rotation.z = timeSec * 0.28;
    }
    if (this.obeliskShaftMat) {
      this.obeliskShaftMat.emissiveIntensity = 0.78 + Math.sin(timeSec * 2.0) * 0.2;
    }
    if (this.obeliskRings.length >= 3) {
      this.obeliskRings[0].rotation.y = timeSec * 0.65;
      this.obeliskRings[0].rotation.x = Math.sin(timeSec * 0.45) * 0.38;
      this.obeliskRings[1].rotation.z = -timeSec * 0.92;
      this.obeliskRings[1].rotation.x = timeSec * 0.48;
      this.obeliskRings[2].rotation.x = -timeSec * 1.25;
      this.obeliskRings[2].rotation.y = timeSec * 0.82;
    }
    if (this.obeliskMotes?.length) {
      for (const m of this.obeliskMotes) {
        const u = (timeSec * m.userData.speed + m.userData.phase) % 1;
        const ang = m.userData.angle + timeSec * 1.1;
        const r = m.userData.radius * (1 - u * 0.25);
        m.position.set(Math.cos(ang) * r, 2.35 + u * 6.4, Math.sin(ang) * r);
        const ms = Math.sin(u * Math.PI);
        m.scale.setScalar(0.55 + ms * 0.75);
      }
    }

    for (const fl of this.brazierFlames) {
      fl.rotation.y = timeSec * 3.0;
      fl.position.y = fl.userData.baseY + Math.sin(timeSec * 6.5 + fl.userData.phase) * 0.08;
      const s = 0.92 + Math.sin(timeSec * 9.0 + fl.userData.phase) * 0.14;
      fl.scale.set(s, 1.2 * s, s);
    }

    if (this.windmillBlades) {
      this.windmillBlades.rotation.x = timeSec * 0.85;
    }

    for (const c of this.clouds) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 85) c.position.x = -85;
    }

    for (const g of this.goats) {
      const hop = Math.max(0, Math.sin(timeSec * 3.2 + g.userData.phase));
      g.position.y = g.userData.baseY + hop * hop * 0.35;
      if (g.userData.legs) {
        const kick = hop * 0.55;
        g.userData.legs[0].rotation.x = kick;
        g.userData.legs[1].rotation.x = -kick;
        g.userData.legs[2].rotation.x = -kick;
        g.userData.legs[3].rotation.x = kick;
      }
    }

    for (const ch of this.chickens) {
      const bob = Math.abs(Math.sin(timeSec * 4.5 + ch.userData.phase));
      ch.position.y = ch.userData.baseY + bob * 0.14;
      const flap = Math.sin(timeSec * 12 + ch.userData.phase) * 0.45;
      if (ch.userData.wingL) ch.userData.wingL.rotation.z = 0.3 + flap;
      if (ch.userData.wingR) ch.userData.wingR.rotation.z = -0.3 - flap;
    }

    for (let i = 0; i < this.jumpPadRings.length; i++) {
      const r = this.jumpPadRings[i];
      const phase = (timeSec * 1.6 + i * 0.3) % 1;
      r.position.y = r.userData.baseY + phase * 0.85;
      r.material.opacity = 1 - phase;
    }

    for (let i = 0; i < this.orbMeshes.length; i++) {
      const grp = this.orbMeshes[i];
      grp.visible = !orbStates || orbStates[i] !== 0;
      grp.rotation.y = timeSec * 2.0 + i;
      grp.position.y = ORB_SPAWNS[i].y + Math.sin(timeSec * 2.8 + i) * 0.2;
    }

    if (this.embers) {
      this.embers.rotation.y = timeSec * 0.03;
    }

    if (this.panPickupGroup) {
      if (panPickup) {
        this.panPickupGroup.visible = true;
        this.panPickupGroup.position.set(panPickup.x, panPickup.y, panPickup.z);
        if (this.panPickupRotator) {
          this.panPickupRotator.position.y = 1.15 + Math.sin(timeSec * 3.4) * 0.14;
          this.panPickupRotator.rotation.y = timeSec * 2.5;
        }
        if (this.panPickupPulse) {
          const pulse = 0.78 + Math.sin(timeSec * 5.0) * 0.18;
          this.panPickupPulse.scale.set(pulse, pulse, 1);
        }
      } else {
        this.panPickupGroup.visible = false;
      }
    }

    // Update Camera + First-Person Viewmodel (or 3rd-Person Emote Orbit Camera)
    if (localState) {
      if (!localState.alive) this.cancelLocalEmote();

      const targetScope = localState.alive && !this.localEmote && localMeta?.scoped && localMeta?.weapon === 'rail' ? 1 : 0;
      const prevScope = this.scopeBlend;
      this.scopeBlend += (targetScope - this.scopeBlend) * Math.min(1, dt * 16);
      if (Math.abs(this.scopeBlend - targetScope) < 0.004) this.scopeBlend = targetScope;
      if (Math.abs(this.scopeBlend - prevScope) > 0.0005) {
        const baseFov = this.baseFov || 75;
        this.camera.fov = baseFov * (1 - this.scopeBlend * 0.64);
        this.camera.updateProjectionMatrix();
        const baseVmFov = this.baseVmFov || 66;
        this.vmCamera.fov = baseVmFov * (1 - this.scopeBlend * 0.45);
        this.vmCamera.updateProjectionMatrix();
      }

      const shakeX = this.screenShake > 0 ? (Math.random() - 0.5) * this.screenShake : 0;
      const shakeY = this.screenShake > 0 ? (Math.random() - 0.5) * this.screenShake : 0;
      this.screenShake = Math.max(0, this.screenShake - dt * 0.25);

      if (localState.alive && this.localEmote) {
        this.localEmote.elapsed += dt;
        if (this.localEmote.elapsed >= this.localEmote.duration) {
          this.cancelLocalEmote();
        }
      }

      if (localState.alive && this.localEmote) {
        if (!this.localAvatarRec) {
          this.localAvatarRec = this.createPlayerMesh(
            { id: localMeta?.id || 'local', n: '', tm: localMeta?.team ?? 0 },
            mode,
            false
          );
        }
        const av = this.localAvatarRec;
        const myColor = this.getTeamColor(localMeta?.team ?? 0, localMeta?.id || 'local', mode);
        if (myColor !== av.lastColor) {
          av.accentMat.color.set(myColor);
          av.accentMat.emissive.set(myColor);
          av.lastColor = myColor;
        }
        av.root.visible = true;
        av.sprite.visible = false;
        av.emoteSprite.visible = false;
        av.shield.visible = Boolean(localMeta?.blocking);
        this.updateSpawnProtectionVisuals(av, localMeta?.spawnShield || 0, localState.slowTimer || 0, timeSec);

        this.applyEmotePose(
          av,
          this.localEmote.id,
          this.localEmote.elapsed,
          this.localEmote.duration,
          localState.x,
          localState.y,
          localState.z,
          localState.yaw,
          localMeta?.weapon || 'staff'
        );

        // Position 3rd-person orbit camera in front-right so the player sees their own emote
        const orbitYaw = this.localEmote.camYaw - 0.42;
        const orbitPitch = 0.24;
        const idealDist = this.camera.aspect < 1 ? 3.85 : 3.55;
        const target = { x: localState.x, y: localState.y + 1.28, z: localState.z };
        const camDir = {
          x: -Math.sin(orbitYaw) * Math.cos(orbitPitch),
          y: Math.sin(orbitPitch),
          z: -Math.cos(orbitYaw) * Math.cos(orbitPitch),
        };
        const hit = raycastArena(target, camDir, idealDist, ARENA_BOXES);
        const dist = hit ? Math.max(0.85, hit.dist - 0.35) : idealDist;
        this.camera.position.set(
          target.x + camDir.x * dist + shakeX,
          target.y + camDir.y * dist + shakeY,
          target.z + camDir.z * dist
        );
        this.camera.lookAt(target.x, target.y, target.z);
        this.viewmodelRoot.visible = false;
      } else if (localState.alive && this.perspectiveMode === 'tpp' && this.scopeBlend <= 0.35) {
        if (!this.localAvatarRec) {
          this.localAvatarRec = this.createPlayerMesh(
            { id: localMeta?.id || 'local', n: '', tm: localMeta?.team ?? 0 },
            mode,
            false
          );
        }
        const av = this.localAvatarRec;
        const myColor = this.getTeamColor(localMeta?.team ?? 0, localMeta?.id || 'local', mode);
        if (myColor !== av.lastColor) {
          av.accentMat.color.set(myColor);
          av.accentMat.emissive.set(myColor);
          av.lastColor = myColor;
        }
        av.sprite.visible = false;
        av.emoteSprite.visible = false;
        av.shield.visible = Boolean(localMeta?.blocking);
        this.updateSpawnProtectionVisuals(av, localMeta?.spawnShield || 0, localState.slowTimer || 0, timeSec);
        av.attackAnim = Math.max(0, av.attackAnim - dt * 4.2);
        av.panSwingAnim = Math.max(0, (av.panSwingAnim || 0) - dt * 4.2);

        this.applyLocomotionPose(
          av,
          localState.x,
          localState.y,
          localState.z,
          localState.yaw,
          localState.pitch,
          localState.vx,
          localState.vz,
          Boolean(localMeta?.blocking),
          localMeta?.weapon || 'staff',
          timeSec
        );

        const sinY = Math.sin(localState.yaw);
        const cosY = Math.cos(localState.yaw);
        const cosP = Math.cos(localState.pitch);
        const sinP = Math.sin(localState.pitch);
        const fwdX = -sinY * cosP;
        const fwdY = sinP;
        const fwdZ = -cosY * cosP;
        const rightX = cosY;
        const rightZ = -sinY;

        const isPortrait = this.camera.aspect < 1;
        const isCompactTpp = this.isMobile || this.camera.fov < 64;
        const backDist = isPortrait ? 3.35 : isCompactTpp ? 3.65 : 3.1;
        const shoulderRight = isPortrait ? 0.34 : 0.48;
        const shoulderUp = isPortrait ? 0.28 : isCompactTpp ? 0.14 : 0.28;

        const eyeOrigin = { x: localState.x, y: localState.y + PLAYER_EYE_HEIGHT, z: localState.z };
        const offX = -fwdX * backDist + rightX * shoulderRight;
        const offY = -fwdY * backDist + shoulderUp;
        const offZ = -fwdZ * backDist + rightZ * shoulderRight;
        const rayLen = Math.hypot(offX, offY, offZ);
        const rayDir = { x: offX / rayLen, y: offY / rayLen, z: offZ / rayLen };
        const hit = raycastArena(eyeOrigin, rayDir, rayLen, ARENA_BOXES);
        const safeDist = hit ? Math.max(0.48, hit.dist - 0.28) : rayLen;

        av.root.visible = safeDist > 0.85;
        this.camera.position.set(
          eyeOrigin.x + rayDir.x * safeDist + shakeX,
          Math.max(0.42, eyeOrigin.y + rayDir.y * safeDist) + shakeY,
          eyeOrigin.z + rayDir.z * safeDist
        );
        this.camera.rotation.y = localState.yaw;
        this.camera.rotation.x = localState.pitch;
        this.camera.rotation.z = 0;
        this.viewmodelRoot.visible = false;
      } else {
        if (this.localAvatarRec) this.localAvatarRec.root.visible = false;

        const eyeY = localState.alive ? localState.y + PLAYER_EYE_HEIGHT : localState.y + 3.2;
        this.camera.position.set(localState.x + shakeX, eyeY + shakeY, localState.z);
        this.camera.rotation.y = localState.yaw;
        this.camera.rotation.x = localState.pitch;
        this.camera.rotation.z = 0;

        const wId = localMeta?.weapon || 'staff';
        const showPanVm = wId === 'pan' || this.panSwingAnim > 0;
        const hideForScope = !showPanVm && wId === 'rail' && this.scopeBlend > 0.68;
        this.viewmodelRoot.visible = Boolean(localState.alive && !hideForScope);
        if (localState.alive) {
          this.recoil = Math.max(0, this.recoil - dt * 1.4);
          this.swingAnim = Math.max(0, this.swingAnim - dt * 4.5);
          this.panSwingAnim = Math.max(0, (this.panSwingAnim || 0) - dt * 4.2);

          this.vmStaff.visible = !showPanVm && wId === 'staff';
          this.vmBlade.visible = !showPanVm && wId === 'runeblade';
          this.vmRail.visible = !showPanVm && wId === 'rail' && !hideForScope;
          if (this.vmPan) this.vmPan.visible = showPanVm;
          this.vmShield.visible = Boolean(localMeta?.blocking);

          this.vmRail.position.set(
            0.32 * (1 - this.scopeBlend),
            -0.24 + this.scopeBlend * 0.128,
            -0.52 + this.scopeBlend * 0.22
          );

          if (this.vmStaffCrystal) {
            this.vmStaffCrystal.rotation.y = timeSec * 2.4;
            this.vmStaffRing.rotation.z = timeSec * 1.8;
            this.vmStaffRing.rotation.x = Math.sin(timeSec * 1.5) * 0.4;
            this.vmStaffRing2.rotation.z = -timeSec * 2.2;
            this.vmStaffRing2.rotation.y = timeSec * 1.4;
          }
          if (this.vmShield.visible) {
            this.vmShieldOuter.rotation.z = timeSec * 1.2;
            this.vmShieldInner.rotation.z = -timeSec * 1.8;
          }

          const moveSpeed = Math.hypot(localState.vx, localState.vz);
          if (localState.grounded && moveSpeed > 0.5) {
            this.walkTime += dt * Math.min(12, moveSpeed * 1.25);
          }

          const bobX = Math.cos(this.walkTime) * 0.014;
          const bobY = Math.abs(Math.sin(this.walkTime)) * 0.016;
          const isNarrow = this.camera.aspect < 0.85;
          this.viewmodelRoot.position.set(bobX + (isNarrow ? -0.05 : 0), -bobY, this.recoil);
          this.viewmodelRoot.scale.setScalar(isNarrow ? 0.92 : 1);

          if (showPanVm) {
            if (this.gauntletGroup) {
              if (this.panSwingAnim > 0) {
                const s = Math.sin(this.panSwingAnim * Math.PI);
                this.gauntletGroup.position.set(0.30 - s * 0.44, -0.31 + s * 0.14, -0.25 - s * 0.16);
                this.gauntletGroup.rotation.set(0.22 - s * 0.85, -0.14 + s * 1.15, 0.10 + s * 0.95);
              } else {
                this.gauntletGroup.position.set(0.31, -0.32 + Math.sin(timeSec * 2.2) * 0.005, -0.25);
                this.gauntletGroup.rotation.set(0.20, -0.12, 0.06);
              }
            }
          } else if (wId === 'runeblade') {
            if (localMeta?.blocking) {
              this.vmBlade.position.set(0.05, -0.14, -0.45);
              this.vmBlade.rotation.set(-0.15, 0.2, 1.25);
              if (this.gauntletGroup) {
                this.gauntletGroup.position.set(0.06, -0.22, -0.22);
                this.gauntletGroup.rotation.set(0.28, 0.16, 1.15);
              }
            } else {
              const s = Math.sin(this.swingAnim * Math.PI);
              this.vmBlade.position.set(0.36 - s * 0.45, -0.28 + s * 0.08, -0.52 - s * 0.14);
              this.vmBlade.rotation.set(-0.45 - s * 1.1, 0.25 + s * 1.2, 0.28 + s * 0.8);
              if (this.gauntletGroup) {
                this.gauntletGroup.position.set(0.32 - s * 0.42, -0.34 + s * 0.08, -0.24 - s * 0.12);
                this.gauntletGroup.rotation.set(0.18 - s * 0.75, -0.1 + s * 0.95, s * 0.65);
              }
            }
          } else if (wId === 'rail') {
            if (this.gauntletGroup) {
              this.gauntletGroup.position.set(
                0.32 * (1 - this.scopeBlend * 0.65),
                -0.34 + this.scopeBlend * 0.12,
                -0.24 + this.scopeBlend * 0.1
              );
              this.gauntletGroup.rotation.set(0.18, -0.1 * (1 - this.scopeBlend), 0);
            }
          } else if (this.gauntletGroup) {
            this.gauntletGroup.position.set(0.32, -0.34, -0.24);
            this.gauntletGroup.rotation.set(0.18, -0.1, 0);
          }
        }
      }
    }

    // Update Remote Players
    const activeIds = new Set();
    for (const p of remotePlayers) {
      if (p.id === localMeta?.id) continue;
      activeIds.add(p.id);

      let rec = this.playerMeshes.get(p.id);
      if (!rec) rec = this.createPlayerMesh(p, mode);

      // Update team/FFA accent color live if mode or team changes
      const color = this.getTeamColor(p.tm, p.id, mode);
      if (color !== rec.lastColor) {
        rec.accentMat.color.set(color);
        rec.accentMat.emissive.set(color);
        rec.lastColor = color;
      }

      if (rec.wasAlive && !p.al) {
        rec.deathTumble = 0.85;
        rec.deathVy = 4.6;
        rec.deathBaseY = p.y;
        this.addConfettiBurst(p.x, p.y, p.z);
      }
      rec.wasAlive = Boolean(p.al);

      if (!p.al) {
        rec.emote = null;
        rec.emoteSprite.visible = false;
        if (rec.spawnAura) rec.spawnAura.visible = false;
        if (rec.deathTumble > 0) {
          rec.deathTumble -= dt;
          rec.deathVy = (rec.deathVy ?? 0) - 18 * dt;
          rec.root.visible = true;
          rec.root.rotation.x += dt * 7.5;
          rec.root.rotation.z += dt * 5.5;
          rec.root.position.y = Math.max(rec.deathBaseY ?? p.y, rec.root.position.y + rec.deathVy * dt);
          rec.sprite.visible = false;
        } else {
          rec.root.visible = false;
        }
        continue;
      }

      rec.root.visible = true;
      rec.sprite.visible = true;
      rec.shield.visible = Boolean(p.bl);
      rec.attackAnim = Math.max(0, rec.attackAnim - dt * 4.2);
      rec.panSwingAnim = Math.max(0, (rec.panSwingAnim || 0) - dt * 4.2);

      if (rec.emote) {
        rec.emote.elapsed += dt;
        if (rec.emote.elapsed >= rec.emote.duration) {
          rec.emote = null;
        }
      }

      if (rec.emote) {
        rec.emoteSprite.visible = true;
        rec.emoteSprite.position.y = 2.95 + Math.sin(timeSec * 8) * 0.05;
        this.applyEmotePose(
          rec,
          rec.emote.id,
          rec.emote.elapsed,
          rec.emote.duration,
          p.x,
          p.y,
          p.z,
          p.yw,
          p.wp
        );
      } else {
        rec.emoteSprite.visible = false;
        this.applyLocomotionPose(
          rec,
          p.x,
          p.y,
          p.z,
          p.yw,
          p.pt,
          p.vx,
          p.vz,
          Boolean(p.bl),
          p.wp,
          timeSec
        );
      }

      this.updateSpawnProtectionVisuals(rec, p.sp || 0, p.sl || 0, timeSec);
      this.updatePlayerLabel(rec, p.n, p.hp, p.mhp, color, (p.sp || 0) > 0);
    }

    for (const [id, rec] of this.playerMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(rec.root);
        rec.labelTex.dispose();
        rec.emoteTex?.dispose();
        this.playerMeshes.delete(id);
      }
    }

    // Update Projectiles
    const activeProj = new Set();
    for (const pr of projectiles) {
      activeProj.add(pr.id);
      let mesh = this.projectileMeshes.get(pr.id);
      if (!mesh) {
        mesh = this.createProjectileMesh(pr);
        mesh.userData.prev = new THREE.Vector3(pr.x, pr.y, pr.z);
        this.scene.add(mesh);
        this.projectileMeshes.set(pr.id, mesh);
      }
      const prev = mesh.userData.prev;
      const dx = pr.x - prev.x;
      const dy = pr.y - prev.y;
      const dz = pr.z - prev.z;
      mesh.position.set(pr.x, pr.y, pr.z);
      if (pr.k === 'frostlance' || pr.k === 'wave') {
        if (dx * dx + dy * dy + dz * dz > 1e-6) {
          mesh.lookAt(pr.x + dx, pr.y + dy, pr.z + dz);
          if (pr.k === 'frostlance') {
            mesh.userData.roll = (mesh.userData.roll || 0) + dt * 9;
            mesh.rotateZ(mesh.userData.roll);
          } else {
            mesh.rotateZ(0.22);
          }
        }
      } else if (pr.k === 'pan') {
        mesh.rotation.y += dt * 22;
        mesh.rotation.z = 0.25;
        if (typeof pr.sc === 'number') {
          mesh.scale.setScalar(pr.sc);
        }
      } else {
        mesh.rotation.y += dt * 10;
        mesh.rotation.x += dt * 4;
      }
      prev.set(pr.x, pr.y, pr.z);
    }

    for (const [id, mesh] of this.projectileMeshes.entries()) {
      if (!activeProj.has(id)) {
        this.scene.remove(mesh);
        this.disposeObject3D(mesh);
        this.projectileMeshes.delete(id);
      }
    }

    // Update Confetti
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const cf = this.confetti[i];
      cf.life -= dt;
      if (cf.life <= 0) {
        this.scene.remove(cf.mesh);
        cf.mesh.geometry.dispose();
        cf.mesh.material.dispose();
        this.confetti.splice(i, 1);
        continue;
      }
      cf.vy -= 14 * dt;
      cf.mesh.position.x += cf.vx * dt;
      cf.mesh.position.y += cf.vy * dt;
      cf.mesh.position.z += cf.vz * dt;
      cf.mesh.rotation.x += dt * 8;
      cf.mesh.rotation.y += dt * 6;
    }

    // Update transient effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      if (fx.life <= 0) {
        this.scene.remove(fx.mesh);
        fx.mesh.geometry.dispose();
        fx.mesh.material.dispose();
        this.effects.splice(i, 1);
        continue;
      }
      const p = 1 - fx.life / fx.maxLife;
      if (fx.type === 'expand') {
        const s = 0.6 + p * 1.4;
        fx.mesh.scale.set(s, s, s);
      }
      fx.mesh.material.opacity = 1 - p;
    }

    // Update floating damage numbers
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.life -= dt;
      if (dn.life <= 0) {
        this.scene.remove(dn.sprite);
        dn.tex.dispose();
        dn.sprite.material.dispose();
        this.damageNumbers.splice(i, 1);
        continue;
      }
      dn.sprite.position.y += dn.vy * dt;
      dn.sprite.material.opacity = dn.life / dn.maxLife;
    }

    // Render world pass, then clear depth buffer and render non-clipping FPP viewmodel pass
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (
      localState?.alive &&
      !this.localEmote &&
      (this.perspectiveMode !== 'tpp' || this.scopeBlend > 0.35) &&
      this.viewmodelRoot.visible
    ) {
      this.renderer.clearDepth();
      this.renderer.render(this.vmScene, this.vmCamera);
    }
  }
}
