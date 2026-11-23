/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — HUD Visual de Controle por Gestos e Rastreamento de Objetos (Visão Computacional)
 * Exibe cursor virtual em tempo real, retículo de objetos, alternância de eixo e feedback tátil.
 */

import React, { useEffect, useRef, useState } from 'react';
import { gestureService, GestureState } from '../../services/gestureService';
import { 
  Hand, 
  Eye, 
  EyeOff, 
  Repeat,
  RefreshCw,
  Box
} from 'lucide-react';
import { useLioraStore } from '../../store/lioraStore';

export const GestureHUD: React.FC = () => {
  // O componente ativo também precisa existir com a câmera ligada SOMENTE para
  // visão (cameraEnabled sem gesto). Antes ele só montava com gesto habilitado e
  // ninguém iniciava a câmera nesse modo: o botão da câmera "acendia" mas a
  // prévia ficava permanentemente em "Sem imagem". O CSS esconde cursor/badge
  // quando o controle por gestos está desligado.
  const cameraOn = useLioraStore(
    (s) => Boolean(s.settings.cameraEnabled || s.settings.gestureControlEnabled)
  );
  // Gate de render (nunca de hooks): o componente ativo declara 100% dos hooks.
  if (!cameraOn) return null;
  return <GestureHudActive key="gesture-hud-active" />;
};

