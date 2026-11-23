import { toolRegistry } from '../src/tools/registry.ts';
import { installNativeServerTools } from '../src/tools/nativeServerTools.ts';

installNativeServerTools(toolRegistry);

const probes: Array<[string, any]> = [
  ['system_info', {}],
  ['getSystemStatus', {}],
  ['system_read_env_safe', { variableName: 'NODE_ENV' }],
  ['memory_list_context', {}],
  ['memory_store_fact', { category: 'fact', key: 'probe', value: 'x' }],
  ['memory_semantic_search', { query: 'probe' }],
  ['list_processes', {}],
  ['workspace_search_files', { query: 'a' }],
  ['calculate_route', { destination: 'Curitiba' }],
  ['fetchNews', { topic: 'tecnologia' }]
];

for (const [name, params] of probes) {
  if (!toolRegistry.hasTool(name)) { console.log(`${name}: NAO_REGISTRADA`); continue; }
  const res = await toolRegistry.executeTool(name, params, { skipDedupe: true } as any);
  const bad = /Violação do contrato/.test(String(res.error || ''));
  console.log(`${name}: success=${res.success}${bad ? ` | CONTRATO: ${res.error}` : ''}${!res.success && !bad ? ` | erro: ${String(res.error).slice(0, 90)}` : ''}`);
}
