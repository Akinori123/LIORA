/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cameraInspectObjectTool } from '../src/tools/cameraVisionTool';
import { ToolRegistry } from '../src/tools/registry';

describe('Camera Vision & Object Inspection Tool', () => {
  it('CAM-01: cameraInspectObjectTool possui schema válido e classificação R0', () => {
    assert.equal(cameraInspectObjectTool.name, 'camera_inspect_object');
    assert.equal(cameraInspectObjectTool.riskLevel, 'R0');
    assert.equal(cameraInspectObjectTool.parameters.type, 'object');
    assert.ok(cameraInspectObjectTool.outputSchema);
  });

  it('CAM-02: fora do cliente (server/Node) a ferramenta FALHA de forma honesta, sem fingir captura', async () => {
    // Regressão real: antes retornava `success: true` em ~2ms com uma descrição
    // fictícia ("[Simulado] objeto inspecionado"), e o log reportava
    // "Ferramenta executada: camera_inspect_object | sucesso" sem abrir a câmera.
    const res = await cameraInspectObjectTool.execute({ prompt: 'O que é este objeto?' });
    assert.equal(res.success, false, 'Sem WebView não há como capturar a webcam');
    assert.equal(res.simulated, false, 'Não pode alegar sucesso simulado como se fosse resultado');
    assert.match(String(res.error), /CAPTURE_REQUIRES_CLIENT/);
    assert.equal(res.hasCamera, false);
    assert.equal(res.description, undefined, 'Nunca inventar uma descrição do que não foi visto');
    assert.ok(res.timestamp);
  });

  it('CAM-03: ToolRegistry registra camera_inspect_object com sucesso', () => {
    const registry = new ToolRegistry();
    assert.equal(registry.hasTool('camera_inspect_object'), true);
    const tool = registry.getTool('camera_inspect_object');
    assert.ok(tool);
    assert.equal(tool?.name, 'camera_inspect_object');
  });
});
