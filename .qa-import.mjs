// Runtime: o módulo do serviço de gestos chega a executar no navegador?
export default async function run(page, ui) {
  const out = { errors: [] };
  page.on('pageerror', (e) => out.errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(m.text().slice(0, 300)); });
  await page.waitForTimeout(2000);

  out.importResult = await page.evaluate(async () => {
    try {
      const mod = await import('/src/services/gestureService.ts');
      const svc = mod.gestureService || mod.default;
      return { ok: true, hasService: Boolean(svc), state: svc ? svc.getState() : null, global: Boolean(globalThis.__LIORA_GESTURE__) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });
  out.text = (await page.evaluate(() => document.body.innerText)).slice(0, 300);
  return out;
}
