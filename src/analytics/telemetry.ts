type EnvValue = string | boolean | undefined;
type ImportMetaWithEnv = ImportMeta & { env?: Record<string, EnvValue> };

// Injected via vite.config.ts `define` for the browser bundle. `import.meta.env`
// isn't usable there: the iife build target replaces `import.meta` wholesale
// with `{}` (rolldown-vite doesn't polyfill it outside esm output), so a
// build-time global is the only way to get this value into that bundle.
// `typeof` on an undeclared identifier can't throw, so this stays a no-op
// where the define isn't injected (e.g. the Workers/esbuild bundle).
declare const __PROOF_APP_VERSION__: string | undefined;

type TelemetryConfig = {
  windowId?: string;
  documentId?: string;
};

function readNonEmptyString(value: EnvValue): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const injectedAppVersion =
  typeof __PROOF_APP_VERSION__ !== 'undefined' ? __PROOF_APP_VERSION__ : undefined;
const env = (import.meta as ImportMetaWithEnv).env ?? {};

const APP_VERSION =
  readNonEmptyString(injectedAppVersion) ?? readNonEmptyString(env.VITE_APP_VERSION) ?? 'dev';

export function isTelemetryEnabled(): boolean {
  return false;
}

export function initTelemetry(_config: TelemetryConfig = {}): void {
  void APP_VERSION;
}

export function captureEvent(_event: string, _properties?: Record<string, unknown>): void {
  // OSS default: no telemetry.
}
