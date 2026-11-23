/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ThemeProfile = 'crimson' | 'emerald' | 'amber' | 'ice';
export type LogVerbosity = 'error' | 'warn' | 'info' | 'debug';
export type TTSModelChoice = 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts' | 'gemini-3.8-flash' | 'system-speech';

export type NeuralVoiceChoice = 'Aoede' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
export type GestureSensitivityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface GlobalSettings {
  language: 'pt-BR' | 'en-US' | 'es-ES';
  theme: ThemeProfile;
  orbQuality: 'auto' | 'high' | 'balanced' | 'low';
  ttsModel: TTSModelChoice;
  ttsVoice: NeuralVoiceChoice;
  logVerbosity: LogVerbosity;
  requestTimeoutMs: number;
  workspacePath: string;
  securityEnforcementLevel: 'strict' | 'balanced' | 'permissive';
  desktopNotifications: boolean;
  // Visão Computacional, Câmera & Controle por Gestos de Mão
  cameraEnabled?: boolean;
  gestureControlEnabled?: boolean;
  gestureSensitivity?: GestureSensitivityLevel;
  gestureVisualFeedback?: boolean;
  gestureInvertX?: boolean;
  gestureObjectTracking?: boolean;
  // Ajustes de Áudio & Experiência
  speechRate?: number;
  handsFreeVoiceConsent?: boolean;
  // Facilidades do Mestre
  stealthMode?: boolean;
  welcomeGreeting?: boolean;
}

export interface SettingsValidationResult {
  isValid: boolean;
  errors: string[];
  sanitizedSettings: GlobalSettings;
}
