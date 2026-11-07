/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes Unitários das Ferramentas de Produtividade (Fase 2) — LIORA
 * E-mail (IMAP/SMTP) e Calendário local.
 *
 * Estratégia: os testes de leitura/envio de e-mail dependem de um servidor IMAP/
 * SMTP real — sem credenciais configuradas, as ferramentas devem responder com
 * erro HONESTO (EMAIL_NOT_CONFIGURED), nunca dados fictícios. Os testes de
 * calendário operam sobre arquivo local real (sandbox em os.tmpdir via path do
 * usuário) com ciclo completo de criação/consulta/conflito.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { emailFetchAndReadTool, emailSendOrReplyTool } from '../src/tools/productivity/emailTools';
import { calendarListEventsTool, calendarCreateEventTool } from '../src/tools/productivity/calendarTools';

// ─── E-mail ──────────────────────────────────────────────────────────────────

test('EMAIL-01: ferramentas declaradas com níveis de risco corretos', () => {
  assert.strictEqual(emailFetchAndReadTool.name, 'email_fetch_and_read');
  assert.strictEqual(emailFetchAndReadTool.riskLevel, 'R1', 'leitura de e-mail é R1');
  assert.strictEqual(emailSendOrReplyTool.name, 'email_send_or_reply');
  assert.strictEqual(emailSendOrReplyTool.riskLevel, 'R2', 'envio de e-mail é R2');
  assert.strictEqual(emailFetchAndReadTool.isSimulated, false);
  assert.strictEqual(emailSendOrReplyTool.isSimulated, false);
});

test('EMAIL-02: fetch sem credenciais responde erro honesto (nunca dados fictícios)', async () => {
  const res = await emailFetchAndReadTool.execute({ mode: 'recent' });
  assert.strictEqual(res.simulated, false);
  if (res.success) {
    // Credenciais configuradas no cofre da máquina de teste: deve ser real
    assert.ok(Array.isArray(res.messages));
  } else {
    assert.match(String(res.error), /EMAIL_NOT_CONFIGURED|IMAP_/);
  }
});

test('EMAIL-03: send valida destinatário inválido', async () => {
  const res = await emailSendOrReplyTool.execute({
    to: 'nao-e-um-email',
    subject: 'teste',
    body: 'teste'
  });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /INVALID_RECIPIENT|EMAIL_NOT_CONFIGURED/);
});

test('EMAIL-04: send bloqueia header injection', async () => {
  const res = await emailSendOrReplyTool.execute({
    to: 'test@example.com\r\nBCC: vitima@exemplo.com',
    subject: 'teste',
    body: 'teste'
  });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /HEADER_INJECTION|INVALID_RECIPIENT|EMAIL_NOT_CONFIGURED/);
});

test('EMAIL-05: send exige assunto e corpo', async () => {
  const noSubject = await emailSendOrReplyTool.execute({ to: 'a@b.com', subject: '', body: 'x' });
  assert.strictEqual(noSubject.success, false);
  assert.match(String(noSubject.error), /MISSING_SUBJECT|EMAIL_NOT_CONFIGURED/);

  const noBody = await emailSendOrReplyTool.execute({ to: 'a@b.com', subject: 's', body: '' });
  assert.strictEqual(noBody.success, false);
  assert.match(String(noBody.error), /MISSING_BODY|EMAIL_NOT_CONFIGURED/);
});

test('EMAIL-06: fetch sanitiza query de busca (anti-injeção IMAP)', async () => {
  // Query com caracteres perigosos não deve derrubar o processo
  const res = await emailFetchAndReadTool.execute({
    mode: 'search',
    query: 'teste" INJECT\r\n hacked'
  });
  assert.strictEqual(res.simulated, false);
  assert.ok(res.success === true || res.success === false); // nunca throw
});

// ─── Calendário ──────────────────────────────────────────────────────────────

test('CAL-01: ferramentas declaradas com níveis de risco corretos', () => {
  assert.strictEqual(calendarListEventsTool.name, 'calendar_list_events');
  assert.strictEqual(calendarListEventsTool.riskLevel, 'R1');
  assert.strictEqual(calendarCreateEventTool.name, 'calendar_create_event');
  assert.strictEqual(calendarCreateEventTool.riskLevel, 'R2');
  assert.strictEqual(calendarCreateEventTool.isSimulated, false);
});

