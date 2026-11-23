// Por que o serviço de gestos não existe no escopo global (e a câmera não abre)?
export default async function run(page, ui) {
  const out = { errors: [], warn: [] };
  page.on('pageerror', (e) => out.errors.push(String(e).slice(0, 400)));
  page.on('console', (m) => {
    if (m.type() === 'error') out.errors.push(m.text().slice(0, 300));
    if (m.type() === 'warning' || m.type() === 'warn' || m.type() === 'info') out.warn.push(m.text().slice(0, 300));
  });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.__TAURI__ = {}; });
  out.globals = await page.evaluate(() => ({
    gesture: typeof globalThis.__LIORA_GESTURE__,
    tauri: typeof window.__TAURI__,
    ls: (localStorage.getItem('liora_global_settings_v1') || '').slice(0, 200)
  }));
  // remonta a UI recarregando e esperando o diagnóstico
  await page.reload();
  await page.waitForTimeout(4000);
  out.afterReload = await page.evaluate(() => ({ gesture: typeof globalThis.__LIORA_GESTURE__ }));
  out.text = (await page.evaluate(() => document.body.innerText)).slice(0, 200);
  return out;
}
