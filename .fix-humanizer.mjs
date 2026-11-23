import fs from 'fs';
const p = 'src/utils/toolHumanizer.ts';
let s = fs.readFileSync(p, 'utf8');
const before = (s.match(/Mestre, /g) || []).length;
s = s.split('Mestre, ').join('{ADDRESS}, ');
fs.writeFileSync(p, s, 'utf8');
console.log('antes:', before, '| restantes:', (s.match(/Mestre, /g) || []).length, '| placeholders:', s.split('{ADDRESS}, ').length - 1);
