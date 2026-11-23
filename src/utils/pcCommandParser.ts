/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * LIORA — Parser Determinístico de Comandos do Computador Local e Aplicativos
 * Mapeia intenções de fala ("abra o bloco de notas", "abra a calculadora", "abra o painel de controle")
 * para os executáveis reais do sistema operacional sem alucinação de LLM.
 */

export interface PcAppMatch {
  type: 'app_launch';
  appName: string;
  executable: string;
  spokenFeedback: string;
  rawInput: string;
}

export interface PcSystemMatch {
  type: 'system_lock' | 'volume_up' | 'volume_down' | 'volume_mute';
  action: string;
  spokenFeedback: string;
  rawInput: string;
}

export interface PcCameraMatch {
  type: 'camera_toggle';
  enable: boolean;
  spokenFeedback: string;
  rawInput: string;
}

export type PcCommandMatch = PcAppMatch | PcSystemMatch | PcCameraMatch;

interface AppDefinition {
  names: string[];
  executable: string;
  label: string;
}

const KNOWN_WINDOWS_APPS: AppDefinition[] = [
  {
    names: ['bloco de notas', 'bloco de nota', 'notepad', 'editor de texto'],
    executable: 'notepad',
    label: 'Bloco de Notas'
  },
  {
    names: ['calculadora', 'calc', 'calculator'],
    executable: 'calc',
    label: 'Calculadora'
  },
  {
    names: ['painel de controle', 'painel de controle do windows', 'control panel', 'control'],
    executable: 'control',
    label: 'Painel de Controle'
  },
  {
    names: ['configuracoes do windows', 'configuracoes do sistema', 'ajustes do windows', 'ms settings', 'windows settings'],
    executable: 'ms-settings:',
    label: 'Configurações do Windows'
  },
  {
    names: ['gerenciador de tarefas', 'task manager', 'taskmgr'],
    executable: 'taskmgr',
    label: 'Gerenciador de Tarefas'
  },
  {
    names: ['explorador de arquivos', 'meus arquivos', 'pasta de arquivos', 'explorer', 'pastas'],
    executable: 'explorer',
    label: 'Explorador de Arquivos'
  },
  {
    names: ['google chrome', 'chrome', 'google', 'navegador chrome', 'navegador', 'abrir internet', 'internet'],
    executable: 'chrome',
    label: 'Google Chrome'
  },
  {
    names: ['microsoft edge', 'edge', 'navegador edge'],
    executable: 'msedge',
    label: 'Microsoft Edge'
  },
  {
    names: ['spotify', 'musica', 'tocar musica'],
    executable: 'spotify',
    label: 'Spotify'
  },
  {
    names: ['visual studio code', 'vs code', 'vscode', 'editor de codigo', 'code'],
    executable: 'code',
    label: 'Visual Studio Code'
  },
  {
    names: ['prompt de comando', 'cmd', 'terminal', 'powershell', 'console'],
    executable: 'powershell',
    label: 'PowerShell'
  },
  {
    names: ['paint', 'mspaint', 'desenho'],
    executable: 'mspaint',
    label: 'Paint'
  },
  {
    names: ['steam', 'jogos steam'],
    executable: 'steam',
    label: 'Steam'
  },
  {
    names: ['discord'],
    executable: 'discord',
    label: 'Discord'
  },
  {
    names: ['whatsapp', 'zap', 'zap zap'],
    executable: 'whatsapp',
    label: 'WhatsApp'
  },
  {
    names: ['word', 'microsoft word', 'documento word'],
    executable: 'winword',
    label: 'Microsoft Word'
  },
  {
    names: ['excel', 'microsoft excel', 'planilha', 'planilha excel'],
    executable: 'excel',
    label: 'Microsoft Excel'
  },
  {
    names: ['powerpoint', 'microsoft powerpoint', 'slides'],
    executable: 'powerpnt',
    label: 'Microsoft PowerPoint'
  },
  {
    names: ['opera', 'opera gx', 'navegador opera'],
    executable: 'opera',
    label: 'Opera GX'
  },
  {
    names: ['telegram'],
    executable: 'telegram',
    label: 'Telegram'
  },
  {
    names: ['vlc', 'reprodutor vlc', 'reprodutor de video'],
    executable: 'vlc',
    label: 'VLC Media Player'
  },
  {
    names: ['obs', 'obs studio', 'gravador de tela'],
    executable: 'obs64',
    label: 'OBS Studio'
  }
];

