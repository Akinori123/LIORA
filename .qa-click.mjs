// Runtime: clique no botão da câmera e observe o serviço (mesma instância da UI).
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
    navigator.mediaDevices.getUserMedia = async () => {
      window.__CAM_CALLS__ = (window.__CAM_CALLS__ || 0) + 1;
      return canvas.captureStream(30);
    };
  });
  await page.reload();
  await page.waitForTimeout(2500);

  const get = () => page.evaluate(() => {
    const s = globalThis.__LIORA_GESTURE__;
    if (!s) return { svc: false, camCalls: window.__CAM_CALLS__ || 0, preview: Boolean(document.querySelector('[data-testid=camera-preview]')) };
    return {
      svc: true,
      active: s.getState().isActive,
      err: s.getState().error,
      camCalls: window.__CAM_CALLS__ || 0,
      diag: s.getDiagnostics(),
      analysis: s.getLastAnalysis(),
      preview: Boolean(document.querySelector('[data-testid=camera-preview]'))
    };
  });

  let snap = await ui.snapshot();
  const before = await get();
  const cam = snap.match(/@(e\d+) button "Ligar c[âa]mera"/)?.[1];
  await ui.click(cam);
  await page.waitForTimeout(2000);
  await ui.snapshot();
  const mid = await get();
  await page.waitForTimeout(2500);
  const after = await get();
  return { before, mid, after, loopAdvanced: JSON.stringify(mid.analysis) !== JSON.stringify(after.analysis) };
}
