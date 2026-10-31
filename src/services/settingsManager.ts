/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GlobalSettings, ThemeProfile, SettingsValidationResult } from '../types/settings';
import { getThemeColors } from '../utils/themeColors';

export const STORAGE_KEY_SETTINGS = 'liora_global_settings_v1';

export const DEFAULT_SETTINGS: GlobalSettings = {
  language: 'pt-BR',
  theme: 'crimson',
  orbQuality: 'auto',
  ttsModel: 'gemini-3.8-flash-lite-tts',
  ttsVoice: 'Aoede',
  logVerbosity: 'info',
  requestTimeoutMs: 15000,
  workspacePath: './workspace',
  securityEnforcementLevel: 'strict',
  desktopNotifications: true
};

const VALID_THEMES: ThemeProfile[] = ['crimson', 'emerald', 'amber', 'ice'];
const VALID_LANGUAGES = ['pt-BR', 'en-US', 'es-ES'];
const VALID_ORB_QUALITIES = ['auto', 'high', 'balanced', 'low'];
const VALID_LOG_VERBOSITIES = ['error', 'warn', 'info', 'debug'];
const VALID_SECURITY_LEVELS = ['strict', 'balanced', 'permissive'];
const VALID_NEURAL_VOICES = ['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir'];

function getStorage() {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  if (typeof global !== 'undefined' && (global as any).localStorage) {
    return (global as any).localStorage;
  }
  return null;
}

