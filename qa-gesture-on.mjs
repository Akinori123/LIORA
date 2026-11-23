// QA: liga a Visão Computacional (sem webcam real no headless) e verifica o HUD.
export default async function run(page, ui) {
  const errors = [];
  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));

  await page.waitForTimeout(2000);

  // Liga a câmera pelo cabeçalho da Home (botão "Câmera")
  const snapshot = await ui.snapshot();
  const cameraBtn = snapshot.match(/@(e\d+) button "Alternar Câmera e Visão Computacional"/)?.[1];
  if (!cameraBtn) return { error: 'botão de câmera não encontrado', snapshot };

  await ui.click(cameraBtn);
  await page.waitForTimeout(2500);

  const after = await page.evaluate(() => {
    const badgeTexts = Array.from(document.querySelectorAll('div, span'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t.length > 0 && t.length < 120);
    const badge = Array.from(document.querySelectorAll('div')).find(
      (d) => typeof d.className === 'string' && d.className.includes('bottom-40')
    );
    const rect = badge ? badge.getBoundingClientRect() : null;
    // Elementos que o badge está cobrindo (se houver sobreposição)
    const covering = rect
      ? Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
        })
        .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40))
      : [];
    return {
      badge: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) } : null,
      covering,
      texts: badgeTexts.filter((t) => /Câmera|Tentar|Direto|Desativar|Mão|Aguardando/.test(t)).slice(0, 12),
      triedStart: true,
    };
  });

  return { after, errors: errors.slice(0, 8), warnings: warnings.filter((w) => /ScriptProcessor|deprecat/i.test(w)).slice(0, 5) };
}
