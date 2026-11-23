// O módulo de gestos executa? Se sim, o serviço registra em window?
export default async function run(page, ui) {
  const out = {};
  await page.waitForTimeout(2000);
  out.mod = await page.evaluate(async () => {
    try {
      const m = await import('/src/services/gestureService.ts');
      const svc = m.gestureService || m.default;
      return {
        hasService: Boolean(svc),
        isActive: svc ? svc.getState().isActive : null,
        keys: Object.keys(m).slice(0, 12),
        winReg: typeof window.__LIORA_GESTURE__,
        globReg: typeof globalThis.__LIORA_GESTURE__,
        sameGlobal: globalThis.__LIORA_GESTURE__ === svc
      };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });
  return out;
}
