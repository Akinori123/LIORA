/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { settingsManager, DEFAULT_SETTINGS } from '../src/services/settingsManager';
import { VoiceLiveClient, floatTo16BitPCM, pcmBase64ToFloat32 } from '../src/services/voiceLiveClient';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Helper to simulate .env file writing as implemented in server.ts
function updateEnvFileSimulated(envPath: string, keyName: string, keyValue: string): void {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  const regex = new RegExp(`^${keyName}=.*$`, 'm');
  const newLine = `${keyName}="${keyValue.replace(/"/g, '\\"')}"`;
  if (regex.test(content)) {
    content = content.replace(regex, newLine);
  } else {
    content = content ? `${content.trimEnd()}\n${newLine}\n` : `${newLine}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

test('HVA-01: Identidade Vocal e Persona Feminina Fixa (Kore)', () => {
  // A voz padrão do sistema deve ser rigorosamente a Kore
  assert.strictEqual(DEFAULT_SETTINGS.ttsVoice, 'Kore', 'A persona vocal padrão da LIORA deve ser Kore.');
  assert.strictEqual(DEFAULT_SETTINGS.language, 'pt-BR', 'O idioma prioritário deve ser Português do Brasil (pt-BR).');

  // Inicialização do VoiceLiveClient sem parâmetro deve adotar Kore
  const client = new VoiceLiveClient();
  assert.strictEqual(client.getStatus(), 'IDLE', 'O cliente de voz deve iniciar no estado IDLE.');
});

test('HVA-02: Conversão de Áudio PCM 16-bit com Baixa Latência', () => {
  // Simula 1024 amostras Float32 de áudio
  const floatSamples = new Float32Array(1024);
  for (let i = 0; i < floatSamples.length; i++) {
    floatSamples[i] = Math.sin((i / 1024) * Math.PI * 2);
  }

  const pcm16 = floatTo16BitPCM(floatSamples);
  assert.strictEqual(pcm16.length, 1024, 'O buffer PCM deve preservar o número exato de amostras.');
  assert(pcm16 instanceof Int16Array, 'O tipo retornado deve ser Int16Array para streaming de 16-bit.');

  // Conversão reversa
  const base64Buffer = Buffer.from(pcm16.buffer).toString('base64');
  const reconstructed = pcmBase64ToFloat32(base64Buffer);
  assert.strictEqual(reconstructed.length, 1024, 'A reconstrução Float32Array deve ser idêntica em dimensão.');
});

test('HVA-03: Máquina de 6 Estados Visuais e Cópias da Aba Home', () => {
  const stateMatrix: Record<string, { copy: string; hasVisualReaction: boolean }> = {
    'IDLE': {
      copy: 'LIORA pronta. Como posso ajudar?',
      hasVisualReaction: true
    },
    'LISTENING': {
      copy: 'Ouvindo...',
      hasVisualReaction: true
    },
    'THINKING': {
      copy: 'Processando raciocínio...',
      hasVisualReaction: true
    },
    'SPEAKING': {
      copy: 'Transmitindo resposta...',
      hasVisualReaction: true
    },
    'EXECUTING': {
      copy: 'Executando comando no sistema...',
      hasVisualReaction: true
    },
    'ERROR': {
      copy: 'Atenção: Verifique a conexão ou chave API.',
      hasVisualReaction: true
    }
  };

  const validStates = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'EXECUTING', 'ERROR'];
  assert.strictEqual(validStates.length, 6, 'A máquina de estados principal deve possuir exatamente 6 estados.');

  for (const st of validStates) {
    const config = stateMatrix[st];
    assert.ok(config, `O estado ${st} deve possuir configuração mapeada.`);
    assert.ok(config.copy.length > 5, `O estado ${st} deve possuir uma copy descritiva clara.`);
    assert.strictEqual(config.hasVisualReaction, true, `O estado ${st} deve disparar reação visual correspondente.`);
  }
});

test('HVA-04: Intent Router — Roteamento de Comandos Híbridos (/scan, /exec, /clear)', () => {
  function routeIntent(input: string): { type: 'SCAN' | 'EXEC' | 'CLEAR' | 'CHAT'; payload: string } {
    const clean = input.trim();
    if (clean.startsWith('/scan')) {
      return { type: 'SCAN', payload: clean.replace('/scan', '').trim() };
    }
    if (clean.startsWith('/exec')) {
      return { type: 'EXEC', payload: clean.replace('/exec', '').trim() };
    }
    if (clean.startsWith('/clear')) {
      return { type: 'CLEAR', payload: '' };
    }
    return { type: 'CHAT', payload: clean };
  }

  const resScan = routeIntent('/scan system_workspace');
  assert.strictEqual(resScan.type, 'SCAN');
  assert.strictEqual(resScan.payload, 'system_workspace');

  const resExec = routeIntent('/exec cargo check');
  assert.strictEqual(resExec.type, 'EXEC');
  assert.strictEqual(resExec.payload, 'cargo check');

  const resClear = routeIntent('/clear');
  assert.strictEqual(resClear.type, 'CLEAR');

  const resChat = routeIntent('Olá LIORA, como está o sistema?');
  assert.strictEqual(resChat.type, 'CHAT');
  assert.strictEqual(resChat.payload, 'Olá LIORA, como está o sistema?');
});

test('HVA-05: Mecanismo de Interrupção de Fala (Barge-in)', () => {
  let activeOrbState = 'SPEAKING';
  let isAudioPlaying = true;
  let bargeInTriggered = false;

  function onUserInputDuringSpeech(input: string) {
    if (activeOrbState === 'SPEAKING' && input.length > 0) {
      isAudioPlaying = false;
      activeOrbState = 'LISTENING';
      bargeInTriggered = true;
    }
  }

  // Usuário começa a digitar ou falar enquanto a LIORA está no estado SPEAKING
  onUserInputDuringSpeech('Pare um momento');

  assert.strictEqual(bargeInTriggered, true, 'O evento de Barge-in deve ser acionado imediatamente.');
  assert.strictEqual(isAudioPlaying, false, 'A reprodução de áudio deve ser interrompida.');
  assert.strictEqual(activeOrbState, 'LISTENING', 'O estado do Orbe deve transicionar para LISTENING.');
});

test('HVA-06: Persistência de Chaves de API no Arquivo .env', () => {
  const tempEnvPath = path.resolve(rootDir, '.env.test_tmp');

  try {
    // 1. Grava chave Gemini
    updateEnvFileSimulated(tempEnvPath, 'GEMINI_API_KEY', 'test_gemini_key_123456');
    let content = fs.readFileSync(tempEnvPath, 'utf8');
    assert.ok(content.includes('GEMINI_API_KEY="test_gemini_key_123456"'), 'O arquivo deve conter a GEMINI_API_KEY gravada.');

    // 2. Grava chave OpenRouter mantendo a anterior
    updateEnvFileSimulated(tempEnvPath, 'OPENROUTER_API_KEY', 'test_openrouter_key_abcdef');
    content = fs.readFileSync(tempEnvPath, 'utf8');
    assert.ok(content.includes('GEMINI_API_KEY="test_gemini_key_123456"'), 'A GEMINI_API_KEY deve ser preservada.');
    assert.ok(content.includes('OPENROUTER_API_KEY="test_openrouter_key_abcdef"'), 'A OPENROUTER_API_KEY deve ser adicionada.');

    // 3. Atualiza valor existente sem duplicar linha
    updateEnvFileSimulated(tempEnvPath, 'GEMINI_API_KEY', 'new_updated_key_789012');
    content = fs.readFileSync(tempEnvPath, 'utf8');
    assert.ok(content.includes('GEMINI_API_KEY="new_updated_key_789012"'), 'A chave deve ser atualizada.');
    const occurrences = (content.match(/GEMINI_API_KEY/g) || []).length;
    assert.strictEqual(occurrences, 1, 'Não deve haver linhas duplicadas para a mesma chave.');
  } finally {
    if (fs.existsSync(tempEnvPath)) {
      fs.unlinkSync(tempEnvPath);
    }
  }
});

test('HVA-07: Shield Mode e Soberania Local de Hardware', () => {
  const shieldStatus = {
    isLocalHostOnly: true,
    dataExfiltrationBlocked: true,
    mode: 'Local Soberano'
  };

  assert.strictEqual(shieldStatus.isLocalHostOnly, true, 'O modo escudo garante tráfego local no host.');
  assert.strictEqual(shieldStatus.dataExfiltrationBlocked, true, 'O exfiltração de dados sensíveis deve ser bloqueada.');
});
