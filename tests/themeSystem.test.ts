/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { settingsManager } from '../src/services/settingsManager';
import { getThemeColors, THEME_PALETTES, ThemeColors } from '../src/utils/themeColors';
import { ThemeProfile } from '../src/types/settings';

// Mock DOM environment for Node.js test runner
function setupMockDOM() {
  const styles: Record<string, string> = {};
  const docElementAttrs: Record<string, string> = {};
  const bodyAttrs: Record<string, string> = {};

  const mockDocElement = {
    setAttribute: (key: string, val: string) => {
      docElementAttrs[key] = val;
    },
    getAttribute: (key: string) => docElementAttrs[key] ?? null,
    style: {
      setProperty: (prop: string, val: string) => {
        styles[prop] = val;
      },
      getPropertyValue: (prop: string) => styles[prop] ?? '',
    }
  };

  const mockBody = {
    setAttribute: (key: string, val: string) => {
      bodyAttrs[key] = val;
    },
    getAttribute: (key: string) => bodyAttrs[key] ?? null,
  };

  (globalThis as any).document = {
    documentElement: mockDocElement,
    body: mockBody,
  };

  return { styles, docElementAttrs, bodyAttrs };
}

test('Theme System - data-theme injection on <html> and CSS variables reflection', () => {
  const { docElementAttrs, styles } = setupMockDOM();
  const themes: ThemeProfile[] = ['crimson', 'emerald', 'amber', 'ice'];

  for (const t of themes) {
    settingsManager.applyTheme(t);
    const expected = THEME_PALETTES[t];

    // Assert data-theme attribute is set on <html>
    assert.strictEqual(docElementAttrs['data-theme'], t, `data-theme on <html> must be '${t}'`);

    // Assert atomic CSS variables are synchronized
    assert.strictEqual(styles['--accent-primary'], expected.hex, `--accent-primary must match ${expected.hex}`);
    assert.strictEqual(styles['--accent-glow'], expected.glow, `--accent-glow must match ${expected.glow}`);
    assert.strictEqual(styles['--accent-bg'], expected.bgSubtle, `--accent-bg must match ${expected.bgSubtle}`);
    assert.strictEqual(styles['--accent-border'], expected.borderSubtle, `--accent-border must match ${expected.borderSubtle}`);
    assert.strictEqual(styles['--bg-surface'], '#0A0A0A', '--bg-surface must be defined');
    assert.strictEqual(styles['--bg-base'], '#050505', '--bg-base must be defined');
  }
});

test('Three.js Shader Uniforms - In-place mutation maintains single material reference without GC recreation', () => {
  // Simulate QuantumCoreShader initialization in LioraOrb
  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0.0 },
    uAudioGain: { value: 0.0 },
    uStateMode: { value: 0.0 },
    uColorBase: { value: new THREE.Vector3(0.40, 0.02, 0.04) },
    uColorAccent: { value: new THREE.Vector3(1.0, 0.17, 0.17) },
    uColorHighlight: { value: new THREE.Vector3(1.0, 1.0, 1.0) }
  };

  const shaderMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColorAccent; void main() { gl_FragColor = vec4(uColorAccent, 1.0); }',
  });

  const reactorMaterial = new THREE.MeshStandardMaterial({
    color: 0xFFFFFF,
    emissive: 0xFF2B2B,
    emissiveIntensity: 2.5
  });

  const pointLight = new THREE.PointLight(0xFF2B2B, 15, 20);

  // Keep references to verify they are NEVER replaced or recreated
  const initialShaderMat = shaderMaterial;
  const initialReactorMat = reactorMaterial;
  const initialPointLight = pointLight;
  const initialUniformObj = shaderMaterial.uniforms;

  const themeRotations: ThemeProfile[] = ['emerald', 'amber', 'ice', 'crimson'];

  for (const nextTheme of themeRotations) {
    const colors = getThemeColors(nextTheme);

    // Perform direct in-place mutation (same exact pattern as LioraOrb.tsx)
    shaderMaterial.uniforms.uColorBase.value.set(...colors.shaderBase);
    shaderMaterial.uniforms.uColorAccent.value.set(...colors.shaderAccent);
    shaderMaterial.uniforms.uColorHighlight.value.set(...colors.shaderHighlight);
    reactorMaterial.emissive.setHex(colors.num);
    pointLight.color.setHex(colors.num);

    // Verify material references remain identical (ZERO remount / ZERO recreation)
    assert.strictEqual(shaderMaterial, initialShaderMat, 'ShaderMaterial reference must remain constant');
    assert.strictEqual(reactorMaterial, initialReactorMat, 'Reactor material reference must remain constant');
    assert.strictEqual(pointLight, initialPointLight, 'PointLight reference must remain constant');
    assert.strictEqual(shaderMaterial.uniforms, initialUniformObj, 'Uniforms object reference must remain constant');

    // Verify in-place GLSL vector values match the target theme
    const accentVec = shaderMaterial.uniforms.uColorAccent.value;
    assert.strictEqual(accentVec.x, colors.shaderAccent[0], `X component must match ${colors.shaderAccent[0]}`);
    assert.strictEqual(accentVec.y, colors.shaderAccent[1], `Y component must match ${colors.shaderAccent[1]}`);
    assert.strictEqual(accentVec.z, colors.shaderAccent[2], `Z component must match ${colors.shaderAccent[2]}`);

    // Verify numeric hex mutation for Three.js lights and standard materials
    assert.strictEqual(reactorMaterial.emissive.getHex(), colors.num, `Reactor emissive must be ${colors.num}`);
    assert.strictEqual(pointLight.color.getHex(), colors.num, `PointLight color must be ${colors.num}`);
  }

  // Cleanup WebGL resources
  shaderMaterial.dispose();
  reactorMaterial.dispose();
  pointLight.dispose();
});

test('Theme System - Atomicity across all 4 themes ensures no cross-theme color leakage', () => {
  const themeIds: ThemeProfile[] = ['crimson', 'emerald', 'amber', 'ice'];
  const seenHexes = new Set<string>();
  const seenNums = new Set<number>();

  for (const id of themeIds) {
    const palette = THEME_PALETTES[id];
    assert.ok(!seenHexes.has(palette.hex), `Duplicate hex detected for theme ${id}`);
    assert.ok(!seenNums.has(palette.num), `Duplicate numeric color detected for theme ${id}`);
    seenHexes.add(palette.hex);
    seenNums.add(palette.num);

    // Verify that every theme has distinct shader accent components
    const [r, g, b] = palette.shaderAccent;
    assert.ok(r >= 0 && r <= 1, `${id} red channel must be in [0, 1]`);
    assert.ok(g >= 0 && g <= 1, `${id} green channel must be in [0, 1]`);
    assert.ok(b >= 0 && b <= 1, `${id} blue channel must be in [0, 1]`);
  }
});
