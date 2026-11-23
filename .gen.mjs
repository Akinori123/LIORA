import fs from 'node:fs';
const src = fs.readFileSync('src/tools/pcControlTools.ts', 'utf8');
const start = src.indexOf('export const pcInspectAppUiTool');
const seg = src.slice(start);
const m = seg.match(/const ps = `([\s\S]*?)`;\n\n    const res = await runFile/);
if (!m) { console.log('NAO_ACHOU'); process.exit(1); }
const ps = m[1]
  .split('${pidArg}').join('0')
  .split('${safeTarget}').join('notepad')
  .split('${includeHidden}').join('$false');
fs.writeFileSync('.gen-inspect.ps1', ps, 'utf8');
console.log('gerado:', ps.length, 'chars');
