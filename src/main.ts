import { createElement, Search, Settings as Gear, Square, ArrowUpRight, ArrowLeft, ChevronLeft, Pin, Copy, Check, X, CircleAlert } from 'lucide';
import { createBackend } from './backend';
import type { Backend, PortProcess, ProcessDetails, Settings } from './types';
import './style.css';

const icons = { search: Search, settings: Gear, stop: Square, go: ArrowUpRight, back: ChevronLeft, backWin: ArrowLeft, pin: Pin, copy: Copy, check: Check, close: X, alert: CircleAlert };
/** The app's own mark, the same socket as the menu bar glyph. */
const SOCKET = '<svg class="socket" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M9.5 9.5v5M14.5 9.5v5"/></svg>';
type IconName = keyof typeof icons;
const icon = (name: IconName, extra = ''): string => createElement(icons[name], { width: 16, height: 16, 'aria-hidden': 'true', class: extra }).outerHTML;
const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const app = document.querySelector<HTMLElement>('#app')!;

const IDLE_CHOICES = [15, 30, 60, 180, 720];
/** Windows gets its own look, words and shortcuts; it has one End task action and no menu bar count. */
const WINDOWS = navigator.userAgent.includes('Windows') || (import.meta.env.DEV && new URLSearchParams(location.search).has('windows'));
if (WINDOWS) document.documentElement.dataset.platform = 'windows';
const WORDS = WINDOWS
  ? { stop: 'End', stopButton: 'End task', stopAll: 'End all', stopping: 'Ending…', stopped: 'Ended', stopHint: 'End task', login: 'Start with Windows', quit: 'Exit PortKiller' }
  : { stop: 'Stop', stopButton: 'Stop', stopAll: 'Stop all', stopping: 'Stopping…', stopped: 'Stopped', stopHint: 'Stop · Option-click to force quit', login: 'Open at login', quit: 'Quit PortKiller' };
/** Shortcut labels for the right-click menu. The handlers are in the keydown listener below. */
const KEYS = WINDOWS
  ? { open: 'Ctrl+O', copy: 'Ctrl+C', pin: 'Ctrl+P', stop: 'Del', force: '' }
  : { open: '⌘O', copy: '⌘C', pin: '⌘P', stop: '⌘⌫', force: '⌥⌘⌫' };
/** The port of the server this page comes from (the dev server in `tauri dev`). Stopping it closes PortKiller. */
const OWN_PORT = location.protocol.startsWith('http') && location.port ? Number(location.port) : null;
/** Ports that are not web pages, so they get Copy but no Open. */
const NOT_WEB = new Set([5432, 3306, 6379, 27017, 9229, 9222, 11211, 5672]);
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
/** The row picked with the arrow keys; shortcuts act on it. */
let selected: string | null = null;
/** The open right-click menu: its row and where it was opened, relative to the panel. */
let menu: { identity: string; x: number; y: number } | null = null;
let query = '';
let settings: Settings = { showCount: true, launchAtLogin: false, idleMinutes: 30, pinned: [], appearance: 'auto' };
let error = '';
let scanError = '';
let notice = '';
let copiedPort: number | null = null;
let available: string | null = null;
let updating = false;
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
function webPort(process: PortProcess): number | undefined { return ports(process).find(port => !NOT_WEB.has(port)); }
function title(process: PortProcess): string { return process.project && process.project !== 'local' ? process.project : process.app; }
function displayName(process: PortProcess): string { return isOwn(process) ? 'PortKiller' : title(process); }
function bytes(value: number | null): string {
  if (value === null) return '–';
  const mb = value / 1048576;
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
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

/** Pinned first, then Running (PortKiller's own server last), then Idle by memory. */
function sections(): { name: string; list: PortProcess[] }[] {
  const needle = query.trim().toLowerCase();
  const visible = processes.filter(process => matches(process, needle));
  const pinned = visible.filter(process => isPinned(process) && !isOwn(process)).sort((a, b) => ports(a)[0] - ports(b)[0]);
  const running = visible.filter(process => !isIdle(process) && (!isPinned(process) || isOwn(process)))
    .sort((a, b) => Number(isOwn(a)) - Number(isOwn(b)) || ports(a)[0] - ports(b)[0]);
  const idle = visible.filter(isIdle).sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));
  return [{ name: 'Pinned', list: pinned }, { name: 'Running', list: running }, { name: 'Idle', list: idle }].filter(section => section.list.length);
}
function visibleOrder(): PortProcess[] { return sections().flatMap(section => section.list); }

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
  const id = esc(process.identity);
  if (pending?.process.identity === process.identity) {
    return `<div class="row"><div class="confirm" role="alertdialog" aria-label="Confirm stop">${processIcon(process)}${confirmBox(stopQuestion(process, pending.force), pending.force, 'confirm')}</div></div>`;
  }
  const doomed = pendingIdle?.some(item => item.identity === process.identity);
  const more = list.length > 1 ? `<span class="more" title="${esc(list.slice(1).map(port => `:${port}`).join(', '))}">+${list.length - 1}</span>` : '';
  const web = webPort(process);
  const open = web === undefined ? '' : `<button class="act go" data-action="open-port" data-port="${web}" aria-label="Open localhost:${web} in browser" title="Open in browser">${icon('go')}</button>`;
  const classes = ['row', isIdle(process) && 'idle', doomed && 'doomed', selected === process.identity && 'selected', menu?.identity === process.identity && 'menu-open'].filter(Boolean).join(' ');
  return `<div class="${classes}" data-row="${id}">
    <button class="open" data-action="open" data-id="${id}" aria-label="${esc(`${displayName(process)}, port ${list[0]}`)}">
      ${processIcon(process)}<span class="name">${esc(displayName(process))}</span><span class="port">:${list[0]}${more}</span>
    </button>
    <span class="acts">${open}<button class="act stop" data-action="stop" data-id="${id}" aria-label="${esc(stopQuestion(process, false).slice(0, -1))}" title="${WORDS.stopHint}" ${stopping ? 'disabled' : ''}>${icon(WINDOWS ? 'close' : 'stop')}</button></span>
  </div>`;
}

