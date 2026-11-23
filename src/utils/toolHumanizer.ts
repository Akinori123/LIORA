/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Tradutor e Humanizador de Ferramentas
 * Converte nomes técnicos de ferramentas (ex: "system_exec_sandbox", "pc_manage_apps")
 * e parâmetros brutos em linguagem humana, afetuosa e compreensível para o Mestre.
 */

export interface HumanizedToolInfo {
  title: string;
  friendlyDescription: string;
  spokenPrompt: string;
  categoryIcon?: string;
}

const FRIENDLY_APP_NAMES: Record<string, string> = {
  notepad: 'Bloco de Notas',
  chrome: 'Google Chrome',
  'google chrome': 'Google Chrome',
  msedge: 'Microsoft Edge',
  edge: 'Microsoft Edge',
  calc: 'Calculadora',
  calculator: 'Calculadora',
  explorer: 'Explorador de Arquivos',
  cmd: 'Prompt de Comando',
  powershell: 'PowerShell',
  code: 'Visual Studio Code',
  spotify: 'Spotify',
  discord: 'Discord',
  taskmgr: 'Gerenciador de Tarefas',
  mspaint: 'Paint',
  paint: 'Paint',
  steam: 'Steam',
  vlc: 'VLC Media Player'
};

function getFriendlyAppName(raw: string): string {
  if (!raw) return 'o aplicativo';
  const clean = raw.toLowerCase().replace(/\.exe$/i, '').trim();
  return FRIENDLY_APP_NAMES[clean] || raw;
}

