// Runtime check: o laço de visão está processando frames? O canvas é atualizado?
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
  await page.waitForTimeout(2500);

  let snap = await ui.snapshot();
  await ui.click(snap.match(/@(e\d+) button "Ligar c[âa]mera"/)?.[1]);
  await page.waitForTimeout(3500);

  const sample = () => page.evaluate(() => {
    const host = document.querySelector('[data-testid=camera-preview]');
    const raw = host?.getAttribute('data-analysis') || sessionStorage.getItem('qa-analysis');
    let a = null; try { a = JSON.parse(raw); } catch { }
    if (a) sessionStorage.setItem('qa-analysis', JSON.stringify(a));
    const v = host?.querySelector('video');
    return { analysis: a ? { fg: a.fgPixels, minY: a.minY, boxW: a.boxW, boxH: a.boxH, thr: a.threshold, ready: a.readyState, canvasCenter: a.canvasCenter, corner: a.canvasCorner, bgCenter: a.bgCenter } : null, videoW: v?.videoWidth ?? 0, paused: v?.paused ?? null };
  });
  const first = await sample();
  await page.waitForTimeout(1200);
  const second = await sample();
  return { first, second, same: JSON.stringify(first) === JSON.stringify(second) };
}
