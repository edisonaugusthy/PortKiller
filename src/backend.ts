import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Backend, ProcessDetails, Settings, Snapshot, StopOutcome } from './types';

export async function createBackend(): Promise<Backend> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    document.body.classList.add('browser-preview');
    return (await import('./demo')).demoBackend();
  }
  if (!isTauri()) {
    throw new Error('Open PortKiller from the macOS menu bar to see your ports.');
  }
  return {
    scan: () => invoke<Snapshot>('scan_ports'),
    details: process => invoke<ProcessDetails>('process_details', { pid: process.pid, identity: process.identity }),
    stop: (process, force) => invoke<StopOutcome>('stop_process', {
      pid: process.pid, identity: process.identity,
      ports: [...new Set(process.listeners.map(listener => listener.port))], force,
    }),
    icon: bundle => invoke<string | null>('app_icon', { bundle }),
    settings: () => invoke<Settings>('get_settings'),
    updateSettings: settings => invoke('set_settings', { settings }),
    openPort: port => invoke('open_port', { port }),
    ready: async () => {
      const geometry = await invoke<{maxHeight: number}>('menu_ready');
      document.documentElement.style.setProperty('--max-menu-height', `${geometry.maxHeight}px`);
    },
    resize: height => invoke('resize_menu', { height }),
    close: () => invoke('close_menu'),
    quit: () => invoke('quit_app'),
  };
}
