// Afinação final: alternar "Inverter" e ver se o cursor/box acompanham a mão.
export default async function run(page, ui) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    window.__HAND_X__ = 180;
    const tick = () => {
      ctx.fillStyle = '#204060';
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#e0b090';
      ctx.fillRect(window.__HAND_X__ - 80, 180, 160, 120);
      requestAnimationFrame(tick);
    };
    tick();
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
  });
  await page.reload();
  await page.waitForTimeout(2500);

  let snap = await ui.snapshot();
  await ui.click(snap.match(/@(e\d+) button "Ligar c[âa]mera"/)?.[1]);
  await page.waitForTimeout(3000);
  snap = await ui.snapshot();
  await ui.click(snap.match(/@(e\d+) button "Alternar controle do mouse por gestos"/)?.[1]);
  await page.waitForTimeout(2500);

  const read = (label) => page.evaluate((label) => {
    const p = document.querySelector('[data-testid=virtual-hand-pointer]');
    const b = document.querySelector('[data-testid=virtual-hand-box]');
    return {
      label,
      pointerLeft: p ? Math.round(p.getBoundingClientRect().left) : null,
      box: b ? { left: b.style.left, top: b.style.top, w: b.style.width, h: b.style.height, opacity: b.style.opacity } : null
    };
  }, label);

  const out = {};
  out.left = await read('hand-left');
  snap = await ui.snapshot();
  const invertBtn = snap.match(/@(e\d+) button "Inverter eixo X"/)?.[1];
  out.invertBtn = invertBtn || null;
  await ui.click(invertBtn);
  await page.waitForTimeout(2200);
  out.leftInverted = await read('hand-left-inverted');

  await page.screenshot({ path: 'qa-final2.png' });
  return out;
}
