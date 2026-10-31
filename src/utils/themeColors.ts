/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ThemeProfile } from '../types/settings';

export interface ThemeColors {
  id: ThemeProfile;
  label: string;
  desc: string;
  hex: string;
  num: number;
  glow: string;
  bgSubtle: string;
  borderSubtle: string;
  // Normalized RGB for WebGL shaders (0.0 to 1.0)
  shaderBase: [number, number, number];
  shaderAccent: [number, number, number];
  shaderHighlight: [number, number, number];
}

export const THEME_PALETTES: Record<ThemeProfile, ThemeColors> = {
  crimson: {
    id: 'crimson',
    label: 'Crimson Red',
    desc: 'Identidade visual padrão LIORA (Alta performance)',
    hex: '#FF2B2B',
    num: 0xFF2B2B,
    glow: 'rgba(255, 43, 43, 0.25)',
    bgSubtle: 'rgba(255, 43, 43, 0.1)',
    borderSubtle: 'rgba(255, 43, 43, 0.3)',
    shaderBase: [0.40, 0.02, 0.04],
    shaderAccent: [1.0, 0.17, 0.17],
    shaderHighlight: [1.0, 1.0, 1.0],
  },
  emerald: {
    id: 'emerald',
    label: 'Emerald Sec',
    desc: 'Foco em auditoria e segurança corporativa',
    hex: '#10b981',
    num: 0x10b981,
    glow: 'rgba(16, 185, 129, 0.25)',
    bgSubtle: 'rgba(16, 185, 129, 0.1)',
    borderSubtle: 'rgba(16, 185, 129, 0.3)',
    shaderBase: [0.02, 0.24, 0.16],
    shaderAccent: [0.06, 0.72, 0.50],
    shaderHighlight: [0.85, 1.0, 0.92],
  },
  amber: {
    id: 'amber',
    label: 'Amber Telemetry',
    desc: 'Monitoramento de hardware e dispositivos IoT',
    hex: '#f59e0b',
    num: 0xf59e0b,
    glow: 'rgba(245, 158, 11, 0.25)',
    bgSubtle: 'rgba(245, 158, 11, 0.1)',
    borderSubtle: 'rgba(245, 158, 11, 0.3)',
    shaderBase: [0.36, 0.22, 0.01],
    shaderAccent: [0.96, 0.62, 0.04],
    shaderHighlight: [1.0, 0.95, 0.8],
  },
  ice: {
    id: 'ice',
    label: 'Ice Dev',
    desc: 'Ambiente analítico para desenvolvedores',
    hex: '#38bdf8',
    num: 0x38bdf8,
    glow: 'rgba(56, 189, 248, 0.25)',
    bgSubtle: 'rgba(56, 189, 248, 0.1)',
    borderSubtle: 'rgba(56, 189, 248, 0.3)',
    shaderBase: [0.04, 0.23, 0.33],
    shaderAccent: [0.22, 0.74, 0.97],
    shaderHighlight: [0.85, 0.95, 1.0],
  },
};

export function getThemeColors(theme: ThemeProfile = 'crimson'): ThemeColors {
  return THEME_PALETTES[theme] || THEME_PALETTES.crimson;
}