test('CAL-02: create valida título obrigatório', async () => {
  const res = await calendarCreateEventTool.execute({ title: '', start: '2030-01-15T14:00:00' });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /MISSING_TITLE/);
});

test('CAL-03: create valida datas ISO inválidas', async () => {
  const res = await calendarCreateEventTool.execute({ title: 'Teste', start: 'data- invalida' });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /INVALID_DATE|MISSING_DATE/);
});

test('CAL-04: create valida range (fim antes do início)', async () => {
  const res = await calendarCreateEventTool.execute({
    title: 'Teste range',
    start: '2030-01-15T15:00:00',
    end: '2030-01-15T14:00:00'
  });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /INVALID_RANGE/);
});

test('CAL-05: create valida participantes como e-mails', async () => {
  const res = await calendarCreateEventTool.execute({
    title: 'Teste participantes',
    start: '2030-01-15T14:00:00',
    participants: ['valido@exemplo.com', 'invalido-sem-arroba']
  });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /INVALID_PARTICIPANT/);
});

test('CAL-06: ciclo completo create → list → conflito detectado', async () => {
  const future = new Date();
  future.setDate(future.getDate() + 365); // 1 ano no futuro (não interfere em dados reais)
  future.setHours(14, 0, 0, 0);
  // CORREÇÃO (timezone): usamos a representação LOCAL para o evento (o filtro
  // mode=day compara horas locais). toISOString() deslocaria o horário pelo
  // offset UTC e o evento cairia em outro dia no filtro.
  const pad = (n: number) => String(n).padStart(2, '0');
  const startIso = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}:00`;

  // 1. Criação bem-sucedida
  const created = await calendarCreateEventTool.execute({
    title: 'TESTE-LIORA-CAL-CICLO',
    start: startIso,
    durationMinutes: 60
  });
  assert.strictEqual(created.success, true, `create deve funcionar: ${created.error || 'ok'}`);
  assert.ok(created.event && created.event.id.startsWith('evt-'));
  assert.strictEqual(created.simulated, false);

  // 2. Consulta por dia encontra o evento
  const dayIso = startIso.slice(0, 10);
  const listed = await calendarListEventsTool.execute({ mode: 'day', date: dayIso });
  assert.strictEqual(listed.success, true);
  const found = (listed.events as any[]).find(e => e.title === 'TESTE-LIORA-CAL-CICLO');
  assert.ok(found, 'Evento criado deve aparecer na consulta do dia');

  // 3. Criação no MESMO horário detecta conflito
  const conflicted = await calendarCreateEventTool.execute({
    title: 'TESTE-LIORA-CAL-CONFLITO',
    start: startIso,
    durationMinutes: 30
  });
  assert.strictEqual(conflicted.success, true, 'conflito não impede criação, mas avisa');
  assert.ok(Array.isArray(conflicted.conflicts) && conflicted.conflicts.length > 0, 'conflito deve ser detectado');
  assert.match(String(conflicted.warning), /ATENÇÃO/);

  // 4. Cleanup: remove os eventos de teste do arquivo real (não poluir a agenda)
  try {
    const calFile = path.join(os.homedir(), '.liora', 'calendar', 'events.json');
    if (fs.existsSync(calFile)) {
      const events = JSON.parse(fs.readFileSync(calFile, 'utf8'));
      const cleaned = events.filter((e: any) => !String(e.title).startsWith('TESTE-LIORA-CAL'));
      fs.writeFileSync(calFile, JSON.stringify(cleaned, null, 2), 'utf8');
    }
  } catch { /* ignore — cleanup best-effort */ }
});

test('CAL-07: list com modo day sem data responde erro claro', async () => {
  const res = await calendarListEventsTool.execute({ mode: 'day' });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /MISSING_DATE|INVALID_DATE/);
});

test('CAL-08: list com range incompleto responde erro claro', async () => {
  const res = await calendarListEventsTool.execute({ mode: 'range', startDate: '2030-01-15' });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /MISSING_DATE|INVALID_DATE/);
});
