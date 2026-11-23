// Mede a barra global de voz e o badge de gestos para Eliminar sobreposição.
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
  await page.waitForTimeout(1600);
  const on = page.locator('button[aria-label="Ligar câmera"]');
  if (await on.count()) await on.first().click();
  await page.waitForTimeout(2500);

  // Liga o modo voz para a barra aparecer
  const mic = page.locator('button[aria-label*="microfone" i]').first();
  if (await mic.count()) { await mic.click({ force: true }).catch(() => { }); }
  await page.waitForTimeout(1500);

  return page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
    // Barra de voz global: contém texto "LIORA" e fica no rodapé
    const all = Array.from(document.querySelectorAll('div'));
    const voiceBar = all.find(d => /OUVINDO|Ouvindo/i.test(d.textContent || '') && d.getBoundingClientRect().width > 200 && d.getBoundingClientRect().width < 900);
    const badge = all.find(d => typeof d.className === 'string' && /bottom-\[2(56|96)px\]/.test(d.className));
    const preview = document.querySelector('[data-testid="camera-preview"]');
    return {
      vh: innerHeight,
      voiceBar: r(voiceBar),
      badge: r(badge),
      preview: r(preview),
      badgeClass: badge ? badge.className : null,
    };
  });
}