function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanUtterance(text: string): string {
  let norm = normalizeText(text);
  if (!norm) return '';
  // Remove invocações da assistente ("liora", "ei liora", "ok liora")
  norm = norm.replace(/\b(?:e\s+|ei\s+|ola\s+|ok\s+)?liora\b/g, ' ');
  // Remove preâmbulos de cortesia e pedidos indiretos
  norm = norm.replace(/\b(?:por\s+favor|por\s+gentileza|faca\s+o\s+favor|faz\s+favor|favor)\b/g, ' ');
  norm = norm.replace(/\b(?:voce\s+pode|pode|consegue|poderia|seria\s+possivel|quero\s+que\s+voce|quero\s+que|preciso\s+que|da\s+pra)\b/g, ' ');
  norm = norm.replace(/\b(?:pra\s+mim|para\s+mim)\b/g, ' ');
  return norm.replace(/\s+/g, ' ').trim();
}

const LAUNCH_PREFIX_REGEX = /^(?:abr[aei]r?|inici[aei]r?|execut[aei]r?|rod[aei]r?|lan[cç][aei]r?|lig[aei]r?)\s+/;

/**
 * Analisa se a fala do usuário corresponde a uma intenção de abrir aplicativo do PC ou ação de sistema.
 */
export function parsePcCommandIntent(input: string): PcCommandMatch | null {
  if (!input) return null;
  const rawClean = input.trim();
  if (!rawClean) return null;

  const normalized = cleanUtterance(rawClean);
  if (!normalized) return null;

  // 0. Câmera, Visão Computacional e Controle por Gestos de Mão
  if (
    /\b(?:ativar|ligar|iniciar|abrir|habilitar)\s+(?:a\s+)?(?:camera|webcam|visao\s+computacional|controle\s+por\s+gestos|gestos?\s+de\s+mao|gestos?)\b/.test(normalized) ||
    /^(?:camera|webcam|visao\s+computacional|gestos)\s+(?:on|ligad[oa]|ativad[oa])$/.test(normalized)
  ) {
    return {
      type: 'camera_toggle',
      enable: true,
      spokenFeedback: 'Ativando a visão computacional e controle por gestos, Mestre.',
      rawInput: rawClean
    };
  }

  if (
    /\b(?:desativar|desligar|fechar|parar|desabilitar|encerrar)\s+(?:a\s+)?(?:camera|webcam|visao\s+computacional|controle\s+por\s+gestos|gestos?\s+de\s+mao|gestos?)\b/.test(normalized) ||
    /^(?:camera|webcam|visao\s+computacional|gestos)\s+(?:off|desligad[oa]|desativad[oa])$/.test(normalized)
  ) {
    return {
      type: 'camera_toggle',
      enable: false,
      spokenFeedback: 'Desativando a visão computacional e câmera, Mestre.',
      rawInput: rawClean
    };
  }

  // 1. Ações de Bloqueio de Sessão
  if (
    normalized.includes('bloquear tela') || 
    normalized.includes('bloqueie a tela') || 
    normalized.includes('bloquear pc') || 
    normalized.includes('bloqueie o pc') || 
    normalized.includes('bloquear computador') ||
    normalized.includes('trancar tela') ||
    normalized.includes('trancar pc')
  ) {
    return {
      type: 'system_lock',
      action: 'lock',
      spokenFeedback: 'Bloqueando a sessão do computador, Mestre.',
      rawInput: rawClean
    };
  }

  // 2. Comandos de Volume
  if (normalized.includes('aumentar volume') || normalized.includes('aumente o volume') || normalized.includes('volume mais alto')) {
    return {
      type: 'volume_up',
      action: 'volume_up',
      spokenFeedback: 'Aumentando o volume, Mestre.',
      rawInput: rawClean
    };
  }
  if (normalized.includes('diminuir volume') || normalized.includes('baixe o volume') || normalized.includes('abaixar volume') || normalized.includes('abaixe o volume') || normalized.includes('volume mais baixo')) {
    return {
      type: 'volume_down',
      action: 'volume_down',
      spokenFeedback: 'Diminuindo o volume, Mestre.',
      rawInput: rawClean
    };
  }
  if (
    normalized.includes('mutar som') ||
    normalized.includes('mutar audio') ||
    normalized.includes('silenciar som') ||
    normalized.includes('silenciar audio') ||
    normalized.includes('sem som') ||
    normalized.includes('tirar o som') ||
    /^(?:no\s+)?mudo$/.test(normalized) ||
    /\b(?:colocar|coloque|deixar|deixe|ficar|ativar|por|botar|bote)\s+(?:no\s+|o\s+som\s+)?mudo\b/.test(normalized)
  ) {
    return {
      type: 'volume_mute',
      action: 'volume_mute',
      spokenFeedback: 'Silenciando o áudio do computador, Mestre.',
      rawInput: rawClean
    };
  }

  // 3. Guard anti-sequestro para comandos inteligentes, navegação, digitação, abas ou ações complexas:
  // Frases que contêm verbos de pesquisa, consulta, abas, digitação, tela, foco ou encadeamento
  // NUNCA devem ser interceptadas de forma estática — devem ir para o LLM inteligente orquestrar.
  const hasComplexOrChainedIntent =
    /\b(?:pesquis\w*|busc\w*|procur\w*|consult\w*|digit\w*|escrev\w*|anot\w*|salv\w*|fech\w*|encerr\w*|mat\w*|finaliz\w*|aba|abas|guia|guias|link|site|pagina|frente|primeiro\s+plano|segundo\s+plano|minimizad\w*|maximizad\w*|capa|dolar|cotacao|quanto|qual|como|onde|olhe|veja|tela|print|screenshot|sair\s+d[oa])\b/.test(normalized) ||
    /\b(?:e\s+\w+|depois|em\s+seguida|para\s+\w+|relatorio|ideias)\b/.test(normalized);

  if (hasComplexOrChainedIntent) {
    return null;
  }

  // 4. Lançamento de Aplicativos Conhecidos
  const hasLaunchPrefix = LAUNCH_PREFIX_REGEX.test(normalized);
  let targetAppPhrase = normalized;
  if (hasLaunchPrefix) {
    targetAppPhrase = normalized.replace(LAUNCH_PREFIX_REGEX, '').trim();
  }

  // Remove artigos e conectivos
  targetAppPhrase = targetAppPhrase
    .replace(/^(?:o|a|os|as|um|uma|aplicativo|app|programa|ferramenta)\s+/, '')
    .replace(/^(?:o|a)\s+/, '')
    .trim();

  // Constrói candidatos ordenados do nome mais longo ao mais curto para evitar que sinônimos curtos capturem antes de compostos
  const appCandidates: Array<{ app: AppDefinition; normName: string }> = [];
  for (const app of KNOWN_WINDOWS_APPS) {
    for (const name of app.names) {
      appCandidates.push({ app, normName: normalizeText(name) });
    }
  }
  appCandidates.sort((a, b) => b.normName.length - a.normName.length);

  for (const { app, normName } of appCandidates) {
    if (!normName) continue;
    const escapedName = normName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryRe = new RegExp(`^${escapedName}$|^(?:o|a|os|as)?\\s*${escapedName}$`);

    // Só dispara se o comando for estritamente a intenção de abrir o app específico
    const isDirectMatch =
      targetAppPhrase === normName ||
      boundaryRe.test(targetAppPhrase) ||
      normalized === normName ||
      normalized === `abrir ${normName}` ||
      normalized === `abra ${normName}` ||
      normalized === `abre ${normName}` ||
      normalized === `iniciar ${normName}` ||
      normalized === `inicie ${normName}` ||
      normalized === `executar ${normName}` ||
      normalized === `execute ${normName}`;

    if (isDirectMatch) {
      return {
        type: 'app_launch',
        appName: app.label,
        executable: app.executable,
        spokenFeedback: `Abrindo ${app.label}, Mestre.`,
        rawInput: rawClean
      };
    }
  }

  // 4. Lançamento genérico APENAS com prefixo explícito de aplicativo ("abra o aplicativo X", "inicie o programa Y")
  // Blindagem anti-parcial: NUNCA dispara em fragmentos como "blo" ou "bloco"
  const explicitAppPattern = /^(?:abr[aei]r?|inici[aei]r?|execut[aei]r?|rod[aei]r?)\s+(?:o|a)?\s*(?:aplicativo|programa|app|software)\s+([a-zA-Z0-9_\-\.]+)/i;
  const explicitMatch = normalized.match(explicitAppPattern);
  if (explicitMatch && explicitMatch[1] && explicitMatch[1].length >= 4) {
    const customApp = explicitMatch[1].trim();
    const forbiddenWords = ['para', 'com', 'onde', 'como', 'quem', 'quando', 'sobre', 'novo', 'nova', 'outro', 'outra'];
    if (!forbiddenWords.includes(customApp)) {
      return {
        type: 'app_launch',
        appName: customApp,
        executable: customApp,
        spokenFeedback: `Iniciando ${customApp}, Mestre.`,
        rawInput: rawClean
      };
    }
  }

  return null;
}
