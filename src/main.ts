import { createElement, Search, Settings2, CircleStop, ChevronLeft, Pin, Copy, Check, X } from 'lucide';
import { createBackend } from './backend';
import type { Backend, PortProcess, ProcessDetails, Settings } from './types';
import './style.css';

const icons = { search: Search, settings: Settings2, stop: CircleStop, back: ChevronLeft, pin: Pin, copy: Copy, check: Check, close: X };
/** The app's own mark, the same socket as the menu bar glyph. */
const SOCKET = '<svg class="socket" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M9.5 9.5v5M14.5 9.5v5"/></svg>';
type IconName = keyof typeof icons;
const icon = (name: IconName, extra = ''): string => createElement(icons[name], { width: 16, height: 16, 'aria-hidden': 'true', class: extra }).outerHTML;
const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const app = document.querySelector<HTMLElement>('#app')!;

const IDLE_CHOICES = [15, 30, 60, 180, 720];
/** Windows gets its own look and words; it has one End task action and no menu bar count. */
const WINDOWS = navigator.userAgent.includes('Windows') || (import.meta.env.DEV && new URLSearchParams(location.search).has('windows'));
if (WINDOWS) document.documentElement.dataset.platform = 'windows';
const WORDS = WINDOWS
  ? { stop: 'End', stopButton: 'End task', stopAll: 'End all', stopping: 'Ending…', stopped: 'Ended', stopHint: 'End task', login: 'Start with Windows', quit: 'Exit PortKiller' }
  : { stop: 'Stop', stopButton: 'Stop', stopAll: 'Stop all', stopping: 'Stopping…', stopped: 'Stopped', stopHint: 'Stop · ⌥ Force quit', login: 'Open at login', quit: 'Quit PortKiller' };
/** The port of the server this page comes from (the dev server in `tauri dev`). Stopping it closes PortKiller. */
const OWN_PORT = location.protocol.startsWith('http') && location.port ? Number(location.port) : null;
/** Ports that are not web pages, so they get Copy but no Open. */
const NOT_WEB = new Set([5432, 3306, 6379, 27017, 9229, 9222, 11211]);
/** Glyphs for command-line servers, which have no app icon of their own. */
const GLYPHS: [RegExp, string, string][] = [
  [/^next/, 'N', '#18181b'], [/^vite/, 'V', '#7c5cff'], [/^(node|bun|deno)/, 'JS', '#3c873a'],
  [/^(python|uvicorn|django|gunicorn)/, 'Py', '#3572a5'], [/^(rails|ruby|puma)/, 'Rb', '#b52e31'],
  [/^postgres/, 'Pg', '#336791'], [/^redis/, 'Re', '#c6302b'], [/^mysql/, 'My', '#00758f'], [/^mongo/, 'Mg', '#3f9142'],
  [/^docker/, 'D', '#1d63ed'], [/^webpack/, 'W', '#2b7bd4'], [/^storybook/, 'S', '#e0437a'], [/^(java|gradle)/, 'Jv', '#b07219'],
];

type View = { kind: 'list' } | { kind: 'settings' } | { kind: 'detail'; identity: string };

let backend: Backend;
let processes: PortProcess[] = [];
let view: View = { kind: 'list' };
let pending: { process: PortProcess; force: boolean } | null = null;
let pendingIdle: PortProcess[] | null = null;
let query = '';
let settings: Settings = { showCount: true, launchAtLogin: false, idleMinutes: 30, pinned: [], appearance: 'auto' };
let error = '';
let notice = '';
let copiedPort: number | null = null;
let loading = true;
let scanning = false;
let stopping = false;
let settingsSaving = false;
let disposed = false;
let scans = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let scheduledRender = false;
let lastHtml = '';
const details = new Map<string, ProcessDetails | 'loading' | 'error'>();
/** Bundle path → icon data URL, null when it has none, or 'loading'. Lives only while the menu is open. */
const appIcons = new Map<string, string | null | 'loading'>();

// Formatting

