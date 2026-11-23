import { toolRegistry } from '../src/tools/registry';
import { installNativeServerTools } from '../src/tools/nativeServerTools';

installNativeServerTools(toolRegistry);
const forget = await toolRegistry.executeTool('memory_forget', { query: 'projeto aurora' });
console.log('limpeza aurora:', forget.data?.removedCount, 'removidos | restam:', forget.data?.stillPresent);
