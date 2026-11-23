/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes do PASSO 2 da auditoria profunda:
 *  - execução REAL de abertura de app no Windows (pc_manage_apps / open_application)
 *  - resolução de nome → executável (o bug do Start-Process com 'notepad')
 *  - contrato verdadeiro do registry (success reflete a execução)
 *  - datas do calendário sem deslocamento de fuso
 *
 * Estes testes TÊM efeito colateral controlado: abrem o Bloco de Notas no Windows
 * e o encerram no finally. Em outros SOs são pulados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { installNativeServerTools } from '../src/tools/nativeServerTools';
import { toolRegistry } from '../src/tools/registry';
import { pcManageAppsTool, openApplicationTool } from '../src/tools/pcControlTools';

const isWindows = os.platform() === 'win32';
const countNotepad = (): number => {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      '(Get-Process -Name notepad -ErrorAction SilentlyContinue | Measure-Object).Count'
    ], { encoding: 'utf8', windowsHide: true });
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return -1;
  }
};
const killNotepad = () => {
  try {
    execFileSync('taskkill', ['/IM', 'notepad.exe', '/F'], { windowsHide: true });
  } catch { /* nenhum aberto */ }
};

test('REAL-PC-01: pc_manage_apps launch abre o Bloco de Notas de verdade (Windows)', { skip: !isWindows }, async () => {
  killNotepad();
  const before = countNotepad();
  const res = await pcManageAppsTool.execute({ action: 'launch', appPath: 'notepad' });
  try {
    assert.equal(res.success, true, `lançamento falhou: ${res.error || res.message}`);
    const after = countNotepad();
    assert.ok(after > before, `processo notepad não apareceu (antes=${before}, depois=${after})`);
  } finally {
    killNotepad();
  }
});

test('REAL-PC-02: open_application delega o lançamento com resolução de nome', { skip: !isWindows }, async () => {
  killNotepad();
  const res = await openApplicationTool.execute({ appName: 'Bloco de Notas' });
  try {
    assert.equal(res.success, true, `open_application falhou: ${res.error || res.message}`);
    assert.ok(countNotepad() > 0, 'Bloco de Notas não abriu via alias em português');
  } finally {
    killNotepad();
  }
});

test('REAL-PC-03: aplicativo inexistente falha com motivo legível (sem falso sucesso)', { skip: !isWindows }, async () => {
  const res = await pcManageAppsTool.execute({ action: 'launch', appPath: 'app_que_nao_existe_xyz' });
  assert.equal(res.success, false, 'lançamento de app inexistente não pode retornar sucesso');
  const msg = String(res.error || res.message || '');
  assert.ok(msg.length > 3, 'o erro precisa explicar o motivo (não apenas "código 0")');
  assert.doesNotMatch(msg, /comando.*não reconhecido/i, 'não deve vazar a mensagem crua do shell sem contexto');
});

test('REAL-PC-04: listar processos retorna dados reais e nunca vazio falso', { skip: !isWindows }, async () => {
  const res = await pcManageAppsTool.execute({ action: 'list' });
  assert.equal(res.success, true, res.error);
  assert.ok(Array.isArray(res.processes) && res.processes.length > 0, 'lista de processos vazia');
  assert.ok(res.processes.every((p: any) => typeof p.name === 'string'), 'processo sem nome');
});

test('REAL-PC-05: registry reflete a falha REAL da tool (success não é fixo)', async () => {
  installNativeServerTools(toolRegistry);
  const failing = await toolRegistry.executeTool('open_application', { appName: '' });
  assert.equal(failing.data?.success, false, 'tool sem alvo deve reportar falha no data');
  assert.equal(failing.success, false, 'o registry não pode mascarar a falha como sucesso');
  assert.ok(String(failing.error || '').length > 0);
});

test('CAL-01: data+hora local é interpretada sem deslocamento (fuso do usuário)', async () => {
  // Isola a persistência num diretório temporário: a suíte nunca toca ~/.liora.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liora-cal-'));
  process.env.LIORA_CALENDAR_DIR = tmpDir;
  try {
    const { calendarCreateEventTool, calendarListEventsTool } = await import('../src/tools/productivity/calendarTools');
    const created = await calendarCreateEventTool.execute({
      title: 'Teste fuso auditoria',
      start: '2031-06-10T14:30:00',
      durationMinutes: 30
    });
    assert.equal(created.success, true, created.error);
    const start = new Date(created.event.start);
    // O horário gravado deve ter os MESMOS componentes locais pedidos (14:30).
    assert.equal(start.getHours(), 14, `hora local deslocada: ${start.toString()}`);
    assert.equal(start.getMinutes(), 30);

    const listed = await calendarListEventsTool.execute({ mode: 'day', date: '2031-06-10' });
    assert.equal(listed.success, true, listed.error);
    assert.ok(
      listed.events.some((e: any) => e.title === 'Teste fuso auditoria'),
      'evento não apareceu no dia correto (janela do dia deslocada)'
    );
  } finally {
    delete process.env.LIORA_CALENDAR_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CAL-02: intervalo com datas puras inclui o ÚLTIMO dia inteiro', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liora-cal-range-'));
  process.env.LIORA_CALENDAR_DIR = tmpDir;
  try {
    const { calendarCreateEventTool, calendarListEventsTool } = await import('../src/tools/productivity/calendarTools');
    const created = await calendarCreateEventTool.execute({
      title: 'Evento no último dia',
      start: '2032-03-12T14:00:00',
      durationMinutes: 60
    });
    assert.equal(created.success, true, created.error);

    const listed = await calendarListEventsTool.execute({
      mode: 'range',
      startDate: '2032-03-10',
      endDate: '2032-03-12'
    });
    assert.equal(listed.success, true, listed.error);
    assert.ok(
      listed.events.some((e: any) => e.title === 'Evento no último dia'),
      'evento do dia final do intervalo não foi retornado'
    );
  } finally {
    delete process.env.LIORA_CALENDAR_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CAL-03: intervalo invertido falha com erro explícito', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liora-cal-inv-'));
  process.env.LIORA_CALENDAR_DIR = tmpDir;
  try {
    const { calendarListEventsTool } = await import('../src/tools/productivity/calendarTools');
    const listed = await calendarListEventsTool.execute({
      mode: 'range',
      startDate: '2032-04-20',
      endDate: '2032-04-10'
    });
    assert.equal(listed.success, false);
    assert.match(String(listed.error), /INVALID_RANGE/);
  } finally {
    delete process.env.LIORA_CALENDAR_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
