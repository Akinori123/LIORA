// QA: execução real COM consentimento (open_application) + injeção bloqueada na tool.
export default async function run(page) {
  const post = (path, body, headers = {}) => page.evaluate(async ({ path, body, headers }) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    let json = null;
    try { json = await res.json(); } catch { }
    return { status: res.status, json };
  }, { path, body, headers });

  const sid = 'qa-consent-' + Date.now();
  const H = { 'x-liora-session-id': sid };
  const out = {};

  // 1. Emite consentimento de UI para open_application (R2) com o MESMO payload
  const params = { appName: 'notepad' };
  const consent = await post('/api/security/ui-consent', { toolName: 'open_application', parameters: params }, H);
  out.consent = { status: consent.status, hasToken: Boolean(consent.json?.token), error: consent.json?.error };

  // 2. Executa com o token (deve realmente abrir o Bloco de Notas no Windows)
  if (consent.json?.token) {
    out.execute = await post('/api/tools/execute', { toolName: 'open_application', parameters: params }, { ...H, 'x-liora-ui-consent': consent.json.token });
  }

  // 3. Mesmo token reutilizado com outro payload → DENY (binding por hash)
  const consent2 = await post('/api/security/ui-consent', { toolName: 'open_application', parameters: params }, H);
  if (consent2.json?.token) {
    out.binding = await post('/api/tools/execute', { toolName: 'open_application', parameters: { appName: 'calc' } }, { ...H, 'x-liora-ui-consent': consent2.json.token });
  }

  // 4. Injeção no sandbox: mesmo com consentimento, a TOOL recusa por injeção
  const injParams = { command: 'git status ; whoami' };
  const consent3 = await post('/api/security/ui-consent', { toolName: 'system_exec_sandbox', parameters: injParams }, H);
  if (consent3.json?.token) {
    out.injectionWithConsent = await post('/api/tools/execute', { toolName: 'system_exec_sandbox', parameters: injParams }, { ...H, 'x-liora-ui-consent': consent3.json.token });
  }

  // 5. Comando seguro legítimo (R1 + consentimento) executa de verdade
  const safeParams = { command: 'git status' };
  const consent4 = await post('/api/security/ui-consent', { toolName: 'system_exec_sandbox', parameters: safeParams }, H);
  if (consent4.json?.token) {
    out.safeCommand = await post('/api/tools/execute', { toolName: 'system_exec_sandbox', parameters: safeParams }, { ...H, 'x-liora-ui-consent': consent4.json.token });
  }

  return out;
}
