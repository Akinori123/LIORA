// Observa setLayout: intercepta o React state via localStorage writes.
export default async function run(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    setInterval(() => { ctx.fillStyle = 'rgb(70,70,75)'; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = 'rgb(205,160,135)'; ctx.fillRect(120, 90, 80, 70); }, 50);
    const stream = canvas.captureStream(20);
    navigator.mediaDevices.enumerateDevices = async () => ([{ kind: 'videoinput', deviceId: 'fake-cam', label: 'Cam', groupId: 'g1' }]);
    navigator.mediaDevices.getUserMedia = async () => stream;
    // rastreia escritas no localStorage do layout
    window.__layoutWrites = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'liora_camera_preview_layout_v1') window.__layoutWrites.push(v);
      return original.call(this, k, v);
    };
  });
  await page.reload();
  await page.waitForTimeout(1500);
  const t = page.locator('button[aria-label="Ligar câmera"]');
  if (await t.count()) await t.first().click();
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => document.querySelector('[data-testid="camera-preview"] [role="separator"]').getBoundingClientRect().toJSON());
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(r.x + r.width / 2 + i * 18, r.y + r.height / 2 + i * 8);
  await page.mouse.up();
  await page.waitForTimeout(400);

  return page.evaluate(() => ({
    writes: window.__layoutWrites.slice(-5),
    width: Math.round(document.querySelector('[data-testid="camera-preview"]').getBoundingClientRect().width),
    styleLeft: document.querySelector('[data-testid="camera-preview"]').style.width
  }));
}
