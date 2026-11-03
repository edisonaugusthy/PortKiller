export interface Listener {
  port: number;
  address: string;
}

export interface PortProcess {
  pid: number;
  identity: string;
  name: string;
  app: string;
  project: string;
  executable: string;
  memoryBytes: number | null;
  cpuPercent: number | null;
  /** Unix seconds. */
  startedAt: number;
  /** Seconds since the process last used noticeable CPU, as observed by PortKiller. */
  idleSeconds: number | null;
  listeners: Listener[];
  /** The enclosing `.app` bundle, if any; its icon is shown in the list. */
  bundle: string | null;
}

export interface ProcessDetails {
  command: string;
  cwd: string | null;
}

/** `cpuPercent` uses Activity Monitor's convention: 100% is one fully used core. */
export interface Snapshot { processes: PortProcess[] }
export type Appearance = 'auto' | 'light' | 'dark';
export interface Settings { showCount: boolean; launchAtLogin: boolean; idleMinutes: number; pinned: string[]; appearance: Appearance }
export interface StopOutcome { stopped: boolean }

export interface Backend {
  scan(): Promise<Snapshot>;
  details(process: PortProcess): Promise<ProcessDetails>;
  stop(process: PortProcess, force: boolean): Promise<StopOutcome>;
  /** A data URL of the bundle's icon, or null when it has none. */
  icon(bundle: string): Promise<string | null>;
  settings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;
  openPort(port: number): Promise<void>;
  /** A newer version on GitHub Releases, or null. Checked at most every few hours. */
  updateVersion(): Promise<string | null>;
  /** Downloads, verifies and installs the update, then restarts PortKiller. */
  installUpdate(): Promise<void>;
  ready(): Promise<void>;
  resize(height: number): Promise<void>;
  close(): Promise<void>;
  quit(): Promise<void>;
}
