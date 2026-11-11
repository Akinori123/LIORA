/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
// AUDITORIA 3D (OrbitControls): interatividade completa da Orbe — rotação por
// arraste, zoom por wheel/pinch com limites saudáveis e damping orgânico.
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OrbState } from '../types';
import { useLioraStore } from '../store/lioraStore';
import { getThemeColors, ThemeColors } from '../utils/themeColors';

interface LioraOrbProps {
  state: OrbState;
  size?: number | string;
  audioGain?: number;
  isMinimized?: boolean;
  onSwipeDown?: () => void;
  onClick?: () => void;
}

// Pre-allocated reusable math helpers outside the animation loop for Zero Garbage Collection (GC)
const _reusableColor = new THREE.Color();

// Sophisticated Neural Liquid Core Shader with Domain Warping & State Reactions
const QuantumCoreShader = {
  uniforms: { 
    uTime: { value: 0 }, 
    uIntensity: { value: 0.0 },
    uAudioGain: { value: 0.0 },
    uStateMode: { value: 0.0 }, // 0: IDLE, 1: LISTENING, 2: THINKING, 3: SPEAKING, 4: EXECUTING, 5: ERROR
    uColorBase: { value: new THREE.Vector3(0.40, 0.02, 0.04) },
    uColorAccent: { value: new THREE.Vector3(1.0, 0.17, 0.17) },
    uColorHighlight: { value: new THREE.Vector3(1.0, 1.0, 1.0) }
  },
  vertexShader: `
    varying vec3 vNormal;
    varying vec3 vViewPos;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uAudioGain;
    uniform float uStateMode;

    // Simplex-like noise function
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(hash(i + vec2(0,0)), hash(i + vec2(1,0)), u.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
    }

    void main() {
      vNormal = normalize(normalMatrix * normal);
      vec3 pos = position;
      
      // Domain Warping for organic liquid look
      float speed = uStateMode == 2.0 ? 1.8 : (uStateMode == 3.0 ? 1.2 : 0.6);
      float n = noise(pos.xy * 2.0 + uTime * speed);
      n += 0.5 * noise(pos.xy * 4.0 + uTime * (speed * 1.5));
      
      float gainEffect = min(1.0, uAudioGain) * 0.08;
      float displacement = n * (0.03 + uIntensity * 0.07 + gainEffect);
      
      if (uStateMode == 5.0) {
        displacement += sin(uTime * 12.0) * 0.02;
      }
      
      pos += normal * displacement;
      
      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      vViewPos = mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    varying vec3 vNormal;
    varying vec3 vViewPos;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uAudioGain;
    uniform float uStateMode;

    uniform vec3 uColorBase;
    uniform vec3 uColorAccent;
    uniform vec3 uColorHighlight;

    void main() {
      // Sophisticated dynamic color palette based on active theme uniforms
      vec3 colorDeep = vec3(0.02, 0.02, 0.02);   // Deep black #050505
      vec3 colorMid = uColorBase;                // Theme-responsive mid base
      vec3 colorBright = uColorAccent;           // Theme primary accent
      vec3 colorHigh = uColorHighlight;          // Pure white / theme highlight

      if (uStateMode == 5.0) {
        // ERROR: Pulsing warning alert
        colorMid = vec3(0.85, 0.05, 0.05);
        colorBright = vec3(1.0, 0.2, 0.1);
      } else if (uStateMode == 1.0) {
        // LISTENING: High reactivity with audio gain
        colorMid = mix(uColorBase * 0.7, uColorAccent, min(1.0, uAudioGain) * 0.5);
        colorBright = mix(uColorAccent, uColorHighlight, min(1.0, uAudioGain) * 0.3);
      } else if (uStateMode == 3.0) {
        // SPEAKING: Synchronized accent and white pulses
        float pulse = 0.5 + 0.5 * sin(uTime * 6.0);
        colorBright = mix(uColorAccent, uColorHighlight, pulse * 0.4);
      }
      
      vec3 normal = normalize(vNormal);
      vec3 viewDir = normalize(-vViewPos);
      
      // Fresnel effect for depth
      float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
      
      // Lighting/Surface mix
      float light = max(dot(normal, normalize(vec3(1.0, 1.0, 1.0))), 0.0);
      vec3 color = mix(colorDeep, colorMid, light);
      color = mix(color, colorBright, fresnel * 1.5);
      
      // Internal energy intensity
      if (uIntensity > 0.05 || uAudioGain > 0.05) {
        float factor = max(uIntensity, min(1.0, uAudioGain));
        color = mix(color, colorHigh, factor * (0.15 + 0.2 * sin(uTime * 8.0)));
      }
      
      gl_FragColor = vec4(color, 0.95);
    }
  `
};

