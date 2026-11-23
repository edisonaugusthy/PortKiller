// Loaded only by Vite's development-only ?demo preview. Never used in the native app.
import type { Backend, PortProcess, Settings } from './types';

type Seed = [app: string, name: string, project: string, executable: string, pid: number, ports: number[], cpu: number, memoryMb: number, uptimeMinutes: number, idleMinutes: number];

const DOCKER = '/Applications/Docker.app/Contents/MacOS/com.docker.backend';

const SEEDS: Seed[] = [
  ['PostgreSQL', 'postgres', 'local', '/opt/homebrew/bin/postgres', 7206, [5432], 0.4, 48, 4320, 0],
  ['Redis', 'redis-server', 'local', '/opt/homebrew/bin/redis-server', 7311, [6379], 0.2, 12, 4320, 0],
  ['Next.js', 'node', 'storefront', '/opt/homebrew/bin/node', 8421, [3000, 9229], 12.4, 312, 134, 0],
  // Docker containers: one row each, all held by the Docker engine (pid 6011).
  ['Docker', 'storefront-mongo-1', 'storefront/mongo', DOCKER, 6011, [27017], 0, 0, 1440, 0],
  ['Docker', 'minio', 'minio', DOCKER, 6011, [9000], 0, 0, 1440, 0],
  ['Vite', 'node', 'PortKiller', '/opt/homebrew/bin/node', 9132, [1420], 3.1, 146, 48, 0],
  ['Uvicorn', 'python3.12', 'storefront/api', '/opt/homebrew/bin/python3', 8510, [8000], 1.8, 82, 130, 0],
  ['Storybook', 'node', 'design-system', '/opt/homebrew/bin/node', 5520, [6006], 0, 290, 2900, 2880],
  ['Webpack', 'node', 'dashboard', '/opt/homebrew/bin/node', 6102, [8081], 0, 240, 400, 360],
  ['node', 'node', 'old-landing', '/opt/homebrew/bin/node', 4410, [3001], 0, 210, 200, 180],
  ['Rails', 'ruby', 'admin', '/opt/homebrew/bin/ruby', 3988, [3002], 0, 188, 1500, 1440],
  ['Python', 'python3.12', 'Downloads', '/opt/homebrew/bin/python3', 7710, [8888], 0, 9, 320, 300],
];

export function demoBackend(): Backend {
  const now = Math.floor(Date.now() / 1000);
  const identity = (seed: Seed): string => seed[3] === DOCKER ? `docker:${seed[1]}` : `demo-${seed[4]}`;
  const toProcess = (seed: Seed): PortProcess => {
    const [app, name, project, executable, pid, ports, , memoryMb, uptimeMinutes, idleMinutes] = seed;
    const container = executable === DOCKER;
    return {
      pid, identity: identity(seed), name, app, project, executable, memoryBytes: container ? null : memoryMb * 1048576, cpuPercent: null,
      startedAt: now - uptimeMinutes * 60, idleSeconds: container ? null : idleMinutes * 60, listeners: ports.map(port => ({port, address: '127.0.0.1'})),
      bundle: executable.includes('.app/') ? executable.slice(0, executable.indexOf('.app/') + 4) : null,
      container: container ? `${pid}${name.length}e3f9a0c2b`.slice(0, 12) : null,
    };
  };
  const seeds = new Map(SEEDS.map(seed => [identity(seed), seed]));
  const params = new URLSearchParams(location.search);
  // `shot` (README screenshots) leaves out PortKiller's own dev server.
  let processes = SEEDS.filter(seed => !params.has('shot') || seed[5][0] !== 1420).map(toProcess);
  if (params.has('dense')) {
    processes.push(...Array.from({length: 16}, (_, index): PortProcess => ({
      pid: 10000 + index, identity: `dense-${index}`, name: 'node', app: 'node',
      project: index === 0 ? 'a-project-with-a-long-name-for-layout-checking' : `service-${index + 1}`,
      executable: '/opt/homebrew/bin/node', memoryBytes: (40 + index * 9) * 1048576, cpuPercent: null, startedAt: now - 7200,
      idleSeconds: index % 3 === 0 ? 4 * 3600 : 0, listeners: [{port: 10000 + index, address: '127.0.0.1'}], bundle: null, container: null,
    })));
  }
  if (params.has('empty')) processes = [];
  let scans = 0;
  let settings: Settings = { showCount: true, launchAtLogin: false, idleMinutes: 30, pinned: ['/opt/homebrew/bin/postgres|local', '/opt/homebrew/bin/redis-server|local'],
    appearance: (['light', 'dark'] as const).find(theme => theme === params.get('theme')) ?? 'auto' };
  return {
    // Like the native scanner, CPU is unknown until a second sample exists.
    scan: async () => {
      // ?loading keeps the first scan pending; ?error makes every scan fail.
      if (params.has('loading')) await new Promise(() => {});
      if (params.has('error')) throw new Error('lsof exited with status 1');
      scans++;
      processes = processes.map(process => {
        const base = seeds.get(process.identity)?.[6] ?? (process.idleSeconds ? 0 : 0.8);
        const cpuPercent = scans < 2 ? null : Math.max(0, base * (0.55 + Math.random() * 0.9));
        const idleSeconds = process.idleSeconds === null ? null : process.idleSeconds > 0 ? process.idleSeconds + 3 : 0;
        return {...process, cpuPercent, idleSeconds};
      });
      return { processes };
    },
    details: async process => ({command: `${process.executable} --port ${process.listeners[0]?.port}`, cwd: process.project === 'local' || process.container ? null : `~/code/${process.project}`}),
    stop: async process => { processes = processes.filter(p => p.identity !== process.identity); return {stopped:true}; },
    // The browser has no app icons, so bundles fall back to their glyph like any other process.
    icon: async () => null,
    settings: async () => settings,
    updateSettings: async next => { settings = next; },
    openPort: async port => { window.open(`http://localhost:${port}`, '_blank'); },
    updateVersion: async () => params.has('update') ? '0.2.0' : null,
    installUpdate: async () => { await new Promise(resolve => setTimeout(resolve, 1500)); },
    ready: async () => {}, resize: async () => {}, close: async () => {}, quit: async () => {},
  };
}
