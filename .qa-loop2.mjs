// Runtime check: o serviço está ativo e o laço de visão processa frames?
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
  const cam = snap.match(/@(e\d+) button "Ligar c[âa]mera"/)?.[1];
  const out = { camBtnFound: Boolean(cam) };
  if (!cam) return { ...out, snap: snap.slice(0, 1500) };
  await ui.click(cam);
  await page.waitForTimeout(4000);

  const probe = () => page.evaluate(() => ({
    diag: window.__LIORA_GESTURE__?.getDiagnostics?.(),
    analysis: window.__LIORA_GESTURE__?.getLastAnalysis?.()
  }));
  const a = await probe();
  await page.waitForTimeout(1200);
  const b = await probe();
  out.a = a;
  out.b = b;
  out.stillRunning = JSON.stringify(a.analysis) !== JSON.stringify(b.analysis);
  out.storageFlag = await page.evaluate(() => localStorage.getItem('liora_global_settings_v1'));
  return out;
}
