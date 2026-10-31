/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AppConfig {
  name: string;
  codename: string;
  version: string;
  platform: 'tauri' | 'web';
  runtime: {
    audioInputSampleRate: number;
    audioOutputSampleRate: number;
    neuralVoiceDefault: 'Aoede' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
    wsVoiceEndpoint: string;
    telemetryRefreshRateMs: number;
  };
  navigation: {
    tabs: Array<{ id: string; label: string; icon: string; shortcut?: string }>;
  };
}

export const appConfig: AppConfig = {
  name: 'LIORA',
  codename: 'Sovereign Crimson',
  version: '1.0.0-rc1',
  platform: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'tauri' : 'web',
  runtime: {
    audioInputSampleRate: 16000,
    audioOutputSampleRate: 24000,
    neuralVoiceDefault: 'Aoede',
    wsVoiceEndpoint: '/ws/voice',
    telemetryRefreshRateMs: 100
  },
  navigation: {
    tabs: [
      { id: 'home', label: 'Início', icon: 'Home' },
      { id: 'conversation', label: 'Conversa', icon: 'MessageSquare', shortcut: 'Alt+C' },
      { id: 'activity', label: 'Atividade', icon: 'Activity', shortcut: 'Alt+A' },
      { id: 'memory', label: 'Memória', icon: 'Brain', shortcut: 'Alt+M' },
      { id: 'devices', label: 'Dispositivos', icon: 'Cpu', shortcut: 'Alt+D' },
      { id: 'automations', label: 'Automações', icon: 'Workflow' },
      { id: 'developer', label: 'Desenvolvedor', icon: 'Terminal' },
      { id: 'integrations', label: 'Integrações', icon: 'Key' },
      { id: 'settings', label: 'Configurações', icon: 'Settings', shortcut: 'Alt+S' }
    ]
  }
};

export default appConfig;
