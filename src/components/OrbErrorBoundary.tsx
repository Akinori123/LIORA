/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { OrbState } from '../types';

interface OrbErrorBoundaryProps {
  state: OrbState;
  audioGain?: number;
  children: React.ReactNode;
}

/**
 * ErrorBoundary dedicado à cena 3D do Orbe.
 *
 * Causa raiz tratada: o WebView2 do Tauri pode falhar silenciosamente na
 * inicialização WebGL (driver sem aceleração, GPU blocklist, contexto perdido)
 * ou lançar durante a compilação de shader/bloom — derrubando a árvore React
 * inteira ou deixando a área central preta. Este boundary isola o canvas 3D e
 * exibe um núcleo 2D elegante (identidade preto/branco/vermelho) sem afetar o
 * restante da aplicação. O estado do Orbe continua refletido na animação CSS.
 */
export class OrbErrorBoundary extends React.Component<OrbErrorBoundaryProps, { hasError: boolean }> {
  constructor(props: OrbErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.warn('[OrbErrorBoundary] Cena 3D falhou, exibindo núcleo 2D de fallback:', error, errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const { state, audioGain = 0 } = this.props;
      const isListening = state === 'LISTENING';
      const isSpeaking = state === 'SPEAKING';
      const isError = state === 'ERROR';
      const isThinking = state === 'THINKING' || state === 'EXECUTING';

      return (
        <div className="w-full h-full flex items-center justify-center relative overflow-hidden bg-[#050505]">
          {/* Halo de luz reativo ao estado */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ background: 'radial-gradient(circle at center, var(--accent-glow) 0%, transparent 60%)' }}
          />
          <div className={`relative w-64 h-64 md:w-80 md:h-80 flex items-center justify-center ${isError ? 'animate-pulse' : ''}`}>
            {/* Anéis orbitais CSS */}
            <div
              className="absolute inset-0 rounded-full blur-3xl"
              style={{ backgroundColor: 'var(--accent-glow)', animationDuration: isThinking ? '0.8s' : '2.5s' }}
            />
            <div
              className={`absolute inset-4 rounded-full border-2 ${isThinking ? 'animate-spin' : ''}`}
              style={{ borderColor: 'var(--accent-border)', animationDuration: '10s' }}
            />
            <div
              className="absolute inset-10 rounded-full border border-white/20 animate-[spin_15s_linear_infinite_reverse]"
            />
            {/* Núcleo pulsante reativo ao áudio */}
            <div
              className="rounded-full flex items-center justify-center transition-all duration-300"
              style={{
                width: `calc(8rem + ${Math.min(1, audioGain)} * 1.5rem)`,
                height: `calc(8rem + ${Math.min(1, audioGain)} * 1.5rem)`,
                background: isError
                  ? 'radial-gradient(circle, #FFFFFF 0%, #FF2B2B 65%, #050505 100%)'
                  : 'radial-gradient(circle, #FFFFFF 0%, var(--accent-primary) 65%, #050505 100%)',
                boxShadow: `0 0 50px var(--accent-glow)`,
                animation: isSpeaking || isListening ? 'pulse 1.2s ease-in-out infinite' : 'pulse 2.5s ease-in-out infinite'
              }}
            >
              <div className="w-16 h-16 rounded-full bg-white/90 shadow-[0_0_20px_#FFFFFF]" />
            </div>
          </div>
          {/* Status textual discreto */}
          <span className="absolute bottom-6 text-[10px] font-mono text-[#666666] tracking-widest uppercase">
            {isError ? 'Orbe indisponível — WebGL fallback ativo' : 'LIORA'}
          </span>
        </div>
      );
    }

    return this.props.children;
  }
}
