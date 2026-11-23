// Runtime: o serviço de gestos está registrado e ativo no navegador?
export default async function run(page, ui) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    window.__HAND_X__ = 60;
    const tick = () => {
      ctx.fillStyle = '#204060';
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#e0b090';
      ctx.fillRect(window.__HAND_X__ - 30, 90, 60, 60);
      requestAnimationFrame(tick);
    };
    tick();
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
  });
  await page.reload();
  await page.waitForTimeout(2200);
  const snap = await ui.snapshot();
  const cam = snap.match(/@(e\d+) button "Ligar c[âa]mera"/)?.[1];
  await ui.click(cam);
  await page.waitForTimeout(3000);
  const out = {};
  out.registry = await page.evaluate(() => {
    const s = globalThis.__LIORA_GESTURE__;
    return s ? { found: true, active: s.getState().isActive, err: s.getState().error } : { found: false };
  });
  out.diag = await page.evaluate(() => globalThis.__LIORA_GESTURE__?.getDiagnostics?.() ?? null);
  out.analysis = await page.evaluate(() => globalThis.__LIORA_GESTURE__?.getLastAnalysis?.() ?? null);
  await page.waitForTimeout(1200);
  out.analysis2 = await page.evaluate(() => globalThis.__LIORA_GESTURE__?.getLastAnalysis?.() ?? null);
  out.storageFlag = await page.evaluate(() => localStorage.getItem('liora_global_settings_v1'));
  return out;
}