function humanizeToolActionRaw(
  toolName: string,
  parameters: Record<string, any> = {},
  riskLevel = 'R1'
): HumanizedToolInfo {
  const normTool = String(toolName || '').toLowerCase().trim();

  // 1. Controle de Aplicativos e Janelas
  if (normTool === 'pc_manage_apps' || normTool === 'open_application') {
    const action = String(parameters.action || 'launch').toLowerCase();
    const target = parameters.processName || parameters.appPath || parameters.appName || parameters.windowTitle || '';
    const appName = getFriendlyAppName(target);
    const windowState = parameters.windowState || 'foreground';

    if (action === 'kill' || action === 'close') {
      return {
        title: `Fechar ${appName}`,
        friendlyDescription: `Encerrar a execução do aplicativo ${appName}.`,
        spokenPrompt: `{ADDRESS}, para fechar o ${appName}, preciso da sua autorização. Posso encerrar agora? Diga autorizar ou cancelar.`
      };
    }

    if (action === 'minimize') {
      return {
        title: `Minimizar ${appName}`,
        friendlyDescription: `Minimizar a janela do ${appName} para a barra de tarefas.`,
        spokenPrompt: `{ADDRESS}, posso minimizar a janela do ${appName} para você? Diga autorizar ou cancelar.`
      };
    }

    if (action === 'maximize') {
      return {
        title: `Maximizar ${appName}`,
        friendlyDescription: `Expandir a janela do ${appName} para tela cheia.`,
        spokenPrompt: `{ADDRESS}, posso maximizar a janela do ${appName}? Diga autorizar ou cancelar.`
      };
    }

    if (action === 'focus') {
      return {
        title: `Trazer ${appName} para o Primeiro Plano`,
        friendlyDescription: `Trazer a janela do ${appName} para a sua frente na tela.`,
        spokenPrompt: `{ADDRESS}, posso colocar a janela do ${appName} na sua frente agora? Diga autorizar ou cancelar.`
      };
    }

    // Default launch
    const bgDesc = windowState === 'background' || windowState === 'minimized' ? ' em segundo plano' : '';
    return {
      title: `Abrir ${appName}`,
      friendlyDescription: `Iniciar o aplicativo ${appName} no seu computador${bgDesc}.`,
      spokenPrompt: `{ADDRESS}, para abrir o ${appName}${bgDesc}, preciso da sua autorização. Posso prosseguir? Diga autorizar ou cancelar.`
    };
  }

  // 2. Simulação de Entrada (Teclado, Mouse e Abas)
  if (normTool === 'pc_simulate_input') {
    const action = String(parameters.action || '').toLowerCase();
    const keys = String(parameters.keys || '').toLowerCase();
    const targetApp = parameters.targetApp ? getFriendlyAppName(parameters.targetApp) : '';

    if (action === 'hotkey') {
      if (keys.includes('ctrl+w') || keys.includes('^w')) {
        const appPrefix = targetApp ? ` no ${targetApp}` : ' no navegador';
        return {
          title: `Fechar Aba${appPrefix}`,
          friendlyDescription: `Fechar a aba ativa${appPrefix} usando atalho de teclado.`,
          spokenPrompt: `{ADDRESS}, para fechar a aba${appPrefix}, preciso da sua confirmação. Posso fechar agora? Diga autorizar ou cancelar.`
        };
      }
      if (keys.includes('ctrl+t') || keys.includes('^t')) {
        const appPrefix = targetApp ? ` no ${targetApp}` : ' no navegador';
        return {
          title: `Abrir Nova Aba${appPrefix}`,
          friendlyDescription: `Abrir uma nova aba${appPrefix}.`,
          spokenPrompt: `{ADDRESS}, posso abrir uma nova aba${appPrefix} para você? Diga autorizar ou cancelar.`
        };
      }
      if (keys.includes('alt+f4')) {
        return {
          title: `Fechar Janela Ativa`,
          friendlyDescription: `Fechar a janela ativa na tela usando atalho seguro.`,
          spokenPrompt: `{ADDRESS}, preciso da sua confirmação para fechar esta janela. Posso prosseguir? Diga autorizar ou cancelar.`
        };
      }
      return {
        title: `Atalho de Teclado (${parameters.keys || 'atalho'})`,
        friendlyDescription: `Enviar a combinação de teclas '${parameters.keys}'${targetApp ? ` para ${targetApp}` : ''}.`,
        spokenPrompt: `{ADDRESS}, preciso da sua autorização para enviar o comando de teclado '${parameters.keys}'. Posso prosseguir? Diga autorizar ou cancelar.`
      };
    }

    if (action === 'type') {
      const preview = parameters.text ? `"${String(parameters.text).slice(0, 30)}..."` : 'texto';
      return {
        title: `Digitar no Computador`,
        friendlyDescription: `Digitar o texto ${preview} no aplicativo ${targetApp || 'focado'}.`,
        spokenPrompt: `{ADDRESS}, para digitar o texto solicitado no ${targetApp || 'aplicativo'}, preciso da sua confirmação. Posso digitar? Diga autorizar ou cancelar.`
      };
    }

    if (action === 'click') {
      return {
        title: `Clicar na Tela`,
        friendlyDescription: `Clicar com o mouse na posição indicada da tela (${parameters.x}, ${parameters.y}).`,
        spokenPrompt: `{ADDRESS}, posso realizar este clique na tela para você? Diga autorizar ou cancelar.`
      };
    }
  }

  // 3. Execução de Comandos de Sistema / Terminal
  if (normTool === 'system_exec_sandbox' || normTool === 'system_exec_simulated') {
    const cmd = parameters.command ? `"${String(parameters.command).slice(0, 45)}"` : 'comando';
    return {
      title: `Executar Comando no Terminal`,
      friendlyDescription: `Rodar o comando ${cmd} no ambiente seguro do sistema.`,
      spokenPrompt: `{ADDRESS}, preciso da sua autorização para rodar o comando ${cmd} no terminal. Posso executar? Diga autorizar ou cancelar.`
    };
  }

  // 4. Manipulação de Arquivos
  if (normTool === 'workspace_write_file' || normTool === 'file_write_and_modify') {
    const path = parameters.filePath || parameters.path || 'arquivo';
    return {
      title: `Salvar Arquivo`,
      friendlyDescription: `Criar ou alterar o arquivo '${path}' no seu computador.`,
      spokenPrompt: `{ADDRESS}, preciso da sua autorização para salvar o arquivo '${path}'. Posso gravar? Diga autorizar ou cancelar.`
    };
  }

  if (normTool === 'workspace_read_file' || normTool === 'file_search_and_read') {
    const path = parameters.filePath || parameters.path || 'arquivo';
    return {
      title: `Ler Arquivo`,
      friendlyDescription: `Consultar o conteúdo do arquivo '${path}'.`,
      spokenPrompt: `{ADDRESS}, posso ler o arquivo '${path}' para você? Diga autorizar ou cancelar.`
    };
  }

  // 5. Navegador Web
  if (normTool === 'open_browser') {
    const url = parameters.url || 'a internet';
    return {
      title: `Abrir Navegador Web`,
      friendlyDescription: `Abrir o endereço '${url}' no seu navegador.`,
      spokenPrompt: `{ADDRESS}, posso abrir o navegador no site solicitado? Diga autorizar ou cancelar.`
    };
  }

  // 6. Mapas e Rotas
  if (normTool === 'open_gps_navigation' || normTool === 'calculate_route') {
    const dest = parameters.destination || 'o destino';
    return {
      title: `Navegação GPS`,
      friendlyDescription: `Abrir a rota para '${dest}' no seu aplicativo de mapas.`,
      spokenPrompt: `{ADDRESS}, posso abrir a rota para ${dest} no mapa agora? Diga autorizar ou cancelar.`
    };
  }

  // Fallback Amigável para qualquer outra ferramenta
  const readableName = toolName
    .replace(/^pc_/, '')
    .replace(/^system_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    title: readableName,
    friendlyDescription: `A ferramenta '${readableName}' (nível ${riskLevel}) está aguardando sua permissão para agir no sistema.`,
    spokenPrompt: `{ADDRESS}, para executar a ação de ${readableName}, preciso da sua autorização. Posso prosseguir? Diga autorizar ou cancelar.`
  };
}