function ports(process: PortProcess): number[] { return [...new Set(process.listeners.map(listener => listener.port))].sort((a, b) => a - b); }
function portList(process: PortProcess): string {
  const list = ports(process).map(port => `:${port}`);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list.join('');
}
function title(process: PortProcess): string { return process.project && process.project !== 'local' ? process.project : process.app; }
function percent(value: number | null): string { return value === null ? '–' : value < 0.05 ? '0%' : `${value.toFixed(1)}%`; }
function bytes(value: number | null): string {
  if (value === null) return '–';
  const mb = value / 1048576;
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}
function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 && hours < 10 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
function shortPath(path: string): string { return path.replace(/^\/Users\/[^/]+/, '~'); }

// Grouping

function pinKey(process: PortProcess): string { return `${process.executable}|${process.project}`; }
function isPinned(process: PortProcess): boolean { return settings.pinned.includes(pinKey(process)); }
function isOwn(process: PortProcess): boolean { return OWN_PORT !== null && ports(process).includes(OWN_PORT); }
/** PortKiller's own server is never idle, so Stop all cannot close the app. */
function isIdle(process: PortProcess): boolean {
  return !isPinned(process) && !isOwn(process) && process.idleSeconds !== null && process.idleSeconds >= settings.idleMinutes * 60;
}
function stopQuestion(process: PortProcess, force: boolean): string {
  return `${force ? 'Force quit' : WORDS.stop} ${portList(process)}${isOwn(process) ? ' and close PortKiller' : ''}?`;
}
function matches(process: PortProcess, needle: string): boolean {
  if (!needle) return true;
  return [process.app, process.name, process.project, process.pid, ...ports(process).map(port => `:${port}`)].join(' ').toLowerCase().includes(needle);
}
function find(identity: string): PortProcess | undefined { return processes.find(process => process.identity === identity); }

// Rendering

function processIcon(process: PortProcess, extra = ''): string {
  return isOwn(process) ? `<span class="icon own ${extra}" aria-hidden="true">${SOCKET}</span>` : appIcon(process.app, process.bundle, extra);
}

function appIcon(app: string, bundle: string | null, extra = ''): string {
  const image = bundle ? appIcons.get(bundle) : undefined;
  if (bundle && image === undefined) void loadIcon(bundle);
  if (typeof image === 'string' && image !== 'loading') return `<img class="icon ${extra}" src="${esc(image)}" alt="">`;
  const name = app.toLowerCase();
  const [, glyph, color] = GLYPHS.find(([pattern]) => pattern.test(name)) ?? [null, (app.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase(), '#6b7280'];
  return `<span class="icon ${extra}" style="--tile:${color}" aria-hidden="true">${esc(glyph)}</span>`;
}

function round(name: IconName, label: string, attributes = '', extra = ''): string {
  return `<button class="round ${extra}" aria-label="${esc(label)}" title="${esc(label)}" ${attributes}>${icon(name)}</button>`;
}

function confirmBox(question: string, force: boolean, action: string, label = WORDS.stopButton): string {
  const busy = stopping ? 'disabled' : '';
  return `<strong>${esc(question)}</strong><button class="text-button" data-action="cancel" ${busy}>Cancel</button><button class="danger" data-action="${action}" ${busy}>${stopping ? WORDS.stopping : force ? 'Force quit' : label}</button>`;
}

function row(process: PortProcess): string {
  const list = ports(process);
  if (pending?.process.identity === process.identity) {
    return `<div class="row"><div class="confirm" role="alertdialog" aria-label="Confirm stop">${processIcon(process)}${confirmBox(stopQuestion(process, pending.force), pending.force, 'confirm')}</div></div>`;
  }
  const doomed = pendingIdle?.some(item => item.identity === process.identity);
  const more = list.length > 1 ? `<span class="more" title="${esc(list.slice(1).map(port => `:${port}`).join(', '))}">+${list.length - 1}</span>` : '';
  return `<div class="row ${isIdle(process) ? 'idle' : ''} ${doomed ? 'doomed' : ''}">
    <button class="open" data-action="open" data-id="${esc(process.identity)}" aria-label="${esc(`${title(process)}, port ${list[0]}`)}">
      ${processIcon(process)}<span class="name">${esc(isOwn(process) ? 'PortKiller' : title(process))}</span>${isPinned(process) ? icon('pin', 'pinned') : ''}<span class="port">:${list[0]}${more}</span>
    </button>
    <button class="stop" data-action="stop" data-id="${esc(process.identity)}" aria-label="${esc(stopQuestion(process, false).slice(0, -1))}" title="${WORDS.stopHint}" ${stopping ? 'disabled' : ''}>${icon(WINDOWS ? 'close' : 'stop')}</button>
  </div>`;
}

function listView(): string {
  const needle = query.trim().toLowerCase();
  const visible = processes.filter(process => matches(process, needle));
  const running = visible.filter(process => !isIdle(process)).sort((a, b) => Number(isOwn(a)) - Number(isOwn(b)) || Number(isPinned(b)) - Number(isPinned(a)) || ports(a)[0] - ports(b)[0]);
  const idle = visible.filter(isIdle).sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));
  const section = (name: string, list: PortProcess[], action = ''): string => list.length
    ? `<section aria-label="${name}"><div class="section-head"><span>${name}</span>${action}</div>${list.map(row).join('')}</section>` : '';
  const stopAll = `<button class="pill ${pendingIdle ? 'armed' : ''}" data-action="stop-idle" ${stopping || pendingIdle ? 'disabled' : ''}>${WORDS.stopAll}</button>`;
  const body = loading
    ? Array.from({length: 4}, () => `<div class="row skeleton" aria-hidden="true"><span class="icon"></span><i></i></div>`).join('')
    : visible.length ? section('Running', running) + section('Idle', idle, stopAll)
    : query ? `<p class="empty">No results</p>`
    : error ? '' : `<div class="empty">${SOCKET}<span>No open ports</span></div>`;
  return `<div class="top"><label class="search">${icon('search')}<input id="search" aria-label="Search" placeholder="Search" value="${esc(query)}" autocomplete="off" spellcheck="false"></label>${round('settings', 'Settings', 'data-action="settings"')}</div>
    <div class="list">${body}</div>${bars()}`;
}