export const LioraOrb: React.FC<LioraOrbProps> = ({ 
  state, 
  size = '100%', 
  audioGain = 0,
  isMinimized = false,
  onSwipeDown,
  onClick 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasWebGLError, setHasWebGLError] = React.useState(false);
  // CORREÇÃO (Orbe sumido): watchdog de primeiro frame. Se após 4s nenhum pixel
  // diferente de preto foi desenhado (shader compilou mas output preto — típico de
  // UnrealBloomPass sem suporte a HalfFloat no WebView2), o componente troca
  // automaticamente para o núcleo 2D elegante em vez de ficar em tela preta eterna.
  const [renderBlackScreen, setRenderBlackScreen] = React.useState(false);
  const { settings, isGenerating: isProcessing } = useLioraStore();

  // Stable references for in-place updates without canvas unmounting or GC spikes
  const coreMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const reactorMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const ptLightRef = useRef<THREE.PointLight | null>(null);
  const ringMeshesRef = useRef<THREE.Mesh[]>([]);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const themeColorsRef = useRef<ThemeColors>(getThemeColors(settings?.theme));

  // Dynamic state refs for per-frame animation reading
  const stateRef = useRef<OrbState>(state);
  const audioGainRef = useRef<number>(audioGain);
  const isProcessingRef = useRef<boolean>(isProcessing);
  const onSwipeDownRef = useRef<(() => void) | undefined>(onSwipeDown);
  const isMinimizedRef = useRef<boolean>(isMinimized);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    audioGainRef.current = audioGain;
  }, [audioGain]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    onSwipeDownRef.current = onSwipeDown;
  }, [onSwipeDown]);

  // In-place camera distance update when minimized changes — via OrbitControls
  // (AUDITORIA 3D: alterar camera.position diretamente era sobrescrito pelo
  // controls.update(); agora anima a distância do próprio controls)
  useEffect(() => {
    isMinimizedRef.current = isMinimized;
    const controls = controlsRef.current;
    if (controls) {
      const targetDist = isMinimized ? 6.2 : 4.6;
      const dir = controls.object.position.clone().sub(controls.target).normalize();
      controls.object.position.copy(controls.target.clone().add(dir.multiplyScalar(targetDist)));
      controls.update();
    }
  }, [isMinimized]);

  // ZERO-STUTTER THEME ROTATION:
  // Direct in-place mutation of uniforms and materials without unmounting the WebGL canvas or leaking memory
  useEffect(() => {
    const currentTheme = settings?.theme || 'crimson';
    const colors = getThemeColors(currentTheme);
    themeColorsRef.current = colors;

    // 1. Direct in-place GLSL shader uniform updates
    if (coreMatRef.current) {
      coreMatRef.current.uniforms.uColorBase.value.set(
        colors.shaderBase[0], 
        colors.shaderBase[1], 
        colors.shaderBase[2]
      );
      coreMatRef.current.uniforms.uColorAccent.value.set(
        colors.shaderAccent[0], 
        colors.shaderAccent[1], 
        colors.shaderAccent[2]
      );
      coreMatRef.current.uniforms.uColorHighlight.value.set(
        colors.shaderHighlight[0], 
        colors.shaderHighlight[1], 
        colors.shaderHighlight[2]
      );
    }

    // 2. Direct in-place reactor material emissive update
    if (reactorMatRef.current) {
      reactorMatRef.current.emissive.setHex(colors.num);
    }

    // 3. Direct in-place point light color update
    if (ptLightRef.current) {
      ptLightRef.current.color.setHex(colors.num);
    }

    // 4. Direct in-place orbital rings color update
    if (ringMeshesRef.current.length >= 3) {
      const mat0 = ringMeshesRef.current[0].material as THREE.MeshBasicMaterial;
      const mat2 = ringMeshesRef.current[2].material as THREE.MeshBasicMaterial;
      if (mat0) mat0.color.setHex(colors.num);
      if (mat2) mat2.color.setHex(colors.num);
    }
  }, [settings?.theme]);

  // SINGLE LIFECYCLE INITIALIZATION:
  // Mounts the Three.js WebGL canvas once and keeps it alive throughout app sessions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // CORREÇÃO (Orbe sumido no WebView2 do Tauri): detecta a disponibilidade real
    // de WebGL ANTES de tentar criar o renderer. O WebView2 (WebView do Tauri no
    // Windows) pode não expor contexto WebGL2/hardware acceleration em certas
    // configs (GPU blocklist, remote desktop, driver antigo) — o THREE.WebGLRenderer
    // então lançava depois ou renderizava preto sem erro capturável.
    const probeCanvas = document.createElement('canvas');
    const webglAttrs = { antialias: false, depth: false, stencil: false };
    const webgl2 = probeCanvas.getContext('webgl2', webglAttrs);
    const webgl1 = webgl2 ? null : probeCanvas.getContext('webgl', webglAttrs) || probeCanvas.getContext('experimental-webgl', webglAttrs);
    if (!webgl2 && !webgl1) {
      console.warn('[LioraOrb] WebGL indisponível no WebView (probe falhou). Exibindo núcleo 2D de fallback.');
      setHasWebGLError(true);
      return;
    }

    const width = container.clientWidth || 360;
    const height = container.clientHeight || 360;

    let renderer: THREE.WebGLRenderer;
    let composer: EffectComposer;

    try {
      renderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        alpha: true, 
        powerPreference: 'high-performance',
        // Correção: evita falha em GPUs sem suporte a float render targets
        failIfMajorPerformanceCaveat: false
      });
      // CORREÇÃO (tela preta): clear color explícito transparente. Antes, com
      // alpha:true mas sem clearColor definido, alguns WebViews renderizavam o
      // buffer inicial opaco preto por cima do fundo da UI.
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
    } catch (err) {
      console.warn('[LioraOrb] WebGL initialization failed, switching to 2D core:', err);
      setHasWebGLError(true);
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.z = isMinimizedRef.current ? 6.2 : 4.6;
    cameraRef.current = camera;

    try {
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      container.appendChild(renderer.domElement);

      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.7, 0.35, 0.85));
    } catch (err) {
      console.warn('[LioraOrb] WebGL composer failed, switching to 2D core:', err);
      setHasWebGLError(true);
      return;
    }

    const aiGroup = new THREE.Group();
    scene.add(aiGroup);

    const initialColors = themeColorsRef.current;

    // 1. Organic Liquid Core with Theme Reactive Shader
    const coreMat = new THREE.ShaderMaterial({
      ...QuantumCoreShader,
      uniforms: THREE.UniformsUtils.clone(QuantumCoreShader.uniforms),
      transparent: true,
      side: THREE.DoubleSide
    });
    coreMat.uniforms.uColorBase.value.set(...initialColors.shaderBase);
    coreMat.uniforms.uColorAccent.value.set(...initialColors.shaderAccent);
    coreMat.uniforms.uColorHighlight.value.set(...initialColors.shaderHighlight);
    coreMatRef.current = coreMat;

    const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.95, 64, 64), coreMat);
    aiGroup.add(coreMesh);

    // 2. Refined Inner Reactor (Highly emissive, depth-giving)
    const reactorMat = new THREE.MeshStandardMaterial({ 
      color: 0xFFFFFF, 
      emissive: initialColors.num, 
      emissiveIntensity: 1.2 
    });
    reactorMatRef.current = reactorMat;

    const reactor = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.5, 2), 
      reactorMat
    );
    aiGroup.add(reactor);

    // 3. Orbital Rings with Data Nodes
    const ringGroup = new THREE.Group();
    const ringMeshes: THREE.Mesh[] = [];
    [1.4, 1.7, 2.0].forEach((r, i) => {
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(r, 0.015, 16, 100), 
            new THREE.MeshBasicMaterial({ 
              color: i === 0 ? initialColors.num : (i === 1 ? 0xFFFFFF : initialColors.num), 
              transparent: true, 
              opacity: i === 2 ? 0.35 : 0.55 
            })
        );
        ring.rotation.x = i === 0 ? 0.6 : (i === 1 ? -0.6 : 0.0);
        ringGroup.add(ring);
        ringMeshes.push(ring);
    });
    ringMeshesRef.current = ringMeshes;
    aiGroup.add(ringGroup);

    // 4. Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const ptLight = new THREE.PointLight(initialColors.num, 3.5, 20);
    ptLight.position.set(2, 2, 3);
    ptLightRef.current = ptLight;
    scene.add(ptLight);

    // AUDITORIA 3D — ORBITCONTROLS: interatividade completa da Orbe.
    // Configuração imersiva solicitada:
    //  - Rotação fluida por arraste (botão esquerdo) e touch
    //  - Zoom por wheel/pinch com limites saudáveis (não entra na esfera, não some)
    //  - Pan desabilitado (o Orbe é o centro fixo da identidade visual)
    //  - Damping 0.05 para movimento suave e orgânico
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.minDistance = 2.4;   // não entra dentro da esfera (raio ~1.0 + folga)
    controls.maxDistance = 10.0;  // não some no infinito
    controls.enablePan = false;   // centro fixo — identidade visual da LIORA
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.rotateSpeed = 0.8;
    controls.zoomSpeed = 0.9;
    controls.target.set(0, 0, 0);
    controls.update();
    controlsRef.current = controls;

    // Gesto de swipe-down (minimizar o Orbe) PRESERVADO — independente do OrbitControls,
    // com limiar vertical e bloqueio durante rotação intencional da câmera.
    let startY = 0;
    let swipeAccumY = 0;
    const handleMouseDown = (e: MouseEvent) => {
      startY = e.clientY;
      swipeAccumY = 0;
    };
    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons !== 1) return; // só conta com botão pressionado
      swipeAccumY += e.movementY || 0;
    };
    const handleMouseUp = (e: MouseEvent) => {
      // Swipe para baixo com pouco movimento horizontal = minimizar (não rotação)
      const deltaY = e.clientY - startY;
      if (deltaY > 60 && Math.abs(swipeAccumY - deltaY) < 20 && onSwipeDownRef.current) {
        onSwipeDownRef.current();
      }
    };

    // Touch support: swipe-down para minimizar (OrbitControls já cobre rotação/zoom touch)
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        touchStartY = e.touches[0].clientY;
      }
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length > 0 && onSwipeDownRef.current) {
        const deltaY = e.changedTouches[0].clientY - touchStartY;
        if (deltaY > 60) {
          onSwipeDownRef.current();
        }
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    // BUG FIX (swipe-down): os listeners de mousemove/mouseup devem estar no CANVAS,
    // não no window — o OrbitControls usa setPointerCapture no pointerdown, e a
    // captura roteia todos os eventos subsequentes para o próprio canvas. No window,
    // o swipe-down nunca era recebido durante o drag (minimizar não funcionava).
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    // State mapping for shader
    const getStateMode = (s: OrbState): number => {
      switch (s) {
        case 'LISTENING': return 1.0;
        case 'THINKING': return 2.0;
        case 'SPEAKING': return 3.0;
        case 'EXECUTING': return 4.0;
        case 'ERROR': return 5.0;
        default: return 0.0; // IDLE and others
      }
    };

    // Animation loop with adaptive attention and GPU throttling (Item 3 do Plano de Ação)
    let animId: number;
    let lastRenderTime = 0;
    const TARGET_FPS_IDLE = 30;
    const FRAME_INTERVAL_IDLE = 1000 / TARGET_FPS_IDLE; // ~33ms
    const startTime = performance.now();
    let lastInteractionTime = Date.now();
    // FIX W9: flag para evitar múltiplos setTimeout de retomada agendados
    let isHiddenPauseScheduled = false;
    let hiddenPauseTimer: ReturnType<typeof setTimeout> | null = null;
    let isUnmounted = false;

    const resetInteraction = () => {
      lastInteractionTime = Date.now();
    };
    window.addEventListener('mousemove', resetInteraction, { passive: true });
    window.addEventListener('keydown', resetInteraction, { passive: true });

    // FIX W9: listener de visibilidade — retoma o RAF imediatamente quando a janela volta ao foco
    const handleVisibilityChange = () => {
      if (!isUnmounted && !document.hidden && !isHiddenPauseScheduled) {
        cancelAnimationFrame(animId);
        animId = requestAnimationFrame(animate);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Watchdog vars (declared outside animate for closure)
    let blackFrameCheckDone = false;
    let blackFrameCheckFrames = 0;

    const animate = () => {
      if (isUnmounted) return;
      // BUG CRÍTICO CORRIGIDO: o requestAnimationFrame de re-agendamento foi
      // removido acidentalmente durante o FIX W9 (pausa em document.hidden),
      // matando o loop após o PRIMEIRO frame. Sintomas: Orbe congelado/preto
      // (watchdog nunca completava) e OrbitControls mortos (damping sem update
      // contínuo). O re-agendamento voltou para o topo — sempre agenda o próximo
      // frame antes de qualquer early-return.
      animId = requestAnimationFrame(animate);

      // FIX W9: pausa o loop de RAF quando a janela/aba perde foco (document.hidden)
      // e reagenda com setTimeout de 250ms, evitando consumo de CPU/GPU em segundo plano.
      if (typeof document !== 'undefined' && document.hidden) {
        if (!isHiddenPauseScheduled) {
          isHiddenPauseScheduled = true;
          hiddenPauseTimer = setTimeout(() => {
            hiddenPauseTimer = null;
            isHiddenPauseScheduled = false;
            if (!isUnmounted && typeof document !== 'undefined' && !document.hidden) {
              animId = requestAnimationFrame(animate);
            }
          }, 250);
        }
        return;
      }

      // 1. Otimização de GPU: pausa se elemento fora de tela. CORREÇÃO: antes usava
      // container.offsetParent === null, que também é true quando o elemento está
      // dentro de position:fixed (layout da HomeView!) — o loop morria nesse caso.
      // Substituído por checagem de dimensões reais via getBoundingClientRect.
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      const now = performance.now();
      const currentState = stateRef.current;
      const isIdle = (currentState === 'IDLE' || currentState === 'OFF');

      // 2. Throttling de FPS quando em IDLE para poupar bateria e evitar aquecimento da GPU
      if (isIdle && (now - lastRenderTime < FRAME_INTERVAL_IDLE)) {
        return;
      }
      lastRenderTime = now;

      const t = (now - startTime) / 1000;
      const currentAudioGain = audioGainRef.current;
      const currentProcessing = isProcessingRef.current;
      const stateMode = getStateMode(currentState);
      const activeColors = themeColorsRef.current;
      
      // Adaptive attention: after 30s idle, slow down to conserve resources
      const isIdleLong = (Date.now() - lastInteractionTime > 30000) && isIdle;
      const timeFactor = isIdleLong ? 0.35 : 1.0;
      
      coreMat.uniforms.uTime.value = t * timeFactor;
      coreMat.uniforms.uIntensity.value = (currentProcessing || currentState === 'THINKING' || currentState === 'EXECUTING') ? 1.0 : (currentState === 'SPEAKING' ? 0.8 : 0.0);
      coreMat.uniforms.uAudioGain.value = currentAudioGain;
      coreMat.uniforms.uStateMode.value = stateMode;

      // Reactions according to 6 core states with dynamic theme reflection
      if (stateMode === 1.0) {
        // LISTENING: Reactive to mic audio gain
        const gainScale = 1.0 + (Math.min(1.0, currentAudioGain) * 0.15);
        reactor.scale.setScalar(gainScale);
        ringGroup.rotation.z = t * 0.5;
        reactorMat.emissive.setHex(activeColors.num);
        reactorMat.emissiveIntensity = 0.75 + Math.min(1.0, currentAudioGain) * 0.45;
      } else if (stateMode === 2.0) {
        // THINKING: Accelerated rotation of rings and rapid pulse
        ringGroup.rotation.z = t * 2.2;
        ringGroup.rotation.x = Math.sin(t * 3.0) * 0.4;
        reactor.scale.setScalar(1.0 + Math.sin(t * 12.0) * 0.05);
        reactorMat.emissive.setHex(activeColors.num);
        reactorMat.emissiveIntensity = 1.0;
      } else if (stateMode === 3.0) {
        // SPEAKING: Synchronized accent and white expansion/contraction
        const speakPulse = 1.0 + Math.sin(t * 8.0) * 0.08;
        reactor.scale.setScalar(speakPulse);
        ringGroup.rotation.z = t * 0.8;
        reactorMat.emissive.setHex(activeColors.num);
        reactorMat.emissiveIntensity = 0.85 + Math.sin(t * 6.0) * 0.25;
      } else if (stateMode === 4.0) {
        // EXECUTING: Stable core with rapid orbiters and active beams
        reactor.scale.setScalar(1.03);
        ringGroup.rotation.z = t * 3.0;
        reactorMat.emissive.setHex(activeColors.num);
        reactorMat.emissiveIntensity = 0.95;
      } else if (stateMode === 5.0) {
        // ERROR: Pulsing warning alert
        const errorPulse = 1.0 + Math.abs(Math.sin(t * 6.0)) * 0.1;
        reactor.scale.setScalar(errorPulse);
        reactorMat.emissive.setHex(0xFF0000);
        reactorMat.emissiveIntensity = 1.1;
        ringGroup.rotation.z = t * 0.2;
      } else {
        // IDLE: Relaxed slow pulse with dynamic active theme color (no hardcoded red)
        const idlePulse = isIdleLong ? 1.0 : (1.0 + Math.sin(t * 1.5) * 0.03);
        reactor.scale.setScalar(idlePulse);
        ringGroup.rotation.z = t * 0.25 * timeFactor;
        reactorMat.emissive.setHex(activeColors.num);
        reactorMat.emissiveIntensity = isIdleLong ? 0.45 : 0.75;
      }
      
      // AUDITORIA 3D: damping do OrbitControls exige update() por frame —
      // sem isso o amortecimento não funciona (movimento cortado e sem inércia).
      controlsRef.current?.update();

      composer.render();

      // Watchdog de primeiro frame (uma única execução): amostra o pixel central
      // do canvas. Se for preto puro nas 2 primeiras renderizações reais, dispara
      // o fallback 2D (problema clássico de bloom/float targets no WebView2).
      if (!blackFrameCheckDone) {
        blackFrameCheckFrames += 1;
        if (blackFrameCheckFrames >= 4) {
          blackFrameCheckDone = true;
          try {
            const gl = renderer.getContext();
            const px = new Uint8Array(4);
            // Lê o pixel central do framebuffer (y invertido em GL)
            gl.readPixels(
              Math.floor(gl.drawingBufferWidth / 2),
              Math.floor(gl.drawingBufferHeight / 2),
              1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px
            );
            const isPureBlack = px[0] < 4 && px[1] < 4 && px[2] < 4 && px[3] < 4;
            if (isPureBlack) {
              console.warn('[LioraOrb] Primeiros frames 100% pretos — bloom/float targets não suportados no WebView. Ativando núcleo 2D de fallback.');
              setRenderBlackScreen(true);
            }
          } catch (e) {
            // readPixels indisponível (preserveDrawingBuffer) — não bloqueia
          }
        }
      }
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const nw = container.clientWidth || 360;
      const nh = container.clientHeight || 360;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
      composer.setSize(nw, nh);
    };

    window.addEventListener('resize', handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => handleResize());
      resizeObserver.observe(container);
    }

    return () => {
      isUnmounted = true;
      cancelAnimationFrame(animId);
      if (hiddenPauseTimer) {
        clearTimeout(hiddenPauseTimer);
        hiddenPauseTimer = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', resetInteraction);
      window.removeEventListener('keydown', resetInteraction);
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchend', handleTouchEnd);
      
      // AUDITORIA 3D: dispose do OrbitControls (remove listeners de wheel/pointer)
      try { controlsRef.current?.dispose(); } catch {}
      controlsRef.current = null;

      // Clean up WebGL resources
      // dispose completo do composer e render targets (bloom) — evita vazamento de VRAM
      try {
        composer.passes.forEach((pass) => {
          const p = pass as any;
          p.renderTarget?.dispose?.();
          p.renderTarget1?.dispose?.();
          p.renderTarget2?.dispose?.();
          p.copyUniforms && Object.values(p.copyUniforms).forEach((u: any) => u.value?.dispose?.());
          p.material?.dispose?.();
          p.dispose?.();
        });
        composer.dispose?.();
      } catch (e) {
        // ignore disposal edge cases
      }
      coreMesh.geometry.dispose();
      coreMat.dispose();
      reactor.geometry.dispose();
      reactorMat.dispose();
      ringMeshes.forEach(m => {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      });
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []); // Run ONCE for persistent WebGL lifecycle without canvas recreation!

  // CORREÇÃO: ErrorBoundary + fallback 2D elegante ativado quando (a) WebGL não
  // inicializa, (b) o watchdog detecta frames 100% pretos, ou (c) qualquer erro
  // de render é capturado — o usuário NUNCA fica com área central preta vazia.
  if (hasWebGLError || renderBlackScreen) {
    return (
      <div 
        id="liora-core-canvas" 
        onClick={onClick}
        className="w-full h-full flex items-center justify-center relative overflow-hidden bg-[var(--bg-base,#050505)] cursor-pointer"
      >
        <div className="relative w-64 h-64 md:w-80 md:h-80 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full blur-3xl animate-pulse" style={{ backgroundColor: 'var(--accent-glow)' }} />
          <div className="absolute inset-4 rounded-full border animate-[spin_10s_linear_infinite]" style={{ borderColor: 'var(--accent-border)' }} />
          <div className="absolute inset-10 rounded-full border border-white/20 animate-[spin_15s_linear_infinite_reverse]" />
          <div 
            className="w-32 h-32 rounded-full animate-pulse flex items-center justify-center"
            style={{
              background: `radial-gradient(circle, #FFFFFF 0%, var(--accent-primary) 65%, #050505 100%)`,
              boxShadow: `0 0 50px var(--accent-glow)`
            }}
          >
            <div className="w-16 h-16 rounded-full bg-white/90 shadow-[0_0_20px_#FFFFFF]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      id="liora-core-canvas" 
      ref={containerRef} 
      onClick={onClick}
      className={`w-full h-full cursor-grab transition-all duration-300 ${isMinimized ? 'opacity-80 scale-95' : 'opacity-100 scale-100'}`} 
    />
  );
};
