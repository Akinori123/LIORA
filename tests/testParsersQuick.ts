import { parseNavigationIntent } from '../src/utils/navigationParser.js';
import { parsePcCommandIntent, PcAppMatch } from '../src/utils/pcCommandParser.js';

const testPhrases = [
  'abra o bloco de notas',
  'abrir o bloco de notas',
  'abre o bloco de notas',
  'liora abra o bloco de notas',
  'por favor abra o bloco de notas',
  'abra o bloco de notas por favor',
  'abre bloco de notas',
  'bloco de notas',
  'abra o notepad',
  'abra o google',
  'abrir google',
  'abre o google',
  'liora abre o google',
  'abra as configurações',
  'abra o painel de controle'
];

for (const phrase of testPhrases) {
  const pc = parsePcCommandIntent(phrase) as PcAppMatch | null;
  const nav = parseNavigationIntent(phrase);
  console.log(`"${phrase}" => PC: ${pc?.executable || 'null'} | NAV: ${nav?.tab || 'null'}`);
}
