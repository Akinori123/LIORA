/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Módulo de Automação IoT & Portão Físico
 *
 * Integração com atuadores locais, Home Assistant, relés HTTP/MQTT
 * e controle seguro de portão de garagem/residencial (R2).
 */

import { ToolDefinition } from '../types';
import { auditLogger } from '../../security/auditLogger';
import { integrationsVault } from '../../services/integrationsVault';

export interface IotDevice {
  id: string;
  name: string;
  type: 'gate' | 'relay' | 'lighting' | 'switch' | 'sensor';
  state: string; // 'OPEN' | 'CLOSED' | 'ON' | 'OFF' | 'TRIGGERED'
  protocol: 'homeassistant' | 'http_webhook' | 'mqtt' | 'simulated';
  endpoint?: string;
  lastAction?: string;
  isSimulated: boolean;
}

/** Tabela padrão de dispositivos IoT da residência */
const DEFAULT_IOT_DEVICES: IotDevice[] = [
  {
    id: 'gate-main',
    name: 'Portão Principal (Eletrônico)',
    type: 'gate',
    state: 'CLOSED',
    protocol: 'http_webhook',
    endpoint: 'http://192.168.1.150/relay/0',
    isSimulated: true
  },
  {
    id: 'gate-garage',
    name: 'Portão da Garagem (Basculante)',
    type: 'gate',
    state: 'CLOSED',
    protocol: 'homeassistant',
    isSimulated: true
  },
  {
    id: 'relay-lighting-external',
    name: 'Iluminação Externa / Jardim',
    type: 'lighting',
    state: 'OFF',
    protocol: 'http_webhook',
    isSimulated: true
  },
  {
    id: 'sensor-gate-presence',
    name: 'Sensor de Presença do Portão',
    type: 'sensor',
    state: 'NORMAL',
    protocol: 'mqtt',
    isSimulated: true
  }
];

// Estado volátil dos dispositivos em memória
const activeDevices = new Map<string, IotDevice>(
  DEFAULT_IOT_DEVICES.map(d => [d.id, { ...d }])
);

/**
 * 1. iot_list_devices (R0)
 * Lista dispositivos IoT conectados na rede local ou configurados.
 */
export const iotListDevicesTool: ToolDefinition<{
  category?: 'all' | 'gate' | 'relay' | 'lighting' | 'sensor';
}, any> = {
  name: 'iot_list_devices',
  description: 'Lista dispositivos IoT e de automação residencial na rede local (portões, relés, luzes, sensores). Risco R0.',
  category: 'automation',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['all', 'gate', 'relay', 'lighting', 'sensor'],
        description: 'Filtro por categoria de dispositivo (padrão: "all").',
        default: 'all'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['devices', 'count', 'simulated']
  },
  execute: async ({ category = 'all' }) => {
    let list = Array.from(activeDevices.values());
    if (category !== 'all') {
      list = list.filter(d => d.type === category);
    }

    return {
      devices: list.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type,
        state: d.state,
        protocol: d.protocol,
        isSimulated: d.isSimulated,
        lastAction: d.lastAction || 'Nenhuma'
      })),
      count: list.length,
      simulated: false
    };
  }
};

/**
 * 2. iot_send_command (R2)
 * Dispara comando para dispositivo IoT físico (ex: acionar relé do portão, luzes).
 * Requer confirmação explícita de risco R2 por se tratar de atuador físico no mundo real.
 */
