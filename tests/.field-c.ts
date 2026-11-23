import { toolRegistry } from '../src/tools/registry';
import { installNativeServerTools } from '../src/tools/nativeServerTools';
import { semanticMemoryService } from '../src/services/memory/semanticMemoryService';

installNativeServerTools(toolRegistry);

const store = await import('../src/store/lioraStore');
const useLioraStore = store.useLioraStore;

console.log('=== TESTE C1: gravar e esquecer da memória ===');
const before = useLioraStore.getState().memoryEntries.length;
console.log('memórias na store antes:', before);

const saved = await toolRegistry.executeTool('memory_store_fact', {
  category: 'project',
  key: 'projeto_aurora',
  value: 'O projeto Aurora é do Senhor e usa Rust'
});
console.log('store_fact success:', saved.success, '| data.success:', saved.data?.success);
console.log('memórias na store depois de gravar:', useLioraStore.getState().memoryEntries.length);
console.log('no serviço semântico:', semanticMemoryService.getAllMemories().length);

const dry = await toolRegistry.executeTool('memory_forget', { query: 'projeto aurora', dryRun: true });
console.log('dryRun removedCount:', dry.data?.removedCount, '| wouldRemove:', JSON.stringify(dry.data?.wouldRemove));

const forget = await toolRegistry.executeTool('memory_forget', { query: 'projeto aurora' });
console.log('forget success:', forget.success, '| data:', JSON.stringify(forget.data).slice(0, 300));
console.log('memórias na store após esquecer:', useLioraStore.getState().memoryEntries.length);
const stillThere = useLioraStore.getState().memoryEntries.filter((m: any) => /aurora/i.test(`${m.key} ${m.value}`));
console.log('ainda contém aurora na store:', stillThere.length);
console.log('ainda no serviço:', semanticMemoryService.getAllMemories().filter((m) => /aurora/i.test(`${m.key} ${m.value}`)).length);

console.log('\n=== TESTE C2: vocativo ===');
console.log('resolveUserAddress padrao:', store.resolveUserAddress([]));
console.log('resolveUserAddress Senhor:', store.resolveUserAddress([{ key: 'nome', value: 'Senhor' }]));

console.log('\n=== TESTE C3: fala de resultado ===');
console.log(store.buildSpokenToolOutcome('system_exec_sandbox', { data: { stdout: 'v22.14.0', stderr: '', exitCode: 0 } }, 'Senhor'));
console.log(store.buildSpokenToolOutcome('list_processes', { data: { processes: [{ name: 'chrome', cpuPercent: 12 }] } }, 'Senhor'));
