// Teste ponta a ponta: pergunta à LIORA pelo chat da Home e verifica a resposta real.
export default async function run(page) {
  const out = {};
  out.keys = await page.evaluate(async () => {
    const r = await fetch('/api/env/keys/status', { headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : { status: r.status };
  });

  const t0 = Date.now();
  const input = page.locator('#home-prompt-input');
  await input.fill('Responda apenas com a palavra: PRONTA');
  await input.press('Enter');

  // A resposta chega via SSE e aparece na aba Conversa; espera o orb sair de THINKING.
  await page.waitForTimeout(12000);
  out.elapsedMs = Date.now() - t0;
  out.bodySnippet = (await page.locator('body').innerText()).slice(0, 900);

  await page.getByRole('button', { name: /Conversa/i }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  out.conversationSnippet = (await page.locator('body').innerText()).slice(0, 1200);
  await page.screenshot({ path: 'liora-chat.png' });
  return out;
}
