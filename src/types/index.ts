/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export * from '../types';
export * from './automations';
export * from './devices';
export * from './integrations';
export * from './settings';

// Aliases for convenient importing
export type { DeviceEntity as Device } from './devices';
export type { AutomationRule } from './automations';
