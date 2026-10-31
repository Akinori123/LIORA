/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// src/theme/tokens.ts
export const tokens = {
  colors: {
    background: '#050505',
    surface: '#111111',
    surfaceElevated: '#171717',
    textMain: '#F5F5F5',
    white: '#FFFFFF',
    textSecondary: '#A8A8A8',
    textMuted: '#666666',
    redPrimary: '#FF2B2B',
    redEnergetic: '#FF4A4A',
    redDeep: '#8B0000',
  },
  typography: {
    display: 'Space Grotesk, sans-serif',
    interface: 'Inter, sans-serif',
    mono: 'JetBrains Mono, monospace',
  },
  radius: {
    sm: '4px',
    md: '8px',
    lg: '16px',
    full: '9999px',
  }
} as const;

export type ThemeTokens = typeof tokens;
export default tokens;