function contextMenu(): string {
  const process = menu && find(menu.identity);
  if (!menu || !process) return '';
  const id = esc(process.identity);
  const web = webPort(process);
  const item = (label: string, keys: string, attributes: string): string =>
    `<button role="menuitem" ${attributes}><span>${esc(label)}</span>${keys ? `<kbd>${keys}</kbd>` : ''}</button>`;
  return `<div class="menu" role="menu" aria-label="${esc(`Actions for ${displayName(process)}`)}" style="left:${menu.x}px;top:${menu.y}px">
    ${web === undefined ? '' : item('Open in browser', KEYS.open, `data-action="open-port" data-port="${web}"`)}
    ${item('Copy address', KEYS.copy, `data-action="copy" data-port="${ports(process)[0]}"`)}
    ${isOwn(process) ? '' : item(isPinned(process) ? 'Unpin' : 'Pin', KEYS.pin, `data-action="pin" data-id="${id}"`)}
    <div class="separator" role="separator"></div>
    ${item(WORDS.stopButton, KEYS.stop, `data-action="stop" data-id="${id}"`)}
    ${WINDOWS ? '' : item('Force quit', KEYS.force, `data-action="force" data-id="${id}"`)}
  </div>`;
}

function message(kind: 'alert' | 'search' | 'check', heading: string, line: string, button = ''): string {
  return `<div class="message" data-kind="${kind}" role="${kind === 'alert' ? 'alert' : 'status'}"><span class="badge">${icon(kind)}</span><strong>${esc(heading)}</strong><span>${esc(line)}</span>${button}</div>`;
}

function listView(): string {
  const groups = sections();
  const stopAll = `<button class="pill ${pendingIdle ? 'armed' : ''}" data-action="stop-idle" ${stopping || pendingIdle ? 'disabled' : ''}>${WORDS.stopAll}</button>`;
  const body = loading
    ? `<div class="skeletons" aria-busy="true" aria-label="Loading">${['45%', '30%', '55%', '38%'].map(width => `<div class="row skeleton" aria-hidden="true"><span class="icon"></span><i style="width:${width}"></i><b></b></div>`).join('')}</div>`
    : groups.length ? groups.map(({ name, list }) => `<section aria-label="${name}"><div class="section-head"><span>${name}</span>${name === 'Idle' ? stopAll : ''}</div>${list.map(row).join('')}</section>`).join('')
    : scanError && !processes.length ? message('alert', 'Couldn’t read open ports', 'The scan stopped before it finished.', `<button class="chip" data-action="retry" title="${esc(scanError)}">Try again</button>`)
    : query ? message('search', `No apps match “${query.trim()}”`, 'Search by app, folder or port.', '<button class="chip" data-action="clear">Clear search</button>')
    : error ? '' : message('check', 'All ports are free', 'Start a server and it shows up here.');
  const gear = round('settings', available ? 'Settings, update available' : 'Settings', 'data-action="settings"', available ? 'dot' : '');
  return `<div class="top"><label class="search">${icon('search')}<input id="search" aria-label="Search" placeholder="Search" value="${esc(query)}" autocomplete="off" spellcheck="false"></label>${gear}</div>
    <div class="list">${body}</div>${bars()}${contextMenu()}`;
}

