// Mesmo fluxo do usuário, instrumentado de ponta a ponta.
export default async function run(page, ui) {
  const out = { logs: [], errors: [] };
  page.on('pageerror', (e) => out.errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(m.text().slice(0, 200)); });

  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const tick = () => {
      ctx.fillStyle = '#204060';
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#e0b090';
      ctx.fillRect(120, 90, 60, 60);
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

  const snap = await ui.snapshot();
  const cam = snap.match(/@(e\d+) button "Ligar c[âa]mera"/)?.[1];
  out.camRef = cam || null;
  if (!cam) return out;
  await ui.click(cam);

  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(800);
    out.logs.push(await page.evaluate(() => ({
      calls: window.__CAM_CALLS__ || 0,
      svc: Boolean(globalThis.__LIORA_GESTURE__),
      active: globalThis.__LIORA_GESTURE__?.getState?.().isActive ?? null,
      err: globalThis.__LIORA_GESTURE__?.getState?.().error ?? null,
      preview: Boolean(document.querySelector('[data-testid=camera-preview]')),
      cameraButtons: Array.from(document.querySelectorAll('button')).filter(b => /c[âa]mera/i.test(b.getAttribute('aria-label') || '')).map(b => b.getAttribute('aria-label'))
    })));
  }
  return out;
}
