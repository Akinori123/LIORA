/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { settingsManager, DEFAULT_SETTINGS, STORAGE_KEY_SETTINGS } from '../src/services/settingsManager';

// Mock localStorage for Node.js environment if not present
class LocalStorageMock {
  private store: Record<string, string> = {};

  clear() {
    this.store = {};
  }

  getItem(key: string) {
    return this.store[key] || null;
  }

  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }

  removeItem(key: string) {
    delete this.store[key];
  }
}

if (typeof global !== 'undefined' && !global.localStorage) {
  (global as any).localStorage = new LocalStorageMock();
}

if (typeof document === 'undefined') {
  (global as any).document = {
    documentElement: {
      setAttribute: () => {},
      style: { setProperty: () => {} }
    }
  };
}

test('SET-01: Default settings loading and persistence roundtrip', () => {
  localStorage.clear();

  // Load when empty returns defaults
  const loadedDefault = settingsManager.loadSettings();
  assert.strictEqual(loadedDefault.theme, DEFAULT_SETTINGS.theme);
  assert.strictEqual(loadedDefault.language, DEFAULT_SETTINGS.language);

  // Save modified settings
  const modified = { ...DEFAULT_SETTINGS, theme: 'emerald' as const, requestTimeoutMs: 25000 };
  settingsManager.saveSettings(modified);

  const reloaded = settingsManager.loadSettings();
  assert.strictEqual(reloaded.theme, 'emerald');
  assert.strictEqual(reloaded.requestTimeoutMs, 25000);
});

test('SET-02: Fail-safe automatic recovery (fallback) against corrupted JSON in localStorage', () => {
  localStorage.clear();

  // Inject corrupted JSON string
  localStorage.setItem(STORAGE_KEY_SETTINGS, '{ invalid_json_syntax ...');

  // Load should not throw and should fallback to defaults
  const settings = settingsManager.loadSettings();
  assert.strictEqual(settings.theme, DEFAULT_SETTINGS.theme);
  assert.strictEqual(settings.language, DEFAULT_SETTINGS.language);
});

test('SET-03: Property sanitization and boundary clamping for invalid values', () => {
  localStorage.clear();

  const invalidPayload = {
    theme: 'non_existent_theme',
    language: 'xx-XX',
    requestTimeoutMs: 999999, // out of max bounds (60000)
    desktopNotifications: 'not_a_boolean'
  };

  const validation = settingsManager.validateAndSanitize(invalidPayload);
  assert.strictEqual(validation.isValid, false);
  assert.ok(validation.errors.length > 0);

  // Sanitized should fallback to safe defaults or clamped values
  assert.strictEqual(validation.sanitizedSettings.theme, DEFAULT_SETTINGS.theme);
  assert.strictEqual(validation.sanitizedSettings.language, DEFAULT_SETTINGS.language);
  assert.strictEqual(validation.sanitizedSettings.requestTimeoutMs, 60000); // clamped to max
  assert.strictEqual(validation.sanitizedSettings.desktopNotifications, DEFAULT_SETTINGS.desktopNotifications);
});

test('SET-04: Dynamic theme switching and CSS variable application', () => {
  let appliedTheme = '';
  let cssVarName = '';
  let cssVarVal = '';

  (global as any).document = {
    documentElement: {
      setAttribute: (attr: string, val: string) => {
        if (attr === 'data-theme') appliedTheme = val;
      },
      style: {
        setProperty: (name: string, val: string) => {
          cssVarName = name;
          cssVarVal = val;
        }
      }
    }
  };

  settingsManager.applyTheme('emerald');
  assert.strictEqual(appliedTheme, 'emerald');
  assert.strictEqual(cssVarName, '--accent-primary');
  assert.strictEqual(cssVarVal, '#10b981');

  settingsManager.applyTheme('amber');
  assert.strictEqual(appliedTheme, 'amber');
  assert.strictEqual(cssVarVal, '#f59e0b');
});
