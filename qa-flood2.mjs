// Conta updateSettings e logs de atividade ao ligar a câmera.
export default async function run(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    setInterval(() => {
      ctx.fillStyle = 'rgb(70,70,75)'; ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = 'rgb(205,160,135)'; ctx.fillRect(120, 90, 80, 70);
    }, 50);
    const stream = canvas.captureStream(20);
    navigator.mediaDevices.enumerateDevices = async () => ([{ kind: 'videoinput', deviceId: 'fake-cam', label: 'Cam', groupId: 'g1' }]);
    navigator.mediaDevices.getUserMedia = async () => stream;
    try { localStorage.removeItem('liora_global_settings_v1'); } catch { }

    // Conta escritas em QUALQUER chave "liora_*"
    window.__writes = {};
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      window.__writes[k] = (window.__writes[k] || 0) + 1;
      return original.call(this, k, v);
    };
  });

  await page.reload();
  await page.waitForSelector('button[aria-label="Ligar câmera"]', { timeout: 45000 });
  await page.waitForTimeout(1500);

  const reset = () => page.evaluate(() => { window.__writes = {}; });
  await reset();

  await page.click('button[aria-label="Ligar câmera"]');
  await page.waitForTimeout(5000);

  const afterOn = await page.evaluate(() => ({ ...window.__writes }));
  await reset();

  // Deixa rodando 10s sem interação
  await page.waitForTimeout(10000);
  const idle = await page.evaluate(() => ({ ...window.__writes }));

  return { afterOn, idle };
}