function bars(): string {
  if (error) return `<div class="bar error" role="alert">${esc(error)}</div>`;
  if (scanError && processes.length) return `<div class="bar error" role="alert"><span title="${esc(scanError)}">Couldn’t read open ports</span><button class="text-button" data-action="retry">Try again</button></div>`;
  if (pendingIdle) return `<div class="bar" role="alertdialog" aria-label="Confirm stop all idle">${confirmBox(`${WORDS.stop} ${pendingIdle.length} idle app${pendingIdle.length === 1 ? '' : 's'}?`, false, 'confirm-idle', WINDOWS ? WORDS.stopAll : WORDS.stopButton)}</div>`;
  if (notice) return `<div class="bar notice" role="status">${icon('check', 'ok')}<span>${esc(notice)}</span></div>`;
  return '';
}

function detailView(process: PortProcess): string {
  const info = details.get(process.identity);
  const folder = info === undefined || info === 'loading' ? '…' : info === 'error' || !info.cwd ? '–' : shortPath(info.cwd);
  const command = info && typeof info === 'object' ? info.command : '';
  const pinned = isPinned(process);
  const portRows = ports(process).map(port => `<div class="port-row"><dt>:${port}</dt><dd>${NOT_WEB.has(port) ? '' : `<button class="chip go" data-action="open-port" data-port="${port}">Open</button>`}${round(copiedPort === port ? 'check' : 'copy', `Copy localhost:${port}`, `data-action="copy" data-port="${port}"`, 'quiet')}</dd></div>`).join('');
  const property = (key: string, value: string, hint = ''): string => `<div class="prop"><dt>${key}</dt><dd ${hint ? `title="${esc(hint)}"` : ''}>${esc(value)}</dd></div>`;
  const action = pending?.process.identity === process.identity
    ? `<div class="confirm" role="alertdialog" aria-label="Confirm stop">${confirmBox(stopQuestion(process, pending.force), pending.force, 'confirm')}</div>`
    : `<button class="danger wide" data-action="stop" data-id="${esc(process.identity)}" title="${WORDS.stopHint}" ${stopping ? 'disabled' : ''}>${WORDS.stopButton}</button>`;
  const pin = isOwn(process) ? '' : round('pin', pinned ? 'Unpin' : 'Pin', `data-action="pin" data-id="${esc(process.identity)}" aria-pressed="${pinned}" ${settingsSaving ? 'disabled' : ''}`, pinned ? 'on' : '');
  return `<header class="header">${round(WINDOWS ? 'backWin' : 'back', 'Back', 'data-action="back"')}${processIcon(process, 'large')}<h1>${esc(displayName(process))}</h1>${pin}</header>
    <dl class="detail">${portRows}${property('Memory', bytes(process.memoryBytes))}${property('Folder', folder, command)}</dl>
    ${error ? bars() : `<div class="actions">${action}</div>`}`;
}

