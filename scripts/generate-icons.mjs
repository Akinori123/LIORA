/**
 * Gera os ícones da LIORA (identidade: núcleo branco sobre esfera vermelha em
 * fundo preto — mesmo visual do Orbe) como PNGs em todas as resoluções exigidas
 * pelo tauri.conf.json + favicon para o frontend.
 *
 * Execução: node scripts/generate-icons.mjs
 * Depende apenas de Node puro (sem canvas): escreve PNGs manualmente via
 * encode manual de scanlines — simples, determinístico e sem dependências.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** Encode um RGBA buffer cru como PNG (sem dependências) */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([typeBuf, data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of crcBuf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc);
    return Buffer.concat([len, typeBuf, data, crcB]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Scanlines com filtro 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Desenha o símbolo da LIORA num buffer RGBA de width x height.
 * CORREÇÃO (ícone "bloco preto" na taskbar): o design anterior tinha a esfera
 * pequena (42% do canvas) sobre fundo #050505 quase preto — em 32x32 a esfera
 * sumia e sobrava só o fundo escuro. Novo design: esfera GRANDE (94% do canvas)
 * vermelho saturado com brilho, núcleo branco e FUNDO TRANSPARENTE (padrão de
 * ícones de aplicativo — legível em qualquer tamanho e sobre qualquer fundo).
 */
function drawLioraIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.47;       // esfera ocupa 94% do canvas
  const coreR = size * 0.20;   // núcleo branco proporcional

  const setPx = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= coreR) {
        // Núcleo branco brilhante (centro identidade)
        setPx(x, y, 255, 255, 255, 255);
      } else if (dist <= R) {
        // Esfera vermelha LIORA (#FF2B2B) com sombreamento esférico:
        // highlight no topo-esquerda, bordas mais escuras (curvatura 3D)
        const nd = dist / R; // 0..1 do centro à borda
        const highlight = Math.max(0, 1 - (Math.sqrt((dx + R * 0.35) ** 2 + (dy + R * 0.35) ** 2) / (R * 1.1)));
        const lum = 0.55 + highlight * 0.45 - nd * nd * 0.25;
        const l = Math.max(0.4, Math.min(1.15, lum));
        const r = Math.min(255, Math.round(255 * l));
        const g = Math.round(43 * l);
        const b = Math.round(43 * l);
        // Anti-aliasing na borda da esfera (fundo transparente)
        const edge = Math.min(1, (R - dist) / 1.5);
        setPx(x, y, r, g, b, Math.round(255 * Math.max(0, edge)));
      }
      // fora da esfera: transparente (alpha 0 já inicializado)
    }
  }
  return rgba;
}

const targets = [
  { file: 'src-tauri/icons/32x32.png', size: 32 },
  { file: 'src-tauri/icons/128x128.png', size: 128 },
  { file: 'src-tauri/icons/128x128@2x.png', size: 256 },
  { file: 'public/liora-icon.png', size: 192 },
  { file: 'public/favicon.png', size: 64 }
];

for (const { file, size } of targets) {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, encodePng(size, size, drawLioraIcon(size)));
  console.log(`✓ ${file} (${size}x${size})`);
}

console.log('\nConcluído. O icon.icns (macOS) e o icon.ico permanecem — regenere com `npm run tauri icon` se precisar dos binários multi-resolução oficiais.');

// ============ Geração do icon.ico (Windows taskbar) ============
// Formato ICO que embute PNGs (suportado no Windows Vista+).
// Inclui 32x32 e 256x256 do mesmo símbolo LIORA.

function buildIco(entries) {
  // ICONDIR: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dirEntrySize = 16;
  const dataOffsets = [];
  let offset = 6 + dirEntrySize * entries.length;

  const dirEntries = entries.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size;  // width (0 = 256)
    e[1] = size === 256 ? 0 : size;  // height
    e[2] = 0;                        // palette
    e[3] = 0;                        // reserved
    e.writeUInt16LE(1, 4);           // color planes
    e.writeUInt16LE(32, 6);          // bpp
    e.writeUInt32LE(png.length, 8);  // data size
    e.writeUInt32LE(offset, 12);     // data offset
    dataOffsets.push(offset);
    offset += png.length;
    return e;
  });

  return Buffer.concat([header, ...dirEntries, ...entries.map(e => e.png)]);
}

const icoEntries = [32, 256].map(size => ({
  size,
  png: encodePng(size, size, drawLioraIcon(size))
}));

const icoPath = path.join(root, 'src-tauri', 'icons', 'icon.ico');
fs.writeFileSync(icoPath, buildIco(icoEntries));
console.log(`✓ src-tauri/icons/icon.ico (32+256, PNG-embedded)`);
