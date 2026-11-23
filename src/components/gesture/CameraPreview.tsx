/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Janela flutuante da câmera (prévia + diagnóstico ao vivo).
 *
 * Por que existe: "coloco a mão e diz não rastreável" é impossível de resolver
 * às cegas. Este painel mostra o que a câmera vê, se o vídeo está chegando e se
 * a mão foi vista — e é manipulável, como uma janela de verdade.
 *
 * Bugs corrigidos aqui (auditoria):
 *  1. "Piscando": havia um ponto `animate-pulse` + troca de texto a cada 500ms
 *     dentro de um elemento cuja classe mudava de cor — parecia um LED piscando.
 *     Trocado por um indicador estável (sem animação).
 *  2. Não abria/fechava tamanho: `collapsed` só alternava duas larguras fixas.
 *     Agora há tamanho livre (alça de redimensionar + presets).
 *  3. Não podia ser movida: era `fixed left-4 top-[76px]`. Agora arrasta pelo
 *     cabeçalho, com posição e tamanho persistidos em localStorage.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, Minimize2, Maximize2, Move, X, Hand } from 'lucide-react';
import { gestureService } from '../../services/gestureService';
import { useLioraStore } from '../../store/lioraStore';

const LAYOUT_KEY = 'liora_camera_preview_layout_v1';
const MIN_W = 140;
const MAX_W = 720;

interface PreviewLayout {
  x: number;
  y: number;
  width: number;
}

function loadLayout(): PreviewLayout | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number' && typeof parsed?.width === 'number') {
      return { x: parsed.x, y: parsed.y, width: parsed.width };
    }
  } catch {}
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface CameraPreviewProps {
  /** Exibe o painel apenas quando a câmera está ligada. */
  visible: boolean;
}

