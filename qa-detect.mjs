// Por que "SEM MÃO" com a mão no quadro? Inspeciona o loop.
export default async function run(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    setInterval(() => {
      ctx.fillStyle = 'rgb(70,70,75)';
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = 'rgb(205,160,135)';
      ctx.fillRect(120, 90, 80, 70);
    }, 50);
    const stream = canvas.captureStream(20);
    navigator.mediaDevices.enumerateDevices = async () => ([{ kind: 'videoinput', deviceId: 'fake-cam', label: 'Cam', groupId: 'g1' }]);
    navigator.mediaDevices.getUserMedia = async () => stream;
  });
  await page.reload();
  await page.waitForTimeout(1500);
  const t = page.locator('button[aria-label="Ligar câmera"]');
  if (await t.count()) await t.first().click();
  await page.waitForTimeout(2500);

  return page.evaluate(() => {
    const s = window.__LIORA_GESTURE__;
    const st = s ? s.getState() : null;
    const d = s ? s.getDiagnostics() : null;
    // Verifica se o vÍdeo da prévia tem pixels da "mão"
    const v = document.querySelector('[data-testid="camera-preview"] video');
    let center = null, corner = null;
    if (v && v.videoWidth) {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const x = c.getContext('2d');
      x.drawImage(v, 0, 0, 160, 120);
      const data = x.getImageData(0, 0, 160, 120).data;
      const px = (a, b) => { const i = (b * 160 + a) * 4; return [data[i], data[i + 1], data[i + 2]]; };
      corner = px(5, 5);
      center = px(80, 60);
    }
    return {
      isRunning: st?.isActive,
      isStarting: st?.isStarting,
      handDetected: st?.handDetected,
      error: st?.error,
      diag: d,
      center,
      corner,
      pointerVisible: s?.pointerVisible
    };
  });
}