const GestureHudActive: React.FC = () => {
  const [state, setState] = useState<GestureState>(gestureService.getState());
  // Throttle de render: o serviço emite ~30x/s. Re-renderizar o HUD inteiro
  // (badge + blur + ícones) nessa taxa engasga o WebView2 e o cursor parece
  // travado. Atualiza no máximo a ~20Hz, sempre mantendo o último estado.
  const latestStateRef = useRef<GestureState>(gestureService.getState());
  const frameRef = useRef<number | null>(null);
  // Controla apenas a minimização do BADGE flutuante de gestos (o "x").
  const [isBadgeMinimized, setIsBadgeMinimized] = useState(false);

  // ATENÇÃO: assinatura individual dos campos usados (evita re-render infinito)
  const settings = useLioraStore((s) => s.settings);
  const updateSettings = useLioraStore((s) => s.updateSettings);
  // Toast do Intent Router: o badge se desloca para não cobri-lo.
  const isHomeToastVisible = useLioraStore((s) => s.isHomeToastVisible);
  
  // Desacoplamento arquitetural: Câmera x Cursor por gestos
  const isCameraEnabled = Boolean(settings.cameraEnabled || settings.gestureControlEnabled);
  const isCursorControlEnabled = Boolean(settings.gestureControlEnabled);
  const showFeedback = settings.gestureVisualFeedback ?? true;

  // Sincroniza controle de cursor + limpeza no unmount (evita "cursor órfão":
  // o serviço é um singleton e continuava clicando na interface depois que a
  // HUD sumia ou que a opção era desligada).
  useEffect(() => {
    gestureService.setCursorControlEnabled(isCursorControlEnabled);
    return () => {
      gestureService.setCursorControlEnabled(false);
    };
  }, [isCursorControlEnabled]);

  const [isCalibrating, setIsCalibrating] = useState(false);
  // O controle por gestos está desligado: a HUD continua montada (para a câmera
  // de visão), mas nunca exibe cursor, badge ou captura cliques.
  const gestureUiHidden = !settings.gestureControlEnabled;

  // ── Assinatura do serviço de visão (o badge/cursor precisam do estado vivo) ──
  useEffect(() => {
    return gestureService.subscribe((next) => {
      latestStateRef.current = next;
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          setState(latestStateRef.current);
        });
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  // Sincroniza inicialização da câmera com as configurações do usuário
  useEffect(() => {
    if (isCameraEnabled && !state.isActive) {
      // Pausa antes de tentar: o WebView2 recusa abrir a webcam durante o boot
      const t = setTimeout(() => {
        if (!gestureService.getState().isActive) {
          void gestureService.start();
        }
      }, 900);
      return () => clearTimeout(t);
    } else if (!isCameraEnabled && state.isActive) {
      gestureService.stop();
    }
  }, [isCameraEnabled, state.isActive]);

  // Sincroniza sensibilidade
  useEffect(() => {
    if (settings.gestureSensitivity) {
      gestureService.setSensitivity(settings.gestureSensitivity);
    }
  }, [settings.gestureSensitivity]);

  // Sincroniza inversão do eixo X
  useEffect(() => {
    if (typeof settings.gestureInvertX === 'boolean') {
      gestureService.setInvertX(settings.gestureInvertX);
    }
  }, [settings.gestureInvertX]);

  // Sincroniza o rastreamento de objetos (toggle antes sem efeito real)
  useEffect(() => {
    if (typeof settings.gestureObjectTracking === 'boolean') {
      gestureService.setObjectTrackingEnabled(settings.gestureObjectTracking);
    }
  }, [settings.gestureObjectTracking]);

  // Trava guiada de calibração do fundo (segurar o botão de recalibrar)
  useEffect(() => {
    gestureService.setBackgroundFreeze(isCalibrating);
    if (!isCalibrating) return;
    const interval = setInterval(() => gestureService.recalibrateBackground(), 250);
    return () => {
      clearInterval(interval);
      gestureService.setBackgroundFreeze(false);
    };
  }, [isCalibrating]);

  // Visibilidade do cursor virtual: SÓ EXIBE SE O USUÁRIO ATIVOU O CONTROLE POR GESTOS.
  // NOTA: antes era exigido `state.isActive` (captura rodando). Se a câmera caía
  // por um instante — ou se o usuário estava na Home minimizada — o cursor
  // sumia e voltava ao centro, exatamente o sintoma "o cursor não acompanha a
  // mão". O cursor agora só depende do CONTROLE (e do feedback visual);
  // `handDetected` indica se a mão está sendo vista naquele instante.
  const showPointer = isCursorControlEnabled && showFeedback;

  // Retângulo/cursor seguem a MESMA orientação: quando o cursor está espelhado
  // (invertX + espelho da própria imagem), a prévia é espelhada por CSS e o box
  // (que vem em coordenadas da imagem) precisa ser espelhado também para cair do
  // lado da mão na tela. Antes o box era sempre desenhado em coordenadas cruas.
  const mirrored = Boolean(state.cursorMirrored ?? state.invertX);

  // ── Retângulo de visão FORA de porções estáveis (sem re-render global) ──
  // O estado do serviço é publicado ~30x/s. Renderizar o retângulo via `setState`
  // a cada frame re-renderizava o HUD inteiro (cursor + badge + ícones), o que no
  // WebView2 engasga e faz o ponteiro "travar/pular". O retângulo é atualizado
  // direto no DOM por este efeito; o React redesenha só quando muda o ESTADO
  // estável (mão detectada / tipo de alvo).
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showPointer) return;
    let rafId: number | null = null;
    const paint = () => {
      rafId = null;
      const box = boxRef.current;
      if (!box) return;
      const st = latestStateRef.current;
      const b = st.boundingBox;
      const visible = Boolean(st.handDetected && b);
      box.style.opacity = visible ? '1' : '0';
      if (!visible || !b) return;
      const mirroredNow = Boolean(st.cursorMirrored ?? st.invertX);
      const sidebar = (() => {
        try {
          const raw = getComputedStyle(document.documentElement).getPropertyValue('--liora-sidebar-width');
          const parsed = parseFloat(raw);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        } catch {
          return 0;
        }
      })();
      const usableWidth = Math.max(1, window.innerWidth - sidebar);
      // O box vem do canvas (0..1) exatamente com a mesma orientação do centRÓIDE
      // (que já respeita o espelho), então NADA de inverter o X aqui — antes ele
      // era espelhado de novo e o retângulo aparecia do lado oposto da mão.
      const left = sidebar + (mirroredNow ? (1 - b.maxX) : b.minX) * usableWidth;
      const top = b.minY * window.innerHeight;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${b.width * usableWidth}px`;
      box.style.height = `${b.height * window.innerHeight}px`;
      box.style.borderColor = st.targetType === 'hand' ? 'rgba(16,185,129,0.9)' : 'rgba(245,158,11,0.9)';
      box.style.backgroundColor = st.targetType === 'hand' ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.10)';
    };
    const unsubscribe = gestureService.subscribe(() => {
      if (rafId === null) rafId = requestAnimationFrame(paint);
    });
    return () => {
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [showPointer]);

  // Informa o serviço se o cursor está realmente visível: com o cursor oculto,
  // o "fechar a mão" não pode clicar às cegas em botões que o usuário não vê.
  useEffect(() => {
    gestureService.pointerVisible = showPointer;
    return () => {
      gestureService.pointerVisible = false;
    };
  }, [showPointer]);

  // ── A partir daqui só há valores derivados e callbacks (nenhum hook) ──
  const handleToggleInvertX = () => {
    const next = !state.invertX;
    gestureService.setInvertX(next);
    updateSettings({ gestureInvertX: next });
  };

  const handleRecalibrate = () => {
    gestureService.recalibrateBackground();
  };

  const startCalibrationHold = () => {
    gestureService.recalibrateBackground();
    setIsCalibrating(true);
  };
  const stopCalibrationHold = () => setIsCalibrating(false);

  // Erro real da câmera (exibido no badge) — valor derivado, sem hook.
  const { error } = state;

  if (gestureUiHidden) return null;

  return (
    <>
      {/* 1. Cursor Virtual de Mão / Retículo de Objeto Luminoso */}
      {showPointer && (
        <div
          ref={boxRef}
          data-testid="virtual-hand-box"
          aria-hidden="true"
          className="pointer-events-none fixed z-[9998] border-2 rounded-lg transition-opacity duration-150"
          style={{ opacity: 0 }}
        />
      )}
      {showPointer && (
        <div
          data-testid="virtual-hand-pointer"
          className="pointer-events-none fixed z-[9999] transition-transform duration-[75ms]"
          style={{
            // A esquerda do HUD é a MESMA origem do clique (triggerFistClick):
            // área útil = janela MENOS a sidebar. Com 100vw o cursor e o clique
            // ficavam deslocados quando havia sidebar (o ponteiro pousava em outro
            // elemento). O `calc` abaixo é exatamente `sidebar + util * handX`.
            left: `calc(var(--liora-sidebar-width, 0px) + (100vw - var(--liora-sidebar-width, 0px)) * ${state.handX})`,
            top: `${state.handY * 100}vh`,
            // CORREÇÃO (cursor e alvo desalinhados): `transition-all` animava
            // TAMBÉM o `transform` — o `-translate-x-1/2` era interpolado do zero
            // a cada atualização de posição, então o ponto visível ficava sempre
            // deslocado do centroide que o punho clicava. só transform com
            // duração curta, e o translate é aplicado por classe.
            transform: 'translate(-50%, -50%)'
          }}
        >
          <div className="relative flex items-center justify-center">
            {/* Efeito de onda de choque e feedback tátil ao fechar a mão (Fist Click) */}
            {state.activeGesture === 'fist_click' && (
              <>
                <div className="animate-ping absolute w-16 h-16 rounded-full border-2 border-emerald-400 bg-emerald-400/30" />
                <div className="absolute -top-8 whitespace-nowrap px-2.5 py-0.5 bg-emerald-950/95 border border-emerald-500/70 rounded-full text-[11px] font-bold text-emerald-300 shadow-xl font-mono">
                  ✊ Clique!
                </div>
              </>
            )}

            {/* Núcleo do cursor diferenciado por tipo de alvo rastreado */}
            {state.targetType === 'object' ? (
              // Retículo para Objetos Físicos segurados na câmera
              <div className="relative flex items-center justify-center">
                <div className="w-7 h-7 rounded-lg border-2 border-amber-400/90 bg-amber-500/20 shadow-[0_0_14px_rgba(245,158,11,0.5)] flex items-center justify-center">
                  <Box className="w-3.5 h-3.5 text-amber-300" />
                </div>
                <div className="absolute -bottom-6 whitespace-nowrap px-2 py-0.5 bg-black/85 border border-amber-500/40 rounded text-[9px] text-amber-300 font-mono">
                  📦 Objeto
                </div>
              </div>
            ) : (
              // Cursor Circular para Mão Humana / Controle de Tela
              <div 
                className={`rounded-full border shadow-lg flex items-center justify-center transition-all ${
                  state.activeGesture === 'fist_click'
                    ? 'w-7 h-7 bg-emerald-500 scale-125 border-white shadow-emerald-500/50'
                    : state.handDetected
                    ? 'w-5 h-5 border-white/90 scale-100 shadow-[0_0_12px_var(--accent-glow)]'
                    : 'w-6 h-6 border-dashed border-white/50 bg-[#1A1A1A]/70 scale-95'
                }`}
                style={{ 
                  backgroundColor: state.activeGesture === 'fist_click'
                    ? '#10B981'
                    : state.handDetected
                    ? 'var(--accent-primary)'
                    : 'rgba(30, 30, 30, 0.65)',
                  boxShadow: state.activeGesture === 'fist_click'
                    ? '0 0 18px #10B981'
                    : state.handDetected
                    ? '0 0 12px var(--accent-glow)'
                    : '0 0 6px rgba(255,255,255,0.15)'
                }}
              >
                <div 
                  className={`rounded-full transition-all ${
                    state.handDetected ? 'w-2 h-2 bg-white' : 'w-1.5 h-1.5 bg-amber-400/80'
                  }`} 
                />
              </div>
            )}

            {/* Dica flutuante quando ainda aguarda alvo */}
            {!state.handDetected && (
              <div className="absolute top-7 whitespace-nowrap px-2 py-0.5 bg-black/85 border border-[#333333] rounded-md text-[10px] text-amber-300/90 shadow font-mono pointer-events-none">
                🖐️ Mostre a mão ou objeto
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. Badge do HUD de gestos.
          GEOMETRIA MEDIDA (1280x720, sidebar 80px): barra de chat x=[360..1000]
          y=[530..588]; faixa de cards y=[602..655] (oscards ocupam x≈[424..936]);
          dica inferior em y≈676. Qualquer badge ancorado à direita na altura dos
          cards sobrepunha o card "Cofre". Por isso ele fica empilhado ACIMA da
          barra de chat, encostado à direita: y=[490..522], livre de todo conteúdo
          interativo, com largura limitada e quebra de linha. */}
      {/* Badge de gestos: medido em 1280x720 — barra global de voz ocupa
          y=[635..683], chat em y=[530..588], cards em y=[602..655]. O badge fica
          ACIMA de tudo isso (y≈[409..464]) com margem da borda direita. */}
      <div className={`fixed z-40 select-none pointer-events-none right-4 xl:right-6 max-w-[220px] transition-all duration-200 ${
        isHomeToastVisible ? 'bottom-[300px]' : 'bottom-[262px]'
      }`}>
        {isBadgeMinimized ? (
          <button
            type="button"
            onClick={() => setIsBadgeMinimized(false)}
            className="pointer-events-auto p-2.5 bg-[#121212]/95 hover:bg-[#1C1C1C] border border-[#333333] hover:border-[var(--accent-primary)] rounded-full text-white shadow-xl backdrop-blur-sm transition-all cursor-pointer"
            title="Expandir Controle por Gestos"
            aria-label="Expandir Controle por Gestos"
          >
            <Hand className="w-4 h-4 text-[var(--accent-primary)]" />
          </button>
        ) : (
          <div className="pointer-events-auto inline-flex flex-wrap items-center justify-end gap-1 max-w-[230px] px-2 py-1 bg-[#101010]/97 border border-[#2A2A2A] rounded-lg text-xs text-white shadow-2xl backdrop-blur-md font-mono">
            <div className="flex items-center gap-1.5 min-w-0">
              {/* Indicador ESTÁVEL: o `animate-ping` fazia o badge parecer um LED
                  piscando sem parar. Agora só muda de cor conforme o estado. */}
              <span
                className={`inline-flex rounded-full h-2 w-2 shrink-0 ${
                  state.isActive
                    ? (state.handDetected ? 'bg-emerald-400' : 'bg-amber-500')
                    : 'bg-zinc-600'
                }`}
              />
              <Hand className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
            {/* Erro real da câmera (exibido no badge) — valor derivado, sem hook. */}
            <span
              className="text-[10px] font-semibold text-[#CCCCCC] truncate max-w-[130px]"
              title={error || undefined}
            >
              {state.isStarting
                ? '⏳ Abrindo câmera...'
                : error
                ? '⚠ Erro na câmera'
                : !state.isActive
                ? '⏸ Câmera Inativa'
                : state.activeGesture === 'fist_click'
                ? '✊ Clique Realizado!'
                : (state.activeGesture === 'wave_down' || state.activeGesture === 'wave_up')
                ? '↕ Rolando Tela'
                : state.targetType === 'object'
                ? '📦 Objeto Rastreado'
                : (state.handDetected ? '🖐 Mão Rastreada' : 'Aguardando Alvo')}
            </span>
              {/* Erro completo, legível, sem estourar o badge */}
              {error && (
                <span
                  className="hidden xl:block text-[9px] text-red-300/90 max-w-[210px] truncate"
                  title={error}
                >
                  {error}
                </span>
              )}
            </div>

            <div className="h-3 w-[1px] bg-[#333333] mx-0.5" />

            {/* Religa a câmera após falha (usa restart() — antes start() saía cedo
                com isRunning ainda true e o clique não fazia nada). */}
            {!state.isActive && !state.isStarting && (
              <button
                type="button"
                onClick={() => {
                  gestureService.notifyAttempt();
                  gestureService.restart();
                }}
                className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/40 transition-colors cursor-pointer"
                title="Tentar ativar a câmera novamente"
                aria-label="Tentar ativar a câmera novamente"
              >
                ▶ Tentar
              </button>
            )}

            {/* Alternância Rápida de Cursor de Gestos (Ligar/Desligar) */}
            <button
              type="button"
              onClick={() => {
                const next = !isCursorControlEnabled;
                updateSettings({ gestureControlEnabled: next });
                gestureService.setCursorControlEnabled(next);
              }}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer border flex items-center gap-1 ${
                isCursorControlEnabled 
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/60' 
                  : 'bg-zinc-900 text-zinc-400 border-zinc-700/50 hover:text-white'
              }`}
              title={isCursorControlEnabled ? 'Desligar controle do mouse por gestos' : 'Ligar controle do mouse por gestos'}
              aria-label="Alternar controle do mouse por gestos"
            >
              <Hand className="w-3 h-3" />
              <span>{isCursorControlEnabled ? 'Cursor On' : 'Cursor Off'}</span>
            </button>

            {/* Alternância Rápida de Inversão de Eixo X (Espelho / Direto) */}
            <button
              type="button"
              onClick={handleToggleInvertX}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-colors cursor-pointer border ${
                state.invertX 
                  ? 'bg-amber-950/40 text-amber-300 border-amber-800/40' 
                  : 'bg-zinc-900 text-zinc-300 border-zinc-700/50 hover:text-white'
              }`}
              title="Inverter direção horizontal do cursor (alterna entre modo espelho e direto)"
              aria-label="Inverter eixo X"
            >
              ⇄ {state.invertX ? 'Invertido' : 'Direto'}
            </button>

            {/* Recalibração de Fundo — SEGURE o botão com a mão fora do quadro */}
            <button
              type="button"
              onClick={handleRecalibrate}
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                startCalibrationHold();
              }}
              onPointerUp={stopCalibrationHold}
              onPointerLeave={stopCalibrationHold}
              onPointerCancel={stopCalibrationHold}
              className={`p-1 rounded transition-colors cursor-pointer ${
                isCalibrating ? 'text-emerald-400' : 'text-[#888888] hover:text-white'
              }`}
              title="Segure com a mão FORA do enquadramento para o sensor aprender o fundo (a mão parada deixa de sumir)"
              aria-label="Recalibrar fundo (segurar)"
              aria-pressed={isCalibrating}
            >
              <RefreshCw className="w-3 h-3" />
            </button>

            {/* Ocultar/Exibir Cursor */}
            {isCursorControlEnabled && (
              <button
                type="button"
                onClick={() => {
                  updateSettings({ gestureVisualFeedback: !showFeedback });
                }}
                className="p-1 rounded text-[#888888] hover:text-white transition-colors cursor-pointer"
                title={showFeedback ? 'Ocultar cursor visual' : 'Mostrar cursor visual'}
                aria-label={showFeedback ? 'Ocultar cursor' : 'Mostrar cursor'}
              >
                {showFeedback ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 text-red-400" />}
              </button>
            )}

            {/* Desligamento Rápido da Câmera */}
            <button
              type="button"
              onClick={() => {
                updateSettings({ cameraEnabled: false, gestureControlEnabled: false });
              }}
              className="px-1.5 py-0.5 rounded text-[10px] bg-red-950/40 hover:bg-red-900/60 text-red-300 border border-red-800/40 transition-colors cursor-pointer"
              title="Desativar Câmera"
              aria-label="Desativar Câmera"
            >
              Desativar
            </button>

            <button
              type="button"
              onClick={() => setIsBadgeMinimized(true)}
              className="p-1 rounded text-[#777777] hover:text-white transition-colors text-[10px] cursor-pointer"
              title="Minimizar badge"
              aria-label="Minimizar badge"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </>
  );
};
