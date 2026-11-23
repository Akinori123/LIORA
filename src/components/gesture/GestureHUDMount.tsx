/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Montagem ISOLADA do HUD de gestos + prévia da câmera.
 *
 * Por que existe: o HUD assina o `gestureService` (loop de vídeo + análise por
 * frame). Uma exceção nesse caminho — módulo de visão quebrado, WebView sem
 * canvas 2D — derrubava a árvore React inteira (tela branca), já que não havia
 * error boundary nesse ponto. Aqui o overlay morre sozinho e o resto do app
 * continua utilizável.
 */
import React from 'react';
import { GestureHUD } from './GestureHUD';
import { CameraPreview } from './CameraPreview';
import { useLioraStore } from '../../store/lioraStore';

class GestureOverlayBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean; message: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { failed: false, message: null };
  }

  static getDerivedStateFromError(err: unknown) {
    return { failed: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.warn('[GestureHUD] Overlay de gestos desativado após erro:', error, info?.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="fixed bottom-3 right-3 z-[9998] max-w-[260px] px-2 py-1 rounded border border-red-800/60 bg-red-950/80 text-[10px] font-mono text-red-200">
          Câmera/gestos indisponível: {this.state.message || 'erro interno'}
        </div>
      );
    }
    return this.props.children;
  }
}

export const GestureHUDMount: React.FC = () => {
  const cameraOn = useLioraStore(
    (s) => Boolean(s.settings.cameraEnabled || s.settings.gestureControlEnabled)
  );
  const showPreview = useLioraStore((s) => Boolean(s.settings.cameraEnabled));
  // Prévia só na Início (como antes): em outras abas ela cobriria estúdios como
  // o Desenvolvedor. O HUD (cursor/badge) continua global.
  const onHome = useLioraStore((s) => s.activeTab === 'home');

  return (
    <GestureOverlayBoundary>
      {showPreview && <CameraPreview visible={cameraOn && onHome} />}
      <GestureHUD />
    </GestureOverlayBoundary>
  );
};

export default GestureHUDMount;