function bars(): string {
  if (error) return `<div class="bar error" role="alert">${esc(error)}</div>`;
  if (pendingIdle) return `<div class="bar" role="alertdialog" aria-label="Confirm stop all idle">${confirmBox(`${WORDS.stop} ${pendingIdle.length} idle app${pendingIdle.length === 1 ? '' : 's'}?`, false, 'confirm-idle', WINDOWS ? WORDS.stopAll : WORDS.stopButton)}</div>`;
  if (notice) return `<div class="bar notice" role="status">${icon('check', 'ok')}<span>${esc(notice)}</span></div>`;
  return '';
}

function detailView(process: PortProcess): string {
  const info = details.get(process.identity);
  const folder = info === undefined || info === 'loading' ? '…' : info === 'error' || !info.cwd ? '–' : shortPath(info.cwd);
  const command = info && typeof info === 'object' ? info.command : '';
  const pinned = isPinned(process);
  const idle = isIdle(process);
  const portRows = ports(process).map(port => `<div class="port-row"><dt>:${port}</dt><dd>${NOT_WEB.has(port) ? '' : `<button class="chip" data-action="open-port" data-port="${port}">Open</button>`}${round(copiedPort === port ? 'check' : 'copy', `Copy localhost:${port}`, `data-action="copy" data-port="${port}"`, 'quiet')}</dd></div>`).join('');
  const property = (key: string, value: string, hint = ''): string => `<div class="prop"><dt>${key}</dt><dd ${hint ? `title="${esc(hint)}"` : ''}>${esc(value)}</dd></div>`;
  const action = pending?.process.identity === process.identity
    ? `<div class="confirm" role="alertdialog" aria-label="Confirm stop">${confirmBox(stopQuestion(process, pending.force), pending.force, 'confirm')}</div>`
    : `<button class="danger wide" data-action="stop" data-id="${esc(process.identity)}" title="${WORDS.stopHint}" ${stopping ? 'disabled' : ''}>${WORDS.stopButton}</button>`;
  return `<header class="header">${round('back', 'Back', 'data-action="back"')}${processIcon(process, 'large')}<h1>${esc(isOwn(process) ? 'PortKiller' : title(process))}</h1>${round('pin', pinned ? 'Unpin' : 'Pin', `data-action="pin" data-id="${esc(process.identity)}" aria-pressed="${pinned}" ${settingsSaving ? 'disabled' : ''}`, pinned ? 'on' : '')}</header>
    <dl class="detail">${portRows}${property('App', process.app)}${property('CPU', percent(idle ? 0 : process.cpuPercent), '100% is one core, as in Activity Monitor')}${property('Memory', bytes(process.memoryBytes))}${idle ? property('Idle', duration(process.idleSeconds ?? 0)) : property('Uptime', duration(Date.now() / 1000 - process.startedAt))}${property('Folder', folder, command)}</dl>
    ${error ? bars() : `<div class="actions">${action}</div>`}`;
}

