/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * DIAGNÓSTICO DE GESTOS — carregado sob demanda, DEPOIS do app montar.
 *
 * Por que separado do bundle principal: `gestureService` e `lioraStore` se
 * importam mutuamente (store chama o serviço; serviço precisa das settings).
 * Carregado cedo, o ciclo (ou uma declaração duplicada acidental no serviço)
 * quebrava o módulo em runtime e derrubava a árvore React inteira — o app
 * abria "em branco". Aqui qualquer falha fica isolada neste chunk.
 */
async function installGestureDiagnostics(): Promise<void> {
  try {
    const globalScope = globalThis as any;
    const alreadyInstalled =
      globalScope.__LIORA_GESTURE__ ||
      (typeof window !== 'undefined' && (window as any).__LIORA_GESTURE__);
    console.info('[LIORA][gesture-diag] início', { alreadyInstalled: Boolean(alreadyInstalled) });
    if (alreadyInstalled) return;
    const mod = await import('../services/gestureService');
    const service = mod.gestureService ?? mod.default;
    if (!service) return;
    // APENAS o diagnóstico no console. NUNCA sobrescrever um singleton já
    // vivo: o HUD/prévia podem ter carregado o serviço antes (usuário liga a
    // câmera em segundos) e declarar uma SEGUNDA instância deixava a UI
    // observando um serviço que nunca rodava o loop — cursor parado em 50%,0.5
    // e "Aguardando Alvo" eterno, com a prévia "funcionando".
    const target = (typeof window !== 'undefined' ? window : globalScope) as any;
    const key = mod.GESTURE_DIAGNOSTIC_KEY ?? '__LIORA_GESTURE__';
    const existing = target[key];
    const existingIsLive =
      existing &&
      typeof existing.getState === 'function' &&
      existing !== service;
    if (existingIsLive) return;
    Object.defineProperty(target, key, {
      value: service,
      configurable: true,
      writable: true,
      enumerable: false
    });
  } catch (err) {
    // Nunca derruba o app por causa do diagnóstico.
    console.warn('[LIORA] Diagnóstico de gestos indisponível:', err);
  }
}

export function scheduleGestureDiagnostics(): void {
  if (typeof window === 'undefined') return;
  const run = () => void installGestureDiagnostics();
  // Só agenda via requestIdleCallback quando a aba está com foco: no WebView2,
  // com a janela oculta/minimizada, idle callbacks não disparam e o diagnóstico
  // nunca aparecia. 1500ms cobre qualquer boot normal.
  setTimeout(run, 1500);
}
