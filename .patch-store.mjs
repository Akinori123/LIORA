import fs from 'fs';
const p = 'src/store/lioraStore.ts';
let s = fs.readFileSync(p, 'utf8');

const anchor = 'export const useLioraStore = create<LioraState>((set, get) => ({';
if (!s.includes(anchor)) {
  console.error('ANCHOR_MISSING');
  process.exit(1);
}
if (s.includes('__LIORA_STORE__')) {
  console.log('ALREADY_PATCHED');
  process.exit(0);
}

// Expõe a store para módulos determinísticos (vocativo de consentimento, tools
// que precisam ler a memória fora do React). Leitura apenas — sem side effects.
const patch = `
// Registro de diagnóstico/leitura para módulos fora do React (ex.: o vocativo
// das falas de consentimento precisa do nome preferido guardado na memória).
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__LIORA_STORE__ = useLioraStore;
}
`;

s = s.replace(anchor, anchor + patch);
fs.writeFileSync(p, s, 'utf8');
console.log('PATCHED');
