import { pcInspectAppUiTool } from '../src/tools/pcControlTools';

// Intercepta o script gerado re-executando a montagem (mesma lógica da tool).
const original = pcInspectAppUiTool.execute;
const res = await original({ target: 'notepad' } as any);
console.log('RESULT:', JSON.stringify(res).slice(0, 400));
