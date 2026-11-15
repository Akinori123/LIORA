export type RuntimeEnvironmentMode =
  | 'tauri-desktop'
  | 'local-desktop'
  | 'web-preview-headless';

export interface RuntimeEnvironmentOverrides {
  platform?: string;
  env?: Record<string, string | undefined>;
  isTauri?: boolean;
}

export interface RuntimeEnvironmentInfo {
  mode: RuntimeEnvironmentMode;
  platform: string;
  isTauri: boolean;
  isDryRun: boolean;
  hasGuiDisplay: boolean;
  webPreviewFallbackActive: boolean;
}

function getSafeEnv(overrides?: RuntimeEnvironmentOverrides): Record<string, string | undefined> {
  if (overrides?.env) return overrides.env;
  if (typeof process !== 'undefined' && process.env) {
    return process.env;
  }
  return {};
}

function getSafePlatform(overrides?: RuntimeEnvironmentOverrides): string {
  if (overrides?.platform) return overrides.platform;
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform;
  }
  return 'browser';
}

function detectTauriRuntime(overrides?: RuntimeEnvironmentOverrides): boolean {
  if (typeof overrides?.isTauri === 'boolean') return overrides.isTauri;
  try {
    if (typeof window !== 'undefined') {
      const w = window as unknown as Record<string, unknown>;
      return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
    }
  } catch {
    // Ignore browser global access issues
  }
  return false;
}

export function isOsDryRun(overrides?: RuntimeEnvironmentOverrides): boolean {
  const env = getSafeEnv(overrides);
  return env.LIORA_NO_BROWSER === '1';
}

export function hasDesktopGuiDisplay(
  platform: string,
  env: Record<string, string | undefined>
): boolean {
  if (platform === 'win32' || platform === 'darwin') {
    return true;
  }
  if (platform === 'linux') {
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }
  return false;
}

export function detectRuntimeEnvironment(
  overrides?: RuntimeEnvironmentOverrides
): RuntimeEnvironmentInfo {
  const env = getSafeEnv(overrides);
  const platform = getSafePlatform(overrides);
  const isTauri = detectTauriRuntime(overrides);
  const isDryRun = isOsDryRun(overrides);
  const hasGuiDisplay = hasDesktopGuiDisplay(platform, env);
  const forceRealOs = env.LIORA_FORCE_REAL_OS === '1';

  const webPreviewFallbackActive =
    !isDryRun && !isTauri && platform === 'linux' && !hasGuiDisplay && !forceRealOs;

  const mode: RuntimeEnvironmentMode = isTauri
    ? 'tauri-desktop'
    : webPreviewFallbackActive
      ? 'web-preview-headless'
      : 'local-desktop';

  return {
    mode,
    platform,
    isTauri,
    isDryRun,
    hasGuiDisplay,
    webPreviewFallbackActive,
  };
}

export function shouldUseWebPreviewDesktopFallback(
  overrides?: RuntimeEnvironmentOverrides
): boolean {
  return detectRuntimeEnvironment(overrides).webPreviewFallbackActive;
}
