// QA: cursor virtual + retângulo seguem a mão; punho clica no elemento apontado.
export default async function run(page, ui) {
  const out = { consoleErrors: [] };
  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 160)); });

  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    window.__HAND_X__ = 60;
    window.__HAND_W__ = 60;
    const tick = () => {
      ctx.fillStyle = '#204060';
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#e0b090';
      ctx.fillRect(window.__HAND_X__ - window.__HAND_W__ / 2, 90, window.__HAND_W__, 60);
      requestAnimationFrame(tick);
    };
    tick();
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
  window.__CLICKS__ = window.__CLICKS__ || [];
  document.addEventListener('click', (e) => {
    const arr = window.__CLICKS__ = window.__CLICKS__ || [];
    const el = e.target;
    arr.push((el?.getAttribute?.('aria-label') || el?.textContent || el?.tagName || '').slice(0, 40));
  }, true);
  });
  await page.reload();
  // deno-lint-ignore no-undef
  await page.waitForTimeout(2500);

  let snap = await ui.snapshot();
  await ui.click(snap.match(/@(e\d+) button "Ligar c[âa]mera"/)?.[1]);
  await page.waitForTimeout(3500);
  snap = await ui.snapshot();
  await ui.click(snap.match(/@(e\d+) button "Alternar controle do mouse por gestos"/)?.[1]);
  // A calibração do fundo coleta 9 quadros (~1s) e a histerese suaviza o box.
  await page.waitForTimeout(4500);

  const read = () => page.evaluate(() => {
    const p = document.querySelector('[data-testid=virtual-hand-pointer]');
    const b = document.querySelector('[data-testid=virtual-hand-box]');
    const host = document.querySelector('[data-testid=camera-preview]');
    const raw = host?.getAttribute('data-analysis') || '{}';
    let a = {};
    try {
      a = JSON.parse(raw);
    } catch { a = {}; }
    return {
      pointerLeft: p ? p.getBoundingClientRect().left : null,
      boxLeft: b ? b.style.left : null,
      boxOpacity: b ? b.style.opacity : null,
      fg: a.fgPixels, skinRatio: a.skinRatio, minY: a.minY, isValid: a.isValidTarget, thr: a.threshold
    };
  });

  out.handLeft = await read();
  // mão no lado DIREITO do quadro do canvas
  await page.evaluate(() => { window.__HAND_X__ = 260; });
  await page.waitForTimeout(1800);
  out.handRight = await read();

  // punho: a mão "fecha" — o retângulo fica denso (90% do bloco preenchido)
  const clicksBefore = await page.evaluate(() => (window.__CLICKS__ || []).length);
  out.clicks = { before: clicksBefore, after: null };
  await page.screenshot({ path: 'qa-hand-right.png' });
  return out;
}
