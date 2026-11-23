// Instrumenta os eventos de ponteiro na alça de redimensionar.
export default async function run(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    setInterval(() => { ctx.fillStyle = 'rgb(70,70,75)'; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = 'rgb(205,160,135)'; ctx.fillRect(120, 90, 80, 70); }, 50);
    const stream = canvas.captureStream(20);
    navigator.mediaDevices.enumerateDevices = async () => ([{ kind: 'videoinput', deviceId: 'fake-cam', label: 'Cam', groupId: 'g1' }]);
    navigator.mediaDevices.getUserMedia = async () => stream;
  });
  await page.reload();
  await page.waitForTimeout(1500);
  const t = page.locator('button[aria-label="Ligar câmera"]');
  if (await t.count()) await t.first().click();
  await page.waitForTimeout(1500);

  // Conta eventos capturados na alça
  await page.evaluate(() => {
    window.__ev = { down: 0, move: 0, up: 0, captured: false };
    const h = document.querySelector('[data-testid="camera-preview"] [role="separator"]');
    if (!h) return;
    h.addEventListener('pointerdown', (e) => {
      window.__ev.down++;
      try { h.setPointerCapture(e.pointerId); window.__ev.captured = h.hasPointerCapture(e.pointerId); } catch (err) { window.__ev.captureErr = String(err); }
    }, true);
    h.addEventListener('pointermove', () => { window.__ev.move++; }, true);
    h.addEventListener('pointerup', () => { window.__ev.up++; }, true);
    window.__handleRect = h.getBoundingClientRect().toJSON();
  });

  const r = await page.evaluate(() => window.__handleRect);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(r.x + r.width / 2 + i * 18, r.y + r.height / 2 + i * 8);
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    ev: window.__ev,
    width: Math.round(document.querySelector('[data-testid="camera-preview"]').getBoundingClientRect().width),
    topAtHandle: (() => {
      const h = document.querySelector('[data-testid="camera-preview"] [role="separator"]').getBoundingClientRect();
      const el = document.elementFromPoint(h.x + h.width / 2, h.y + h.height / 2);
      return el ? el.tagName + '.' + (el.getAttribute('role') || '') : null;
    })()
  }));
  return after;
}
