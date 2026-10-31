/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  Camera, 
  Send, 
  X, 
  Cpu, 
  Terminal, 
  Command,
  ArrowRight
} from 'lucide-react';
import { captureScreen } from '../tools/screenCapture';

interface QuickOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmitPrompt: (text: string, imageBase64?: string) => void;
}

export const QuickOverlay: React.FC<QuickOverlayProps> = ({
  isOpen,
  onClose,
  onSubmitPrompt
}) => {
  const [inputText, setInputText] = useState('');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setInputText('');
      setAttachedImage(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCaptureScreen = async () => {
    setIsCapturing(true);
    try {
      const res = await captureScreen();
      setAttachedImage(res.base64Data);
    } catch (err) {
      console.error('[QuickOverlay] Erro ao capturar tela:', err);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() && !attachedImage) return;

    onSubmitPrompt(inputText.trim(), attachedImage || undefined);
    setInputText('');
    setAttachedImage(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/75 backdrop-blur-md transition-all animate-fade-in">
      <div className="w-full max-w-2xl bg-[#111111] border border-[#333333] rounded-2xl shadow-2xl overflow-hidden space-y-0 relative">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#161616] border-b border-[#222222] text-xs font-mono">
          <div className="flex items-center gap-2 text-white font-medium">
            <Sparkles className="w-4 h-4 text-[var(--accent-primary)] animate-pulse" />
            <span>LIORA Quick Launcher</span>
            <span className="text-[#666666]">•</span>
            <span className="text-[#A8A8A8] text-[11px]">Alt + Space</span>
          </div>
          <button 
            onClick={onClose}
            className="text-[#888888] hover:text-white transition-colors p-1"
            title="Fechar (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Input */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          {/* Image Preview attachment if present */}
          {attachedImage && (
            <div className="relative inline-block border border-[var(--accent-primary)] rounded-lg p-1 bg-[#161616] animate-fade-in">
              <img 
                src={`data:image/jpeg;base64,${attachedImage}`} 
                alt="Capture Preview" 
                className="w-32 h-20 object-cover rounded"
              />
              <button
                type="button"
                onClick={() => setAttachedImage(null)}
                className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600 transition-colors"
                title="Remover Captura"
              >
                <X className="w-3 h-3" />
              </button>
              <span className="block text-[10px] font-mono text-[var(--accent-primary)] mt-1 px-1">
                Captura de Tela Anexada
              </span>
            </div>
          )}

          <div className="flex items-center gap-3 bg-[#171717] border border-[#2B2B2B] focus-within:border-[var(--accent-primary)] rounded-xl px-4 py-3 transition-all">
            <Command className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Como a LIORA pode ajudar você agora? Digite um comando ou pergunta..."
              className="flex-1 bg-transparent text-sm text-white placeholder-[#666666] focus:outline-none font-sans"
            />
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCaptureScreen}
                disabled={isCapturing}
                className="p-2 bg-[#222222] hover:bg-[#2B2B2B] text-white rounded-lg transition-colors flex items-center gap-1 text-xs font-mono"
                title="Capturar tela atual e anexar para análise multimodal"
              >
                <Camera className="w-4 h-4 text-emerald-400" />
                <span className="hidden sm:inline">{isCapturing ? 'Capturando...' : 'Tela'}</span>
              </button>

              <button
                type="submit"
                disabled={!inputText.trim() && !attachedImage}
                className="px-4 py-2 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-lg shadow-md shadow-[var(--accent-glow)] flex items-center gap-1.5 transition-all disabled:opacity-40"
              >
                <span>Enviar</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </form>

        {/* Footer shortcuts tip */}
        <div className="px-5 py-2.5 bg-[#0E0E0E] border-t border-[#1E1E1E] flex items-center justify-between text-[11px] font-mono text-[#777777]">
          <span>Pressione <code className="text-white bg-[#1C1C1C] px-1.5 py-0.5 rounded">Alt + Space</code> para alternar</span>
          <span>Pressione <code className="text-white bg-[#1C1C1C] px-1.5 py-0.5 rounded">Esc</code> para fechar</span>
        </div>
      </div>
    </div>
  );
};
