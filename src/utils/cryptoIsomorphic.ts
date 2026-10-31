/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilitários criptográficos isomórficos (compatíveis com Browser e Node.js)
 * Evita o erro de módulo 'crypto' externalizado pelo Vite no frontend.
 */

// Implementação pura de SHA-256 (FIPS 180-4) compatível com strings UTF-8
function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

export function sha256Sync(str: string): string {
  // UTF-8 encode
  const utf8: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      utf8.push(code);
    } else if (code < 0x800) {
      utf8.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      utf8.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      i++;
      code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      utf8.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }

  const bitLength = utf8.length * 8;
  utf8.push(0x80);
  while (utf8.length % 64 !== 56) {
    utf8.push(0);
  }

  for (let idx = 7; idx >= 0; idx--) {
    utf8.push(Math.floor(bitLength / Math.pow(256, idx)) & 0xff);
  }

  const hash: number[] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  for (let chunk = 0; chunk < utf8.length; chunk += 64) {
    const w: number[] = [];
    for (let t = 0; t < 16; t++) {
      w[t] =
        (utf8[chunk + t * 4] << 24) |
        (utf8[chunk + t * 4 + 1] << 16) |
        (utf8[chunk + t * 4 + 2] << 8) |
        utf8[chunk + t * 4 + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rightRotate(w[t - 15], 7) ^ rightRotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rightRotate(w[t - 2], 17) ^ rightRotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let t = 0; t < 64; t++) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[t] + w[t]) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = (hash[0] + a) | 0;
    hash[1] = (hash[1] + b) | 0;
    hash[2] = (hash[2] + c) | 0;
    hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0;
    hash[5] = (hash[5] + f) | 0;
    hash[6] = (hash[6] + g) | 0;
    hash[7] = (hash[7] + h) | 0;
  }

  let result = '';
  for (let idx = 0; idx < 8; idx++) {
    result += (hash[idx] >>> 0).toString(16).padStart(8, '0');
  }

  return result;
}

/**
 * Gera um UUID v4 de forma isomórfica (suporta browser e Node.js).
 */
export function generateUUID(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  // RFC4122 v4 compliant fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Gera bytes aleatórios em string hexadecimal.
 */
export function generateRandomHex(byteCount = 32): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const arr = new Uint8Array(byteCount);
    globalThis.crypto.getRandomValues(arr);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  let res = '';
  for (let i = 0; i < byteCount; i++) {
    res += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return res;
}

/**
 * Calcula HMAC SHA-256 determinístico de forma isomórfica (RFC 2104).
 */
export function computeHmacSha256Sync(secret: string, message: string): string {
  const blockSize = 64;
  let keyBytes: number[] = [];

  const secretUtf8: number[] = [];
  for (let i = 0; i < secret.length; i++) {
    secretUtf8.push(secret.charCodeAt(i) & 0xff);
  }

  if (secretUtf8.length > blockSize) {
    const hashed = sha256Sync(secret);
    for (let i = 0; i < hashed.length; i += 2) {
      keyBytes.push(parseInt(hashed.substr(i, 2), 16));
    }
  } else {
    keyBytes = [...secretUtf8];
  }

  while (keyBytes.length < blockSize) {
    keyBytes.push(0);
  }

  const oPad = keyBytes.map((b) => b ^ 0x5c);
  const iPad = keyBytes.map((b) => b ^ 0x36);

  const innerStr = String.fromCharCode(...iPad) + message;
  const innerHash = sha256Sync(innerStr);

  const innerHashBytes: number[] = [];
  for (let i = 0; i < innerHash.length; i += 2) {
    innerHashBytes.push(parseInt(innerHash.substr(i, 2), 16));
  }

  const outerStr = String.fromCharCode(...oPad) + String.fromCharCode(...innerHashBytes);
  return sha256Sync(outerStr);
}

