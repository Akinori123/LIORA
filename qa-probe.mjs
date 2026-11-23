// Diagnóstico: valores reais do loop de rastreamento com câmera falsa.
export default async function run(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    let t = 0;
    setInterval(() => {
      t += 0.05;
      // fundo estável (cinza escuro) + mão fixa no centro (pele)
      ctx.fillStyle = 'rgb(70,70,75)';
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = 'rgb(205,160,135)';
      ctx.fillRect(120, 90, 80, 70);
    }, 50);
    const stream = canvas.captureStream(20);
    navigator.mediaDevices.enumerateDevices = async () => ([
      { kind: 'videoinput', deviceId: 'fake-cam', label: 'Câmera Falsa', groupId: 'g1' }
    ]);
    navigator.mediaDevices.getUserMedia = async () => stream;
  });

  await page.reload();
  await page.waitForTimeout(2000);
  const toggle = page.locator('button[aria-label="Ligar câmera"]');
  if (await toggle.count()) await toggle.first().click();
  await page.waitForTimeout(2500);

  // Amostra a canvas interna do serviço diretamente
  const probe = async () => page.evaluate(() => {
    // reaproveita o vídeo da prévia para desenhar num canvas e medir pixels
    const v = document.querySelector('[data-testid="camera-preview"] video');
    if (!v) return { error: 'sem vídeo' };
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    const x = c.getContext('2d');
    x.drawImage(v, 0, 0, 160, 120);
    const d = x.getImageData(0, 0, 160, 120).data;
    // centro (mão) e canto (fundo)
    const at = (px, py) => {
      const i = (py * 160 + px) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    return {
      corner: at(5, 5),
      center: at(80, 60),
      readyState: v.readyState,
      w: v.videoWidth,
      h: v.videoHeight,
      badge: (Array.from(document.querySelectorAll('span')).find(s => /Abrindo câmera|SEM MÃO|MÃO|Aguardando|Erro na câmera/.test(s.textContent || ''))?.textContent || '').trim(),
      pointer: Boolean(document.querySelector('[data-testid="virtual-hand-pointer"]')),
    };
  });

  const a = await probe();
  await page.waitForTimeout(1500);
  const b = await probe();
  return { a, b };
}
