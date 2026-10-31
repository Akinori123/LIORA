/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OrbShaderConfig {
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  pointLightIntensity: number;
  emissiveIntensity: {
    IDLE: number;
    LISTENING: number;
    THINKING: number;
    SPEAKING: number;
    PROCESSING: number;
    ERROR: number;
  };
  colors: {
    primaryCrimson: string;
    energeticRed: string;
    deepRed: string;
    ambientDark: string;
  };
}

export const orbConfig: OrbShaderConfig = {
  bloomStrength: 0.7,
  bloomRadius: 0.35,
  bloomThreshold: 0.85,
  pointLightIntensity: 3.5,
  emissiveIntensity: {
    IDLE: 0.35,
    LISTENING: 0.65,
    THINKING: 0.85,
    SPEAKING: 0.95,
    PROCESSING: 0.75,
    ERROR: 0.8
  },
  colors: {
    primaryCrimson: '#FF2B2B',
    energeticRed: '#FF4A4A',
    deepRed: '#8B0000',
    ambientDark: '#050505'
  }
};

export default orbConfig;