function settingsView(): string {
  const busy = settingsSaving ? 'disabled' : '';
  const options = IDLE_CHOICES.map(minutes => `<option value="${minutes}" ${settings.idleMinutes === minutes ? 'selected' : ''}>${minutes < 60 ? `${minutes} min` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`}</option>`).join('');
  // A segmented control on macOS; a drop-down, as in Windows Settings, on Windows.
  const appearance = WINDOWS
    ? `<select data-appearance aria-label="Appearance" ${busy}>${(['auto', 'light', 'dark'] as const).map(value => `<option value="${value}" ${settings.appearance === value ? 'selected' : ''}>${value === 'auto' ? 'System' : `${value[0].toUpperCase()}${value.slice(1)}`}</option>`).join('')}</select>`
    : `<div class="segmented" role="group" aria-label="Appearance">${(['auto', 'light', 'dark'] as const).map(value => `<button data-action="appearance" data-value="${value}" aria-pressed="${settings.appearance === value}" ${busy}>${value[0].toUpperCase()}${value.slice(1)}</button>`).join('')}</div>`;
  const update = available
    ? `<div class="update" role="status"><i aria-hidden="true"></i><span>Version ${esc(available)}</span><button class="accent" data-action="update" ${updating ? 'disabled' : ''}>${updating ? 'Updating…' : 'Update'}</button></div>` : '';
  return `<header class="header">${round(WINDOWS ? 'backWin' : 'back', 'Back', 'data-action="back"')}<h1>Settings</h1></header>
    ${update}
    <div class="settings">
      <label class="setting"><span>${WORDS.login}</span><input type="checkbox" role="switch" class="switch" data-login ${settings.launchAtLogin ? 'checked' : ''} ${busy}></label>
      ${WINDOWS ? '' : `<label class="setting"><span>Count in menu bar</span><input type="checkbox" role="switch" class="switch" data-count ${settings.showCount ? 'checked' : ''} ${busy}></label>`}
      <label class="setting"><span>Idle after</span><select data-idle ${busy}>${options}</select></label>
      <div class="setting"><span>Appearance</span>${appearance}</div>
    </div>
    ${error ? bars() : ''}<div class="actions"><button class="chip wide" data-action="quit">${WORDS.quit}</button></div>`;
}

function render(): void {
  if (disposed) return;
  if (view.kind === 'detail' && !find(view.identity)) { view = { kind: 'list' }; pending = null; }
  if (selected && !find(selected)) selected = null;
  if (menu && (!find(menu.identity) || view.kind !== 'list')) menu = null;
  const content = view.kind === 'settings' ? settingsView() : view.kind === 'detail' ? detailView(find(view.identity)!) : listView();
  const html = `<section class="panel" aria-label="PortKiller">${content}</section>`;
  // Most scans change nothing the list shows, so the DOM is left alone.
  if (html === lastHtml) return;
  lastHtml = html;
  const focused = document.activeElement as HTMLElement | null;
  const editing = focused instanceof HTMLInputElement && focused.id === 'search';
  const caret = editing ? focused.selectionStart : null;
  const inMenu = !!focused?.closest('.menu');
  const focusKey = !editing && !inMenu && focused?.dataset.action ? `[data-action="${focused.dataset.action}"]${focused.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : ''}${focused.dataset.port ? `[data-port="${focused.dataset.port}"]` : ''}` : '';
  const scrollTop = app.querySelector('.list, .detail, .settings')?.scrollTop ?? 0;
  app.innerHTML = html;
  bindInputs();
  const scroller = app.querySelector<HTMLElement>('.list, .detail, .settings');
  if (scroller) scroller.scrollTop = scrollTop;
  placeMenu();
  if (inMenu && menu) {
    app.querySelector<HTMLElement>('.menu [role="menuitem"]')?.focus();
  } else if (editing) {
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
/** Keeps the menu inside the panel: flips it above the pointer or left of it when it would overflow. */
function placeMenu(): void {
  const element = app.querySelector<HTMLElement>('.menu');
  const panel = app.querySelector<HTMLElement>('.panel');
  if (!element || !panel || !menu) return;
  // A short list grows the window so the whole menu shows.
  panel.style.minHeight = `${menu.y + element.offsetHeight + 8}px`;
  const room = panel.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  if (box.bottom > room.bottom - 4) element.style.top = `${Math.max(4, menu.y - box.height)}px`;
  if (box.right > room.right - 4) element.style.left = `${Math.max(4, room.width - box.width - 4)}px`;
}
function focusSearch(): void { document.querySelector<HTMLInputElement>('#search')?.focus(); }
function flash(message: string): void {
  notice = message; clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice = ''; scheduleRender(); }, 4000);
}
function go(next: View): void { view = next; pending = null; pendingIdle = null; menu = null; error = ''; render(); }
function applyAppearance(): void {
  if (settings.appearance === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.appearance;
}

// Actions

function bindInputs(): void {
  const search = app.querySelector<HTMLInputElement>('#search');
  if (search) search.oninput = () => { query = search.value; pendingIdle = null; selected = null; render(); };
  const login = app.querySelector<HTMLInputElement>('[data-login]');
  if (login) login.onchange = () => { void saveSettings({...settings, launchAtLogin: login.checked}); };
  const count = app.querySelector<HTMLInputElement>('[data-count]');
  if (count) count.onchange = () => { void saveSettings({...settings, showCount: count.checked}); };
  const appearance = app.querySelector<HTMLSelectElement>('[data-appearance]');
  if (appearance) appearance.onchange = () => { void saveSettings({...settings, appearance: appearance.value as Settings['appearance']}); };
  const idle = app.querySelector<HTMLSelectElement>('[data-idle]');
  if (idle) idle.onchange = () => { void saveSettings({...settings, idleMinutes: Number(idle.value)}); };
}

function openDetail(process: PortProcess): void {
  selected = process.identity;
  go({ kind: 'detail', identity: process.identity });
  void loadDetails(process);
}
function askStop(process: PortProcess, force: boolean): void {
  pending = { process: structuredClone(process), force: !WINDOWS && force };
  pendingIdle = null; menu = null; error = ''; notice = ''; render();
  app.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.focus();
}
function openPort(port: number): void { void backend.openPort(port).catch(reason => { error = String(reason); render(); }); }
function openMenu(process: PortProcess, x: number, y: number): void {
  selected = process.identity; pending = null; pendingIdle = null;
  menu = { identity: process.identity, x: Math.round(x), y: Math.round(y) };
  render();
  app.querySelector<HTMLElement>('.menu [role="menuitem"]')?.focus();
}
function closeMenu(): void {
  if (!menu) return;
  const identity = menu.identity;
  menu = null; render();
  app.querySelector<HTMLElement>(`[data-action="open"][data-id="${CSS.escape(identity)}"]`)?.focus();
}

app.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-action]');
  // Like a native menu, a click outside the menu only dismisses it.
  if (menu && !(event.target as Element).closest('.menu')) { closeMenu(); return; }
  if (!target || (target as HTMLButtonElement).disabled) return;
  menu = null;
  const process = target.dataset.id ? find(target.dataset.id) : undefined;
  const port = Number(target.dataset.port);
  switch (target.dataset.action) {
    case 'settings': go({ kind: 'settings' }); break;
    case 'back': go({ kind: 'list' }); break;
    case 'quit': void backend.quit().catch(reason => { error = String(reason); render(); }); break;
    case 'open': if (process) openDetail(process); break;
    case 'stop': if (process) askStop(process, (event as MouseEvent).altKey); break;
    case 'force': if (process) askStop(process, true); break;
    case 'stop-idle':
      // Only the idle apps the current search shows.
      pendingIdle = structuredClone(processes.filter(process => isIdle(process) && matches(process, query.trim().toLowerCase())));
      pending = null; error = ''; notice = ''; render();
      app.querySelector<HTMLButtonElement>('[data-action="confirm-idle"]')?.focus();
      break;
    case 'cancel': pending = null; pendingIdle = null; render(); break;
    case 'confirm': void stopPending(); break;
    case 'confirm-idle': void stopIdle(); break;
    case 'pin': if (process) void togglePin(process); else render(); break;
    case 'appearance': void saveSettings({...settings, appearance: target.dataset.value as Settings['appearance']}); break;
    case 'open-port': openPort(port); render(); break;
    case 'copy': void copy(port); break;
    case 'update': void installUpdate(); break;
    case 'retry': scanError = ''; loading = true; render(); void refresh(); break;
    case 'clear': query = ''; render(); focusSearch(); break;
  }
});

app.addEventListener('contextmenu', event => {
  const rowElement = (event.target as Element).closest<HTMLElement>('[data-row]');
  const process = rowElement && find(rowElement.dataset.row!);
  const panel = app.querySelector<HTMLElement>('.panel');
  if (!process || !panel || pending || pendingIdle || stopping) return;
  const room = panel.getBoundingClientRect();
  openMenu(process, event.clientX - room.left, event.clientY - room.top);
});
app.addEventListener('focusin', event => {
  // Tabbing onto a row selects it, so the shortcuts act on what has focus.
  // Keyboard focus only: re-rendering during a click would swallow the click.
  const open = (event.target as Element).closest<HTMLElement>('.open[data-id]');
  if (open && open.matches(':focus-visible') && selected !== open.dataset.id) { selected = open.dataset.id!; render(); }
});

async function copy(port: number): Promise<void> {
  const text = `localhost:${port}`;
  try { await navigator.clipboard.writeText(text); }
  catch {
    // WebKit can refuse the async clipboard API outside a secure, focused context.
    const field = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(field); field.select(); document.execCommand('copy'); field.remove();
  }
  if (view.kind === 'detail') {
    copiedPort = port; render();
    setTimeout(() => { if (copiedPort === port) { copiedPort = null; scheduleRender(); } }, 1500);
  } else {
    flash(`Copied ${text}`); render();
  }
}

async function checkUpdate(): Promise<void> {
  try { available = await backend.updateVersion(); scheduleRender(); }
  catch { /* Offline: try again next time the menu opens. */ }
}

/** PortKiller restarts into the new version, so this only returns if something failed. */
async function installUpdate(): Promise<void> {
  if (updating) return;
  updating = true; error = ''; render();
  try { await backend.installUpdate(); }
  catch (reason) { error = String(reason); }
  finally { updating = false; render(); }
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
    scanError = '';
  } catch (reason) { scanError = String(reason); }
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

// Keyboard: ↑↓ select, ↩ details, and on the selected app (or the open details page)
// ⌘O / Ctrl+O open, ⌘C / Ctrl+C copy, ⌘P / Ctrl+P pin, ⌘⌫ / Del stop, ⌥⌘⌫ force quit,
// Shift+F10 or the menu key for the right-click menu.

function moveSelection(step: number): void {
  const order = visibleOrder();
  if (!order.length) return;
  const index = order.findIndex(process => process.identity === selected);
  const next = index < 0 ? (step > 0 ? 0 : order.length - 1) : index + step;
  if (next < 0) { selected = null; render(); focusSearch(); return; }
  selected = order[Math.min(next, order.length - 1)].identity;
  render();
  const button = app.querySelector<HTMLElement>(`[data-action="open"][data-id="${CSS.escape(selected)}"]`);
  button?.focus();
  button?.scrollIntoView({ block: 'nearest' });
}

function menuKeys(event: KeyboardEvent): void {
  const items = [...app.querySelectorAll<HTMLElement>('.menu [role="menuitem"]')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
}

document.addEventListener('keydown', event => {
  if (menu) { menuKeys(event); return; }
  const search = document.activeElement instanceof HTMLInputElement && document.activeElement.id === 'search' ? document.activeElement : null;
  const command = WINDOWS ? event.ctrlKey : event.metaKey;
  const key = event.key.toLowerCase();
  const confirming = !!(pending || pendingIdle);
  if (event.key === 'Escape') {
    event.preventDefault();
    if (confirming && !stopping) { pending = null; pendingIdle = null; render(); }
    else if (view.kind !== 'list') go({ kind: 'list' });
    else if (query) { query = ''; selected = null; render(); focusSearch(); }
    else if (selected) { selected = null; render(); focusSearch(); }
    else void backend?.close();
    return;
  }
  if (command && key === 'f') {
    event.preventDefault();
    if (view.kind !== 'list') go({ kind: 'list' });
    focusSearch();
    return;
  }
  if (confirming) return;
  if (view.kind === 'list' && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !command && !event.altKey) {
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  const target = view.kind === 'detail' ? find(view.identity) : view.kind === 'list' && selected ? find(selected) : undefined;
  // In the search field, editing keys keep their usual meaning while it has text.
  const editingText = !!search && (search.value !== '' || (search.selectionStart ?? 0) !== (search.selectionEnd ?? 0));
  if (target) {
    if (search && event.key === 'Enter') { event.preventDefault(); openDetail(target); return; }
    if (command && key === 'o') { event.preventDefault(); const port = webPort(target); if (port !== undefined) openPort(port); return; }
    if (command && key === 'c' && !editingText) { event.preventDefault(); void copy(ports(target)[0]); return; }
    if (command && key === 'p') { event.preventDefault(); if (!isOwn(target)) void togglePin(target); return; }
    const stopKey = WINDOWS ? event.key === 'Delete' && !search : command && event.key === 'Backspace' && !editingText;
    if (stopKey) { event.preventDefault(); askStop(target, event.altKey); return; }
    if (view.kind === 'list' && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault();
      const element = app.querySelector<HTMLElement>(`[data-row="${CSS.escape(target.identity)}"]`);
      const panel = app.querySelector<HTMLElement>('.panel');
      if (element && panel) {
        const box = element.getBoundingClientRect(), room = panel.getBoundingClientRect();
        openMenu(target, box.left - room.left + 48, box.bottom - room.top - 4);
      }
      return;
    }
  }
  // WebView2 prints on Ctrl+P and opens files on Ctrl+O; neither belongs in a tray menu.
  if (command && (key === 'p' || key === 'o')) { event.preventDefault(); return; }
  if (view.kind === 'list' && !search && event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    // Typing anywhere in the list starts a search, like a native menu's type-select.
    selected = null;
    focusSearch();
  }
});
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden && backend) void refresh(); });
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); clearTimeout(noticeTimer); });
// The WebView's own menu (Reload, Inspect) never shows; rows open PortKiller's menu instead.
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
    void checkUpdate();
    await refresh();
  } catch (reason) { loading = false; error = String(reason); render(); }
})();
