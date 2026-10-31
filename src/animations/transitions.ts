/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// src/animations/transitions.ts
export const transitions = {
  springSmooth: {
    type: 'spring',
    damping: 25,
    stiffness: 300,
    mass: 0.8
  },
  springSnappy: {
    type: 'spring',
    damping: 20,
    stiffness: 400
  },
  cubicEaseOut: {
    duration: 0.25,
    ease: [0.16, 1, 0.3, 1]
  },
  fadeIn: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.2 }
  },
  slideUp: {
    initial: { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 16 },
    transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] }
  },
  slideFromRight: {
    initial: { opacity: 0, x: 24 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 24 },
    transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] }
  },
  scalePop: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.95 },
    transition: { duration: 0.2 }
  }
} as const;

export default transitions;