function settingsView(): string {
  const busy = settingsSaving ? 'disabled' : '';
  const options = IDLE_CHOICES.map(minutes => `<option value="${minutes}" ${settings.idleMinutes === minutes ? 'selected' : ''}>${minutes < 60 ? `${minutes} min` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`}</option>`).join('');
  // A segmented control on macOS; a drop-down, as in Windows Settings, on Windows.
  const appearance = WINDOWS
    ? `<select data-appearance aria-label="Appearance" ${busy}>${(['auto', 'light', 'dark'] as const).map(value => `<option value="${value}" ${settings.appearance === value ? 'selected' : ''}>${value === 'auto' ? 'System' : `${value[0].toUpperCase()}${value.slice(1)}`}</option>`).join('')}</select>`
    : `<div class="segmented" role="group" aria-label="Appearance">${(['auto', 'light', 'dark'] as const).map(value => `<button data-action="appearance" data-value="${value}" aria-pressed="${settings.appearance === value}" ${busy}>${value[0].toUpperCase()}${value.slice(1)}</button>`).join('')}</div>`;
  const pins = settings.pinned.map((key, index) => {
    const [executable, project] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];
    const running = processes.find(process => pinKey(process) === key);
    const name = running ? title(running) : project && project !== 'local' ? project : executable.split('/').pop() ?? key;
    return `<div class="pin-row">${appIcon(running?.app ?? name, running?.bundle ?? null)}<span class="name">${esc(name)}</span>${round('close', `Unpin ${name}`, `data-action="unpin" data-index="${index}" ${busy}`, 'quiet')}</div>`;
  }).join('');
  return `<header class="header">${round('back', 'Back', 'data-action="back"')}<h1>Settings</h1></header>
    <div class="settings">
      <label class="setting"><span>${WORDS.login}</span><input type="checkbox" role="switch" class="switch" data-login ${settings.launchAtLogin ? 'checked' : ''} ${busy}></label>
      ${WINDOWS ? '' : `<label class="setting"><span>Count in menu bar</span><input type="checkbox" role="switch" class="switch" data-count ${settings.showCount ? 'checked' : ''} ${busy}></label>`}
      <label class="setting"><span>Idle after</span><select data-idle ${busy}>${options}</select></label>
      <div class="setting"><span>Appearance</span>${appearance}</div>
      ${pins ? `<section class="pins" aria-label="Pinned"><div class="section-head"><span>Pinned</span></div>${pins}</section>` : ''}
    </div>
    ${error ? bars() : ''}<div class="actions"><button class="chip wide" data-action="quit">${WORDS.quit}</button></div>`;
}

function render(): void {
  if (disposed) return;
  if (view.kind === 'detail' && !find(view.identity)) { view = { kind: 'list' }; pending = null; }
  const content = view.kind === 'settings' ? settingsView() : view.kind === 'detail' ? detailView(find(view.identity)!) : listView();
  const html = `<section class="panel" aria-label="PortKiller">${content}</section>`;
  // Most scans change nothing the list shows, so the DOM is left alone.
  if (html === lastHtml) return;
  lastHtml = html;
  const focused = document.activeElement as HTMLElement | null;
  const editing = focused instanceof HTMLInputElement && focused.id === 'search';
  const caret = editing ? focused.selectionStart : null;
  const focusKey = !editing && focused?.dataset.action ? `[data-action="${focused.dataset.action}"]${focused.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : ''}${focused.dataset.port ? `[data-port="${focused.dataset.port}"]` : ''}` : '';
  const scrollTop = app.querySelector('.list, .detail, .settings')?.scrollTop ?? 0;
  app.innerHTML = html;
  bindInputs();
  const scroller = app.querySelector<HTMLElement>('.list, .detail, .settings');
  if (scroller) scroller.scrollTop = scrollTop;
  if (editing) {
    const input = document.querySelector<HTMLInputElement>('#search');
    input?.focus();
    if (caret !== null) input?.setSelectionRange(caret, caret);
  } else if (focusKey) {
    app.querySelector<HTMLElement>(focusKey)?.focus();
  }
}
function scheduleRender(): void {
  if (scheduledRender || disposed) return;
  scheduledRender = true;
  requestAnimationFrame(() => { scheduledRender = false; render(); });
}
function focusSearch(): void { document.querySelector<HTMLInputElement>('#search')?.focus(); }
function flash(message: string): void {
  notice = message; clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice = ''; scheduleRender(); }, 4000);
}
function go(next: View): void { view = next; pending = null; pendingIdle = null; error = ''; render(); }
function applyAppearance(): void {
  if (settings.appearance === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.appearance;
}

// Actions

function bindInputs(): void {
  const search = app.querySelector<HTMLInputElement>('#search');
  if (search) search.oninput = () => { query = search.value; pendingIdle = null; render(); };
  const login = app.querySelector<HTMLInputElement>('[data-login]');
  if (login) login.onchange = () => { void saveSettings({...settings, launchAtLogin: login.checked}); };
  const count = app.querySelector<HTMLInputElement>('[data-count]');
  if (count) count.onchange = () => { void saveSettings({...settings, showCount: count.checked}); };
  const appearance = app.querySelector<HTMLSelectElement>('[data-appearance]');
  if (appearance) appearance.onchange = () => { void saveSettings({...settings, appearance: appearance.value as Settings['appearance']}); };
  const idle = app.querySelector<HTMLSelectElement>('[data-idle]');
  if (idle) idle.onchange = () => { void saveSettings({...settings, idleMinutes: Number(idle.value)}); };
}

app.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!target || (target as HTMLButtonElement).disabled) return;
  const process = target.dataset.id ? find(target.dataset.id) : undefined;
  const port = Number(target.dataset.port);
  switch (target.dataset.action) {
    case 'settings': go({ kind: 'settings' }); break;
    case 'back': go({ kind: 'list' }); break;
    case 'quit': void backend.quit().catch(reason => { error = String(reason); render(); }); break;
    case 'open':
      if (!process) return;
      go({ kind: 'detail', identity: process.identity });
      void loadDetails(process);
      break;
    case 'stop':
      if (!process) return;
      pending = { process: structuredClone(process), force: !WINDOWS && (event as MouseEvent).altKey };
      pendingIdle = null; error = ''; notice = ''; render();
      app.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.focus();
      break;
    case 'stop-idle':
      // Only the idle apps the current search shows.
      pendingIdle = structuredClone(processes.filter(process => isIdle(process) && matches(process, query.trim().toLowerCase())));
      pending = null; error = ''; notice = ''; render();
      app.querySelector<HTMLButtonElement>('[data-action="confirm-idle"]')?.focus();
      break;
    case 'cancel': pending = null; pendingIdle = null; render(); break;
    case 'confirm': void stopPending(); break;
    case 'confirm-idle': void stopIdle(); break;
    case 'pin': if (process) void togglePin(process); break;
    case 'unpin': void saveSettings({...settings, pinned: settings.pinned.filter((_, index) => index !== Number(target.dataset.index))}); break;
    case 'appearance': void saveSettings({...settings, appearance: target.dataset.value as Settings['appearance']}); break;
    case 'open-port': void backend.openPort(port).catch(reason => { error = String(reason); render(); }); break;
    case 'copy': void copy(port); break;
  }
});

async function copy(port: number): Promise<void> {
  const text = `localhost:${port}`;
  try { await navigator.clipboard.writeText(text); }
  catch {
    // WebKit can refuse the async clipboard API outside a secure, focused context.
    const field = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(field); field.select(); document.execCommand('copy'); field.remove();
  }
  copiedPort = port; render();
  setTimeout(() => { if (copiedPort === port) { copiedPort = null; scheduleRender(); } }, 1500);
}

async function loadIcon(bundle: string): Promise<void> {
  appIcons.set(bundle, 'loading');
  try { appIcons.set(bundle, await backend.icon(bundle)); }
  catch { appIcons.set(bundle, null); }
  scheduleRender();
}

async function loadDetails(process: PortProcess): Promise<void> {
  if (details.has(process.identity) && details.get(process.identity) !== 'error') return;
  details.set(process.identity, 'loading');
  try { details.set(process.identity, await backend.details(process)); }
  catch { details.set(process.identity, 'error'); }
  scheduleRender();
}

async function togglePin(process: PortProcess): Promise<void> {
  const key = pinKey(process);
  const pinned = settings.pinned.includes(key) ? settings.pinned.filter(pin => pin !== key) : [...settings.pinned, key];
  await saveSettings({...settings, pinned});
}

async function refresh(): Promise<void> {
  if (scanning || disposed || document.hidden || stopping) return;
  clearTimeout(timer);
  scanning = true;
  try {
    processes = (await backend.scan()).processes;
    scans++;
    const live = new Set(processes.map(process => process.identity));
    for (const id of details.keys()) if (!live.has(id)) details.delete(id);
    if (error.startsWith('Scan failed')) error = '';
  } catch (reason) { error = `Scan failed: ${String(reason)}`; }
  finally {
    loading = false; scanning = false;
    scheduleRender();
    // CPU needs two samples, so the second scan comes sooner.
    if (!disposed && !document.hidden) timer = setTimeout(() => { void refresh(); }, scans < 2 ? 1000 : 3000);
  }
}

async function stopPending(): Promise<void> {
  if (!pending || stopping) return;
  const target = pending;
  stopping = true; clearTimeout(timer); render();
  try {
    const result = await backend.stop(target.process, target.force);
    flash(result.stopped ? `${target.force ? 'Force quit' : WORDS.stopped} ${title(target.process)}`
      : WINDOWS ? `${title(target.process)} is still ending.` : `${title(target.process)} is still stopping. ⌥-click Stop to force quit.`);
    pending = null;
    if (view.kind === 'detail' && result.stopped) view = { kind: 'list' };
  } catch (reason) { error = String(reason); pending = null; }
  finally { stopping = false; render(); await refresh(); }
}

async function stopIdle(): Promise<void> {
  if (!pendingIdle || stopping) return;
  const targets = pendingIdle;
  stopping = true; clearTimeout(timer); render();
  let stopped = 0;
  const failures: string[] = [];
  // One at a time: each stop revalidates that process's identity and port set in Rust.
  for (const process of targets) {
    try {
      if ((await backend.stop(process, false)).stopped) stopped++;
      else failures.push(`${title(process)} is still stopping`);
    } catch (reason) { failures.push(`${title(process)}: ${String(reason)}`); }
  }
  pendingIdle = null; stopping = false;
  if (failures.length) error = `${WORDS.stopped} ${stopped} of ${targets.length}. ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`;
  else flash(`${WORDS.stopped} ${stopped} app${stopped === 1 ? '' : 's'}`);
  render();
  await refresh();
}

async function saveSettings(next: Settings): Promise<void> {
  if (settingsSaving) return;
  settingsSaving = true; error = ''; render();
  try { await backend.updateSettings(next); settings = next; applyAppearance(); }
  catch (reason) { error = String(reason); }
  finally { settingsSaving = false; render(); }
}

document.addEventListener('keydown', event => {
  const inSearch = document.activeElement instanceof HTMLInputElement && document.activeElement.id === 'search';
  if (event.key === 'Escape') {
    event.preventDefault();
    if ((pending || pendingIdle) && !stopping) { pending = null; pendingIdle = null; render(); }
    else if (view.kind !== 'list') go({ kind: 'list' });
    else if (query) { query = ''; render(); focusSearch(); }
    else void backend?.close();
  } else if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
    event.preventDefault();
    if (view.kind !== 'list') go({ kind: 'list' });
    focusSearch();
  } else if (view.kind === 'list' && !inSearch && !pending && !pendingIdle && event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    // Typing anywhere in the list starts a search, like a native menu's type-select.
    focusSearch();
  }
});
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden && backend) void refresh(); });
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); clearTimeout(noticeTimer); });
document.addEventListener('contextmenu', event => event.preventDefault());

let lastHeight = 0;
const observer = new ResizeObserver(() => {
  const panel = app.querySelector<HTMLElement>('.panel');
  if (!panel || !backend) return;
  const height = Math.ceil(panel.getBoundingClientRect().height);
  if (height !== lastHeight) { lastHeight = height; void backend.resize(height).catch(() => {}); }
});
observer.observe(app);
render();
void (async () => {
  try {
    backend = await createBackend();
    await backend.ready();
    settings = await backend.settings();
    applyAppearance();
    await refresh();
  } catch (reason) { loading = false; error = String(reason); render(); }
})();
