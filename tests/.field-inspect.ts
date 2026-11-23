import { toolRegistry } from '../src/tools/registry';
import { installNativeServerTools } from '../src/tools/nativeServerTools';
import { execSync } from 'node:child_process';

installNativeServerTools(toolRegistry);

execSync('powershell -NoProfile -Command "Start-Process notepad"', { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));

const res = await toolRegistry.executeTool('pc_inspect_app_ui', { target: 'notepad' });
console.log('success:', res.success);
console.log('mensagem:', res.data?.message);
console.log('janelas:', res.data?.count);
const w = res.data?.windows?.[0];
if (w) {
  console.log('titulo:', w.title, '| pid:', w.pid, '| rect:', JSON.stringify(w.rect));
  console.log('resumo:', JSON.stringify(w.summary));
  for (const c of (w.controls || []).slice(0, 8)) {
    console.log(`  [${c.index}] ${c.kind} cls=${c.className} text='${c.text}' vis=${c.visible}`);
  }
}

execSync('powershell -NoProfile -Command "Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue"', { stdio: 'ignore' });