export const iotSendCommandTool: ToolDefinition<{
  deviceId: string;
  command: 'open_gate' | 'close_gate' | 'toggle_gate' | 'pulse_relay' | 'turn_on' | 'turn_off';
  parameters?: Record<string, any>;
  consentToken?: string;
}, any> = {
  name: 'iot_send_command',
  description: 'Envia um comando acionador para um dispositivo IoT ou relé de portão físico. Risco R2 — requer consentimento explícito.',
  category: 'automation',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: 'Identificador do dispositivo IoT (ex: "gate-main", "gate-garage").'
      },
      command: {
        type: 'string',
        enum: ['open_gate', 'close_gate', 'toggle_gate', 'pulse_relay', 'turn_on', 'turn_off'],
        description: 'Ação física a ser executada no atuador.'
      },
      parameters: {
        type: 'object',
        description: 'Parâmetros opcionais (ex: durationMs: 1500 para pulso de relé).'
      }
    },
    required: ['deviceId', 'command'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'deviceId', 'command', 'simulated']
  },
  execute: async ({ deviceId, command, parameters = {} }) => {
    let device = activeDevices.get(deviceId);
    if (!device) {
      // Se for dispositivo de portão não pré-cadastrado, inicializa dinamicamente
      if (deviceId.toLowerCase().includes('portao') || deviceId.toLowerCase().includes('gate')) {
        device = {
          id: deviceId,
          name: `Portão (${deviceId})`,
          type: 'gate',
          state: 'CLOSED',
          protocol: 'http_webhook',
          isSimulated: true
        };
        activeDevices.set(deviceId, device);
      } else {
        throw new Error(`DEVICE_NOT_FOUND: Dispositivo '${deviceId}' não encontrado no registro IoT.`);
      }
    }

    const haKey = integrationsVault.getRawKey('svc-homeassistant');
    let executedReal = false;
    let newState = device.state;

    // Atualiza estado com base no comando
    if (command === 'open_gate') {
      newState = 'OPEN';
    } else if (command === 'close_gate') {
      newState = 'CLOSED';
    } else if (command === 'toggle_gate') {
      newState = device.state === 'OPEN' ? 'CLOSED' : 'OPEN';
    } else if (command === 'turn_on') {
      newState = 'ON';
    } else if (command === 'turn_off') {
      newState = 'OFF';
    } else if (command === 'pulse_relay') {
      newState = 'TRIGGERED';
    }

    // 1. Tenta envio físico real se houver endpoint configurado e chave
    let actuationError: string | null = null;
    if (device.endpoint && !device.isSimulated && haKey) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(device.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${haKey}`
          },
          body: JSON.stringify({ command, parameters }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (res.ok) {
          executedReal = true;
        } else {
          actuationError = `HTTP ${res.status} do atuador físico`;
        }
      } catch (actErr: any) {
        executedReal = false;
        actuationError = actErr?.name === 'AbortError'
          ? 'TIMEOUT: atuador físico não respondeu em 4s (dispositivo offline?)'
          : `Falha de rede: ${String(actErr?.message || 'conexão recusada').slice(0, 120)}`;
      }
    } else if (device.endpoint && !device.isSimulated && !haKey) {
      actuationError = 'CREDENTIAL_MISSING: dispositivo físico cadastrado mas sem chave do Home Assistant no cofre.';
    }

    // BLINDAGEM CRÍTICA (portão/garagem — segurança física real):
    // Se o dispositivo é um ATUADOR FÍSICO cadastrado (não simulado) e o envio
    // FALHOU, o estado NÃO pode ser alterado na memória nem retornar success.
    // Antes: falha de rede → estado mudava para OPEN mesmo com portão fechado →
    // usuário perguntava 'o portão abriu?' e a LIORA mentia 'sim'. Risco físico real.
    if (!executedReal && actuationError && !device.isSimulated) {
      auditLogger.logEvent({
        auditId: `iot-${Date.now()}`,
        timestamp: new Date().toISOString(),
        eventType: 'SECURITY_VIOLATION',
        toolName: 'iot_send_command',
        riskLevel: 'R2',
        decision: 'DENY',
        denialCode: 'ACTUATOR_UNREACHABLE',
        durationMs: 12,
        sessionId: 'iot-session',
        simulated: false
      } as any);
      return {
        success: false,
        deviceId,
        deviceName: device.name,
        command,
        error: `ACTUATOR_UNREACHABLE: o comando '${command}' NÃO foi executado — ${actuationError}. O estado físico do dispositivo permanece '${device.state}'.`,
        stateUnchanged: true,
        currentState: device.state,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    // Atualiza memória APENAS se a actuação foi real OU o dispositivo é de bancada
    device.state = newState;
    device.lastAction = `${command} (${new Date().toLocaleTimeString('pt-BR')})`;

    // Trilha forense de auditoria
    auditLogger.logEvent({
      auditId: `iot-${Date.now()}`,
      timestamp: new Date().toISOString(),
      eventType: 'PERMISSION_EVALUATION',
      toolName: 'iot_send_command',
      riskLevel: 'R2',
      decision: 'ALLOW',
      durationMs: 12,
      sessionId: 'iot-session',
      simulated: true
    });

    const isSim = !executedReal;
    const msg = isSim
      ? `Comando '${command}' enviado ao atuador de '${device.name}' (Modo Simulado - Nenhum hardware físico conectado). Novo estado: ${newState}.`
      : `Comando '${command}' enviado com sucesso ao atuador físico de '${device.name}'. Novo estado: ${newState}.`;

    return {
      success: true,
      deviceId,
      deviceName: device.name,
      command,
      previousState: device.state,
      newState,
      isRealActuation: executedReal,
      simulated: isSim,
      message: msg,
      timestamp: new Date().toISOString()
    };
  }
};

export const allIotTools: ToolDefinition<any, any>[] = [
  iotListDevicesTool,
  iotSendCommandTool
];