export const CameraPreview: React.FC<CameraPreviewProps> = ({ visible }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const settings = useLioraStore((s) => s.settings);
  const updateSettings = useLioraStore((s) => s.updateSettings);
  const [diag, setDiag] = useState(() => gestureService.getDiagnostics());
  const [analysis, setAnalysis] = useState(() => gestureService.getLastAnalysis());
  const [gestureState, setGestureState] = useState(() => gestureService.getState());
  const [layout, setLayout] = useState<PreviewLayout>(() => loadLayout() || { x: 88, y: 76, width: 220 });
  // Gesto em andamento: arrastar (move) ou redimensionar (resize)
  const dragRef = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; originX: number; originY: number; originW: number } | null>(null);

  // Persiste posição/tamanho (debounce leve via rAF do próprio gesto)
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {}
  }, [layout]);

  // Mantém a janela dentro da tela ao redimensionar o app
  useEffect(() => {
    const onResize = () => {
      setLayout((prev) => {
        const maxX = Math.max(0, window.innerWidth - prev.width - 8);
        const maxY = Math.max(0, window.innerHeight - 160);
        return { ...prev, x: clamp(prev.x, 0, maxX), y: clamp(prev.y, 0, maxY) };
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Assinatura de alta taxa (~30fps) do serviço de visão para bounding box fluido
  useEffect(() => {
    if (!visible) return;
    return gestureService.subscribe((next) => {
      setGestureState(next);
    });
  }, [visible]);

  // Prévia + diagnóstico. Reusa o mesmo MediaStream do serviço (nenhuma
  // segunda captura): `attachPreview` só reatribui o srcObject quando muda.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const attach = () => {
      if (!cancelled) gestureService.attachPreview(videoRef.current);
    };
    attach();
    const timer = setInterval(() => {
      attach();
      setDiag(gestureService.getDiagnostics());
      setAnalysis(gestureService.getLastAnalysis());
    }, 600);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible]);

  const beginGesture = useCallback((mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Não inicia o ARRASTE da janela ao clicar em controles — mas a própria alça
    // de redimensionar precisa passar por aqui (antes ela tinha `data-no-drag` e
    // o guard a bloqueava: o redimensionar nunca funcionava).
    if (mode === 'move') {
      const target = e.target as HTMLElement;
      if (target.closest('button, input, select, [role="separator"], [data-no-drag]')) return;
    }
    e.preventDefault();
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      originX: layout.x,
      originY: layout.y,
      originW: layout.width
    };
    // Captura o ponteiro no PRÓPRIO elemento arrastado: o `pointerup` sempre chega
    // nele, mesmo se soltarmos o mouse sobre um botão do cabeçalho (antes o
    // "soltar" acionava o clique do botão de reiniciar e derrubava a câmera).
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  }, [layout]);

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.mode === 'move') {
      setLayout((prev) => ({
        ...prev,
        x: clamp(drag.originX + dx, 0, Math.max(0, window.innerWidth - prev.width)),
        y: clamp(drag.originY + dy, 0, Math.max(0, window.innerHeight - 120))
      }));
      return;
    }

    // Redimensionar mantendo a proporção 4:3 da câmera.
    // CORREÇÃO: ao crescer, a janela não pode invadir a área de chat/cards
    // (chat em y≈530, cards em y≈602). Limitamos a altura máxima da janela ao
    // espaço livre ACIMA da barra, recalculando a largura correspondente.
    const maxWidthBySpace = Math.max(
      MIN_W,
      Math.floor((Math.max(MIN_W, layout.y > 0 ? layout.y - 12 : MIN_W) / 0.75))
    );
    const nextWidth = clamp(drag.originW + dx, MIN_W, Math.min(MAX_W, maxWidthBySpace));
    // A altura da janela (largura × 0.75) tem de caber na tela: sem o limite
    // vertical, arrastar a alça puxava a prévia para fora do fundo da janela.
    const maxHeightByScreen = Math.max(120, window.innerHeight - layout.y - 24);
    const maxWidthByHeight = Math.floor(maxHeightByScreen / 0.75);
    setLayout((prev) => ({ ...prev, width: Math.max(MIN_W, Math.min(nextWidth, maxWidthByHeight)) }));
  };

  const endGesture = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  if (!visible) return null;

  const videoAlive = diag.videoReadyState >= 2 && diag.videoWidth > 0;
  const handFresh = diag.handDetected && (diag.lastSeenMsAgo === -1 || diag.lastSeenMsAgo < 3000);
  // Altura proporcional (4:3) da JANELA (vídeo + overlay de diagnóstico).
  // Antes a altura era só `largura × 0.75`: o overlay de status (≈16px) não
  // era contabilizado e vazava/cobria a borda inferior da prévia.
  const videoHeight = Math.round(layout.width * 0.75) + 16;
  const compact = layout.width < 320;

  return (
    <div
      data-testid="camera-preview"
      data-analysis={JSON.stringify(analysis)}
      className="fixed z-40 pointer-events-auto rounded-xl overflow-hidden border border-[#2A2A2A] bg-[#0A0A0A]/95 shadow-2xl backdrop-blur-md select-none"
      style={{ left: layout.x, top: layout.y, width: layout.width }}
    >
      {/* Cabeçalho = área de arraste */}
      <div
        role="toolbar"
        aria-label="Mover janela da câmera"
        className="flex items-center justify-between px-2 py-1.5 border-b border-[#222222] cursor-move touch-none"
        onPointerDown={beginGesture('move')}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        title="Arraste para mover a janela"
      >
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-[#A8A8A8] min-w-0">
          <Move className="w-3 h-3 text-[#555] shrink-0" />
          <Camera className="w-3 h-3 text-[var(--accent-primary)] shrink-0" />
          {!compact && 'VISÃO'}
          {/* Mão rastreada — indicador estável, sem animação que pisque */}
          <Hand
            className={`w-3 h-3 ml-0.5 ${gestureState.handDetected ? 'text-emerald-400' : 'text-[#444]'}`}
            aria-hidden="true"
          />
        </span>
        <div className="flex items-center gap-1 min-w-0">
          {/* Botão de Ligar/Desligar Controle de Cursor por Gestos */}
          <button
            type="button"
            onClick={() => {
              const next = !settings.gestureControlEnabled;
              updateSettings({ gestureControlEnabled: next });
              gestureService.setCursorControlEnabled(next);
            }}
            /* Janela estreita (220px padrão): só o ícone. O texto "Cursor On"
               alargava o cabeçalho e os 5 botões estouravam/sobrepunham linhas. */
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono border transition-all flex items-center gap-1 cursor-pointer shrink-0 ${
              settings.gestureControlEnabled
                ? 'bg-emerald-950/70 text-emerald-300 border-emerald-500/60 hover:bg-emerald-900/60 shadow-sm shadow-emerald-500/20'
                : 'bg-zinc-900/90 text-zinc-400 border-zinc-700/60 hover:text-white'
            }`}
            title={
              settings.gestureControlEnabled
                ? 'Cursor de Gestos ATIVO: sua mão move o mouse e clica. Clique para desligar o cursor e usar a câmera só para visão.'
                : 'Cursor de Gestos DESLIGADO: a câmera apenas observa rosto/objetos. Clique para controlar o cursor com a mão.'
            }
            aria-label="Alternar controle do mouse por gestos"
            aria-pressed={settings.gestureControlEnabled}
          >
            <Hand className="w-2.5 h-2.5 shrink-0" />
            {!compact && <span className="whitespace-nowrap">{settings.gestureControlEnabled ? 'Cursor On' : 'Cursor Off'}</span>}
          </button>

          {/* Indicador ESTÁVEL (sem animate-pulse — era o que "piscava") */}
          <span
            className={`w-2 h-2 rounded-full ${videoAlive ? (gestureState.handDetected ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-red-500'}`}
            title={videoAlive ? (gestureState.handDetected ? 'Mão detectada' : 'Câmera OK — sem mão no quadro') : 'Sem imagem'}
          />
          <button
            type="button"
            onClick={() => gestureService.restart()}
            className="p-0.5 rounded text-[#777777] hover:text-white"
            title="Reiniciar câmera"
            aria-label="Reiniciar câmera"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => updateSettings({ cameraEnabled: false, gestureControlEnabled: false })}
            className="p-0.5 rounded text-[#777777] hover:text-red-400"
            title="Desligar câmera"
            aria-label="Desligar câmera"
          >
            <X className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => setLayout((p) => ({ ...p, width: p.width > 300 ? 220 : 420 }))}
            className="p-0.5 rounded text-[#777777] hover:text-white"
            title={layout.width > 300 ? 'Reduzir janela' : 'Ampliar janela'}
            aria-label={layout.width > 300 ? 'Reduzir janela da câmera' : 'Ampliar janela da câmera'}
          >
            {layout.width > 300 ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
      </div>

      <div className="relative z-0 bg-black overflow-hidden" style={{ height: videoHeight }}>
        <video
          ref={videoRef}
          muted
          autoPlay
          playsInline
          className="w-full h-full object-cover"
          style={{ transform: gestureState.invertX ? 'scaleX(-1)' : 'none' }}
        />

        {/* ── CAMADA DE VISÃO: LINHAS AO REDOR DO ALVO (BOUNDING BOX) ── */}
        {videoAlive && gestureState.handDetected && gestureState.boundingBox && (
          <div
            className="absolute pointer-events-none transition-all duration-75 border-2 rounded-lg"
            style={{
              // A prévia é espelhada SOMENTE quando o eixo X está invertido (o
              // serviço já inverte o centróide). Antes o vídeo era sempre
              // espelhado e o box INVERTIA o X de novo — o retângulo aparecia do
              // lado oposto da mão e o cursor no HUD movia ao contrário da prévia.
              left: `${Math.max(2, Math.min(94, gestureState.boundingBox.minX * 100))}%`,
              top: `${Math.max(2, Math.min(94, gestureState.boundingBox.minY * 100))}%`,
              width: `${Math.max(6, Math.min(96, gestureState.boundingBox.width * 100))}%`,
              height: `${Math.max(6, Math.min(96, gestureState.boundingBox.height * 100))}%`,
              borderColor: gestureState.targetType === 'hand' ? '#10B981' : '#F59E0B',
              backgroundColor: gestureState.targetType === 'hand' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)',
              boxShadow: gestureState.targetType === 'hand'
                ? '0 0 12px rgba(16, 185, 129, 0.4), inset 0 0 8px rgba(16, 185, 129, 0.2)'
                : '0 0 12px rgba(245, 158, 11, 0.4), inset 0 0 8px rgba(245, 158, 11, 0.2)'
            }}
          >
            {/* Cantos Estilizados HUD (Corner Brackets) */}
            <div className="absolute -top-1 -left-1 w-2.5 h-2.5 border-t-2 border-l-2 border-white rounded-tl-sm shadow-sm" />
            <div className="absolute -top-1 -right-1 w-2.5 h-2.5 border-t-2 border-r-2 border-white rounded-tr-sm shadow-sm" />
            <div className="absolute -bottom-1 -left-1 w-2.5 h-2.5 border-b-2 border-l-2 border-white rounded-bl-sm shadow-sm" />
            <div className="absolute -bottom-1 -right-1 w-2.5 h-2.5 border-b-2 border-r-2 border-white rounded-br-sm shadow-sm" />

            {/* Rótulo de Identificação do Alvo com Tag */}
            <div className="absolute -top-5 left-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono font-bold bg-black/90 text-white border border-white/20 whitespace-nowrap shadow-md">
              <span>{gestureState.targetType === 'hand' ? '🖐️ MÃO' : '📦 ALVO'}</span>
              <span className="text-emerald-400 font-normal">● Rastreando</span>
            </div>
          </div>
        )}

        {!videoAlive && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-2 py-1 text-[9px] font-mono text-red-300 leading-tight overflow-hidden">
            <span className="line-clamp-5">
              Sem imagem. {diag.error ? diag.error.split('.')[0] + '.' : 'Aguardando a câmera...'}
            </span>
          </div>
        )}
        {videoAlive && (
          <div className="absolute bottom-1 left-1.5 right-1.5 flex items-center justify-between gap-1 text-[8px] font-mono pointer-events-none bg-black/65 px-1.5 py-0.5 rounded backdrop-blur-xs">
            <span className={`truncate ${gestureState.handDetected ? 'text-emerald-300 font-bold' : 'text-amber-300/90'}`}>
              {gestureState.handDetected 
                ? (gestureState.targetType === 'hand' ? '🖐️ MÃO DETECTADA' : '📦 OBJETO DETECTADO') 
                : '🔍 AGUARDANDO ALVO'}
            </span>
            {!compact && (
              <span className="text-[#888888] whitespace-nowrap shrink-0">{diag.videoWidth}×{diag.videoHeight} • {settings.gestureControlEnabled ? 'Cursor On' : 'Só Visão'}</span>
            )}
          </div>
        )}
      </div>

      {/* Alça de redimensionar (canto inferior direito) */}
      <div
        role="separator"
        aria-label="Redimensionar janela da câmera"
        title="Arraste para redimensionar"
        data-no-drag
        className="absolute bottom-0 right-0 w-5 h-5 z-20 cursor-nwse-resize touch-none flex items-end justify-end"
        onPointerDown={beginGesture('resize')}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <svg viewBox="0 0 16 16" className="w-full h-full text-[#666] pointer-events-none" aria-hidden="true">
          <path d="M15 15H9L15 9V15ZM15 9H11L15 5V9Z" fill="currentColor" opacity="0.7" />
        </svg>
      </div>
    </div>
  );
};
