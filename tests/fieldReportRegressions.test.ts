/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regressões do RELATO DE CAMPO (uso real pelo usuário). Cada teste corresponde
 * a um sintoma observado na interface:
 *  - "esqueça o projeto Aurora" não apagava nada (ferramenta inexistente);
 *  - falas de consentimento diziam "Mestre" mesmo com nome preferido salvo;
 *  - após autorizar, ela não falava o resultado (só "autorização confirmada");
 *  - respondia a vídeos/TV porque o microfone era loop aberto (sem wake word).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';

test('FIELD-MEM-01: existe ferramenta de EXCLUSÃO de memória (memory_forget)', async () => {
  const { toolRegistry } = await import('../src/tools/registry');
  const { installNativeServerTools } = await import('../src/tools/nativeServerTools');
  installNativeServerTools(toolRegistry);

  assert.ok(toolRegistry.hasTool('memory_forget'), 'memory_forget não está registrada');
  const tool = toolRegistry.getTool('memory_forget')!;
  assert.equal(tool.riskLevel, 'R1', 'exclusão de memória precisa exigir consentimento R1');
  assert.match(tool.description, /esqueç|apague|exclu/i);
});

test('FIELD-MEM-02: memory_store_fact é declarada ao modelo (perfil) e ao catálogo', async () => {
  const { STRICT_PROFILE } = await import('../src/security/profiles');
  assert.ok(STRICT_PROFILE.allowedTools.includes('memory_store_fact'), 'store fora do perfil');
  assert.ok(STRICT_PROFILE.allowedTools.includes('memory_forget'), 'forget fora do perfil');
});

test('FIELD-MEM-03: memory_forget valida query vazia sem quebrar', async () => {
  const { nativeMemoryForgetTool } = await import('../src/tools/nativeServerTools');
  const res = await nativeMemoryForgetTool.execute({ query: '   ' } as any);
  assert.equal(res.success, false);
  assert.match(String(res.error), /MISSING_QUERY/);
});

test('FIELD-MEM-04: dryRun lista o que seria removido e não apaga', async () => {
  const { nativeMemoryForgetTool } = await import('../src/tools/nativeServerTools');
  const res = await nativeMemoryForgetTool.execute({ query: 'termo-inexistente-xyz', dryRun: true } as any);
  assert.equal(res.success, true, res.error);
  assert.equal(res.dryRun, true);
  assert.equal(res.removedCount, 0);
  assert.ok(Array.isArray(res.wouldRemove));
});

test('FIELD-NAME-01: vocativo de consentimento usa o nome preferido, não "Mestre" fixo', async () => {
  const humanizer = fs.readFileSync(path.join(SRC, 'utils/toolHumanizer.ts'), 'utf8');
  assert.doesNotMatch(humanizer, /spokenPrompt:\s*`Mestre,/, 'ainda há "Mestre" hardcoded nas falas');
  assert.match(humanizer, /\{ADDRESS\}/, 'falas devem usar o marcador de vocativo');
  assert.match(humanizer, /resolvePreferredAddress/);
});

test('FIELD-NAME-02: resolveUserAddress extrai "Senhor" de uma memória de preferência', async () => {
  const { resolveUserAddress } = await import('../src/store/lioraStore');
  assert.equal(
    resolveUserAddress([{ key: 'nome', value: 'Senhor' }]),
    'Senhor'
  );
  assert.equal(
    resolveUserAddress([{ key: 'tratamento', value: 'de agora em diante me chame de Chefe' }]),
    'Chefe'
  );
  assert.equal(resolveUserAddress([]), 'Mestre', 'fallback deve ser Mestre');
});

test('FIELD-SPEAK-01: resultado de ferramenta é falado com dados REAIS', async () => {
  const { buildSpokenToolOutcome } = await import('../src/store/lioraStore');

  const exec = buildSpokenToolOutcome(
    'system_exec_sandbox',
    { data: { stdout: 'v22.14.0', stderr: '', exitCode: 0 } },
    'Senhor'
  );
  assert.match(exec, /v22\.14\.0/, 'a saída do comando precisa ser falada');
  assert.match(exec, /^Senhor,/, 'deve usar o vocativo correto');
  assert.doesNotMatch(exec, /confirmada e executada\.?$/, 'não pode ser só a confirmação');

  const proc = buildSpokenToolOutcome(
    'list_processes',
    { data: { processes: [{ name: 'chrome', cpuPercent: 12 }, { name: 'node', cpuPercent: 4 }] } },
    'Mestre'
  );
  assert.match(proc, /2 processos/);
  assert.match(proc, /chrome/);

  const cal = buildSpokenToolOutcome('calendar_list_events', { data: { events: [] } }, 'Mestre');
  assert.match(cal, /nenhum compromisso/);
});

test('FIELD-VOICE-01: existe gate de atenção (wake word) contra TV/vídeos', () => {
  const client = fs.readFileSync(path.join(SRC, 'services/voiceLiveClient.ts'), 'utf8');
  assert.match(client, /WAKE_WORD_REGEX/);
  assert.match(client, /primeAttention\(/);
  assert.match(client, /feedUserTranscript\(/);
  assert.match(client, /if \(!this\.attentionActive\)/, 'o envio de áudio precisa ser gated');
  const bar = fs.readFileSync(path.join(SRC, 'components/GlobalVoiceBar.tsx'), 'utf8');
  assert.match(bar, /primeAttention\(\)/, 'ligar o mic deve ativar a atenção');
  assert.match(bar, /feedUserTranscript\(text\)/, 'a transcrição precisa alimentar o gate');
});

test('FIELD-VOICE-02: reconhece o nome e ignora fala aleatória', async () => {
  const { voiceLiveClient } = await import('../src/services/voiceLiveClient');
  assert.equal(voiceLiveClient.isWakeWordHeard('Liora, que horas são?'), true);
  assert.equal(voiceLiveClient.isWakeWordHeard('oi liora'), true);
  assert.equal(voiceLiveClient.isWakeWordHeard('esse vídeo é muito bom galera'), false);
  assert.equal(voiceLiveClient.isWakeWordHeard('subscribe no canal'), false);
});

test('FIELD-DUAL-01: fala determinística silencia o Live (sem duas vozes)', () => {
  const speech = fs.readFileSync(path.join(SRC, 'services/speechService.ts'), 'utf8');
  assert.match(speech, /suppressLiveFor\(/, 'fala determinística precisa suprimir o canal Live');
  const gate = fs.readFileSync(path.join(SRC, 'services/audioGate.ts'), 'utf8');
  assert.match(gate, /suppressLiveFor\(ms/);
});

test('FIELD-PROMPT-01: prompt do sistema ensina esquecer, nome preferido e tela x câmera', async () => {
  const store = fs.readFileSync(path.join(SRC, 'store/lioraStore.ts'), 'utf8');
  assert.match(store, /memory_forget/, 'instrução de exclusão ausente');
  assert.match(store, /me chame de X/i, 'instrução de nome preferido ausente');
  assert.match(store, /pc_take_screenshot/, 'instrução de captura de tela ausente');
  assert.match(store, /camera_inspect_object/, 'instrução da câmera ausente');
  assert.match(store, /NUNCA confunda uma com a outra/, 'distinção tela/câmera ausente');
});