export const settingsManager = {
  /**
   * Valida e sanitiza um objeto parcial ou corrompido de configurações.
   */
  validateAndSanitize(raw: unknown): SettingsValidationResult {
    const errors: string[] = [];
    const sanitized: GlobalSettings = { ...DEFAULT_SETTINGS };

    if (!raw || typeof raw !== 'object') {
      return {
        isValid: false,
        errors: ['Raw settings is not a valid object. Falling back to defaults.'],
        sanitizedSettings: sanitized
      };
    }

    const obj = raw as Record<string, unknown>;

    // Language
    if (typeof obj.language === 'string' && VALID_LANGUAGES.includes(obj.language)) {
      sanitized.language = obj.language as any;
    } else if (obj.language !== undefined) {
      errors.push(`Invalid language '${obj.language}', defaulted to '${DEFAULT_SETTINGS.language}'.`);
    }

    // Theme
    if (typeof obj.theme === 'string' && VALID_THEMES.includes(obj.theme as ThemeProfile)) {
      sanitized.theme = obj.theme as ThemeProfile;
    } else if (obj.theme !== undefined) {
      errors.push(`Invalid theme '${obj.theme}', defaulted to '${DEFAULT_SETTINGS.theme}'.`);
    }

    // Orb Quality
    if (typeof obj.orbQuality === 'string' && VALID_ORB_QUALITIES.includes(obj.orbQuality)) {
      sanitized.orbQuality = obj.orbQuality as any;
    } else if (obj.orbQuality !== undefined) {
      errors.push(`Invalid orbQuality '${obj.orbQuality}', defaulted to '${DEFAULT_SETTINGS.orbQuality}'.`);
    }

    // TTS Model
    if (typeof obj.ttsModel === 'string') {
      sanitized.ttsModel = obj.ttsModel as any;
    }

    // TTS Voice
    if (typeof obj.ttsVoice === 'string' && VALID_NEURAL_VOICES.includes(obj.ttsVoice)) {
      sanitized.ttsVoice = obj.ttsVoice as any;
    } else if (obj.ttsVoice !== undefined) {
      errors.push(`Invalid ttsVoice '${obj.ttsVoice}', defaulted to '${DEFAULT_SETTINGS.ttsVoice}'.`);
    }

    // Log Verbosity
    if (typeof obj.logVerbosity === 'string' && VALID_LOG_VERBOSITIES.includes(obj.logVerbosity)) {
      sanitized.logVerbosity = obj.logVerbosity as any;
    } else if (obj.logVerbosity !== undefined) {
      errors.push(`Invalid logVerbosity '${obj.logVerbosity}', defaulted to '${DEFAULT_SETTINGS.logVerbosity}'.`);
    }

    // Request Timeout
    if (typeof obj.requestTimeoutMs === 'number' && !isNaN(obj.requestTimeoutMs)) {
      if (obj.requestTimeoutMs >= 1000 && obj.requestTimeoutMs <= 60000) {
        sanitized.requestTimeoutMs = obj.requestTimeoutMs;
      } else {
        errors.push(`requestTimeoutMs ${obj.requestTimeoutMs} out of range [1000, 60000], clamped or defaulted.`);
        sanitized.requestTimeoutMs = Math.max(1000, Math.min(60000, obj.requestTimeoutMs));
      }
    } else if (obj.requestTimeoutMs !== undefined) {
      errors.push(`Invalid requestTimeoutMs type, defaulted to ${DEFAULT_SETTINGS.requestTimeoutMs}.`);
    }

    // Workspace Path
    if (typeof obj.workspacePath === 'string') {
      sanitized.workspacePath = obj.workspacePath;
    }

    // Security Enforcement Level
    if (typeof obj.securityEnforcementLevel === 'string' && VALID_SECURITY_LEVELS.includes(obj.securityEnforcementLevel)) {
      sanitized.securityEnforcementLevel = obj.securityEnforcementLevel as any;
    } else if (obj.securityEnforcementLevel !== undefined) {
      errors.push(`Invalid securityEnforcementLevel, defaulted to '${DEFAULT_SETTINGS.securityEnforcementLevel}'.`);
    }

    // Desktop Notifications
    if (typeof obj.desktopNotifications === 'boolean') {
      sanitized.desktopNotifications = obj.desktopNotifications;
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitizedSettings: sanitized
    };
  },

  /**
   * Carrega configurações do armazenamento com tratamento fail-safe.
   */
  loadSettings(): GlobalSettings {
    const storage = getStorage();
    if (!storage) {
      return { ...DEFAULT_SETTINGS };
    }

    try {
      const raw = storage.getItem(STORAGE_KEY_SETTINGS);
      if (!raw) {
        return { ...DEFAULT_SETTINGS };
      }
      const parsed = JSON.parse(raw);
      const validation = this.validateAndSanitize(parsed);
      if (validation.errors.length > 0) {
        this.saveSettings(validation.sanitizedSettings);
      }
      return validation.sanitizedSettings;
    } catch (e) {
      console.warn('[SettingsManager] Failed to parse stored settings, falling back to defaults:', e);
      this.saveSettings(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
  },

  /**
   * Salva configurações no armazenamento.
   */
  saveSettings(settings: GlobalSettings): void {
    const storage = getStorage();
    if (!storage) return;
    try {
      const validation = this.validateAndSanitize(settings);
      storage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(validation.sanitizedSettings));
      this.applyTheme(validation.sanitizedSettings.theme);
    } catch (e) {
      console.error('[SettingsManager] Failed to save settings:', e);
    }
  },

  /**
   * Aplica variáveis CSS e atributos de tema no documento.
   */
  applyTheme(theme: ThemeProfile): void {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const root = document.documentElement;
    if (typeof root.setAttribute === 'function') {
      root.setAttribute('data-theme', theme);
    }
    if (document.body && typeof document.body.setAttribute === 'function') {
      document.body.setAttribute('data-theme', theme);
    }
    
    if (root.style && typeof root.style.setProperty === 'function') {
      const colors = getThemeColors(theme);
      root.style.setProperty('--accent-primary', colors.hex);
      root.style.setProperty('--accent-glow', colors.glow);
      root.style.setProperty('--accent-bg', colors.bgSubtle);
      root.style.setProperty('--accent-border', colors.borderSubtle);
      root.style.setProperty('--bg-surface', '#0A0A0A');
      root.style.setProperty('--bg-surface-elevated', '#121212');
      root.style.setProperty('--bg-base', '#050505');
    }
  }
};