/**
 * Resolve o vocativo usado pela LIORA nas falas de consentimento.
 *
 * BUG (relato de campo): o usuário pediu "de agora em diante me chame de
 * Senhor" e a memória guardou isso — mas TODAS as frases de consentimento
 * exibidas/faladas continuavam com "Mestre" hardcoded no código, porque esses
 * textos são determinísticos (não passam pelo modelo). Em conversa normal ela
 * acertava; no cartão e na voz de confirmação, não.
 *
 * Fonte: memória (preferência de tratamento) → padrão "Mestre".
 */
export function resolvePreferredAddress(): string {
  try {
    const store = (globalThis as any).__LIORA_STORE__;
    const entries: Array<{ key?: string; value?: string; category?: string }> =
      (store?.getState?.().memoryEntries as any[]) || [];
    const match = entries.find((m) =>
      /(nome|apelido|tratamento|chamar|chame)/i.test(String(m.key || '')) ||
      /(me chame de|me chama de|me trate por|me chame como|pode me chamar de)/i.test(String(m.value || ''))
    );
    if (match?.value) {
      const direct = /(?:me\s+ch(?:a|e)me\s+(?:de|como)|me\s+trate\s+por|pode\s+me\s+chamar\s+de)\s+([A-Za-zÀ-ÿ]+)/i.exec(match.value);
      if (direct?.[1]) return direct[1];
      const keyMatch = /^(?:nome|preferencia_de_tratamento|preferência_de_tratamento)$/i.test(String(match.key || ''));
      if (keyMatch) {
        const value = String(match.value).trim();
        if (value && value.length <= 30) return value;
      }
    }
  } catch {
    // Sem store → vocativo padrão
  }
  return 'Mestre';
}

/** Versão pública: humaniza a ação e aplica o vocativo preferido do usuário. */
export function humanizeToolAction(
  toolName: string,
  parameters: Record<string, any> = {},
  riskLevel = 'R1'
): HumanizedToolInfo {
  const info = humanizeToolActionRaw(toolName, parameters, riskLevel);
  const address = resolvePreferredAddress();
  return {
    ...info,
    spokenPrompt: info.spokenPrompt.split('{ADDRESS}').join(address)
  };
}
