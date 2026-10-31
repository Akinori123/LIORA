/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsManager, DEFAULT_SETTINGS } from '../src/services/settingsManager';
import { getThemeColors, THEME_PALETTES } from '../src/utils/themeColors';
import { ThemeProfile } from '../src/types/settings';

test('Theme System - All 4 theme profiles are defined with valid hex, numeric, and shader vectors', () => {
  const themes: ThemeProfile[] = ['crimson', 'emerald', 'amber', 'ice'];

  for (const t of themes) {
    const config = THEME_PALETTES[t];
    assert.ok(config, `Theme ${t} must exist in THEME_PALETTES`);
    assert.match(config.hex, /^#[0-9a-fA-F]{6}$/, `${t} must have valid 6-char hex`);
    assert.strictEqual(typeof config.num, 'number', `${t} must have numeric hex for Three.js`);
    assert.ok(config.glow.startsWith('rgba('), `${t} glow must be rgba`);
    assert.ok(config.bgSubtle.startsWith('rgba('), `${t} bgSubtle must be rgba`);
    assert.ok(config.borderSubtle.startsWith('rgba('), `${t} borderSubtle must be rgba`);
    
    // Shader vectors must be normalized [0..1]
    assert.strictEqual(config.shaderBase.length, 3);
    assert.strictEqual(config.shaderAccent.length, 3);
    assert.strictEqual(config.shaderHighlight.length, 3);
    for (const val of [...config.shaderBase, ...config.shaderAccent, ...config.shaderHighlight]) {
      assert.ok(val >= 0.0 && val <= 1.0, `Shader vector value ${val} must be in [0..1]`);
    }
  }
});

test('Theme System - getThemeColors returns fallback to crimson for unknown themes', () => {
  const fallback = getThemeColors('unknown' as any);
  assert.strictEqual(fallback.id, 'crimson');
  assert.strictEqual(fallback.hex, '#FF2B2B');
});

test('Theme System - settingsManager validates and sanitizes theme selections', () => {
  // Valid theme
  const res1 = settingsManager.validateAndSanitize({ theme: 'emerald' });
  assert.strictEqual(res1.isValid, true);
  assert.strictEqual(res1.sanitizedSettings.theme, 'emerald');

  // Invalid theme falls back to default crimson
  const res2 = settingsManager.validateAndSanitize({ theme: 'neon-purple' });
  assert.strictEqual(res2.isValid, false);
  assert.strictEqual(res2.sanitizedSettings.theme, 'crimson');
});
