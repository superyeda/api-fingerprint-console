import * as mac from './scheduler-mac.mjs';
import * as windows from './scheduler-windows.mjs';

// These public macOS exports remain stable for existing callers.
export const LABEL = mac.LABEL;
export const buildPlist = mac.buildPlist;

function backend(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return mac;
  if (platform === 'win32') return windows;
  return null;
}

export async function scheduleStatus(options = {}) {
  const implementation = backend(options);
  if (implementation) return implementation.scheduleStatus(options);
  return {
    installed: false, enabled: false, running: false, nextRunAt: null,
    runtimeOutdated: false, message: '原生排程仅支持 macOS 和 Windows 10/11。',
  };
}

export async function enableSchedule(options = {}) {
  const implementation = backend(options);
  if (!implementation) throw new Error('原生排程仅支持 macOS 和 Windows 10/11。');
  return implementation.enableSchedule(options);
}

export async function disableSchedule(options = {}) {
  const implementation = backend(options);
  if (!implementation) throw new Error('原生排程仅支持 macOS 和 Windows 10/11。');
  return implementation.disableSchedule(options);
}
