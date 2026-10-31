/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MemoryEntry } from '../types';
import { INITIAL_DEVICES_REGISTRY } from '../services/devicesManager';
import { DEFAULT_AUTOMATIONS } from '../services/automationsEngine';

export const defaultMemoryEntries: MemoryEntry[] = [
  { id: 'mem-1', category: 'preference', key: 'idioma', value: 'Português Brasileiro (pt-BR)', confidence: 0.99, updatedAt: '2026-10-29' },
  { id: 'mem-2', category: 'preference', key: 'tema_visual', value: 'Crimson Theme (#050505, #FF2B2B)', confidence: 1.0, updatedAt: '2026-10-29' },
  { id: 'mem-3', category: 'project', key: 'diretorio_workspace', value: '/workspace/liora-core', confidence: 0.95, updatedAt: '2026-10-29' },
  { id: 'mem-4', category: 'routine', key: 'horario_silencioso', value: '23:00 às 07:00', confidence: 0.9, updatedAt: '2026-10-29' }
];

export const defaultDevices = INITIAL_DEVICES_REGISTRY;
export const defaultAutomationRules = DEFAULT_AUTOMATIONS;
