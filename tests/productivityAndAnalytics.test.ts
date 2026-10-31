/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { tokenAnalytics } from '../src/services/tokenAnalytics';
import { captureScreen } from '../src/tools/screenCapture';

test('PROD-01: Token Analytics records calls, estimates tokens (~1 per 4 chars), and tracks latency', () => {
  tokenAnalytics.reset();

  let stats = tokenAnalytics.getStats();
  assert.strictEqual(stats.totalTokens, 0);
  assert.strictEqual(stats.geminiCalls, 0);
  assert.strictEqual(stats.openRouterCalls, 0);

  // 40 chars prompt + 120 chars response = 160 chars = ~40 tokens
  tokenAnalytics.recordApiCall('gemini', 40, 120, 250);

  stats = tokenAnalytics.getStats();
  assert.strictEqual(stats.geminiCalls, 1);
  assert.strictEqual(stats.totalCalls, 1);
  assert.strictEqual(stats.totalTokens, 40);
  assert.strictEqual(stats.averageLatencyMs, 250);

  // Record second call via OpenRouter
  tokenAnalytics.recordApiCall('openrouter', 80, 200, 350);
  stats = tokenAnalytics.getStats();
  assert.strictEqual(stats.openRouterCalls, 1);
  assert.strictEqual(stats.totalCalls, 2);
  assert.strictEqual(stats.totalTokens, 110); // 40 + 70 = 110
  assert.strictEqual(stats.latencyHistory.length, 2);
});

test('PROD-02: Screen Capture tool returns base64 JPEG image payload cleanly', async () => {
  const result = await captureScreen();
  assert.ok(result);
  assert.ok(result.base64Data);
  assert.strictEqual(typeof result.base64Data, 'string');
  assert.strictEqual(result.mimeType, 'image/jpeg');
});
