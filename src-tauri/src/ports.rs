use crate::platform;
use crate::scanner::{self, ProcessDetails, Scanner, Snapshot, StopOutcome};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    utils::config::WindowEffectsConfig,
    window::{Effect, EffectState},
    AppHandle, LogicalSize, Manager, PhysicalPosition, Rect, RunEvent, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

const WIDTH: f64 = 360.0;
/// Space between the menu bar and the top of the menu.
const GAP: f64 = 6.0;
/// The menu never grows past this, or past 70% of the screen; the port list scrolls instead.
const MAX_HEIGHT: f64 = 680.0;
const MAX_PINS: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    show_count: bool,
    launch_at_login: bool,
    idle_minutes: u32,
    pinned: Vec<String>,
    appearance: Appearance,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Appearance {
    #[default]
    Auto,
    Light,
    Dark,
}

impl Appearance {
    /// `None` follows the system appearance.
    fn theme(self) -> Option<Theme> {
        match self {
            Appearance::Auto => None,
            Appearance::Light => Some(Theme::Light),
            Appearance::Dark => Some(Theme::Dark),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            show_count: true,
            launch_at_login: false,
            idle_minutes: 30,
            pinned: Vec::new(),
            appearance: Appearance::Auto,
        }
    }
}

impl Settings {
    fn validate(&self) -> Result<(), String> {
        if !(5..=1440).contains(&self.idle_minutes) {
            return Err("Idle time must be between 5 minutes and 24 hours".into());
        }
        if self.pinned.len() > MAX_PINS || self.pinned.iter().any(|pin| pin.len() > 2048) {
            return Err("Too many pinned apps".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct AppState {
    scanner: Mutex<Scanner>,
    settings: Mutex<Settings>,
    last_count: Mutex<Option<usize>>,
    anchor: Mutex<Option<(Rect, PhysicalPosition<f64>)>>,
    last_closed: Mutex<Option<Instant>>,
}

fn lock_error() -> String {
    "PortKiller's process state is unavailable. Restart the app.".into()
}

fn update_count(app: &AppHandle, count: Option<usize>) {
    let state = app.state::<AppState>();
    let enabled = state
        .settings
        .lock()
        .map(|settings| settings.show_count)
        .unwrap_or(false);
    if let Some(tray) = app.tray_by_id("ports") {
        // macOS shows the count beside the icon. Windows tray icons cannot show text, so it goes in the tooltip.
        if cfg!(target_os = "macos") {
            let title = if enabled {
                count.map(|count| count.to_string())
            } else {
                None
            };
            let _ = tray.set_title(title.as_deref());
        } else {
            let tooltip = match count {
                Some(1) => "PortKiller · 1 open port".to_string(),
                Some(count) => format!("PortKiller · {count} open ports"),
                None => "PortKiller".to_string(),
            };
            let _ = tray.set_tooltip(Some(tooltip));
        }
    }
}

#[tauri::command]
async fn scan_ports(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if app.get_webview_window("main").is_none() {
            return Err("Menu is closed".into());
        }
        let state = app.state::<AppState>();
        let snapshot = state.scanner.lock().map_err(|_| lock_error())?.scan()?;
        let count = snapshot
            .processes
            .iter()
            .map(|process| {
                process
                    .listeners
                    .iter()
                    .map(|listener| listener.port)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
            })
            .sum();
        *state.last_count.lock().map_err(|_| lock_error())? = Some(count);
        update_count(&app, Some(count));
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn process_details(
    app: AppHandle,
    pid: i32,
    identity: String,
) -> Result<ProcessDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .scanner
            .lock()
            .map_err(|_| lock_error())?
            .details(pid, &identity)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_process(
    app: AppHandle,
    pid: i32,
    identity: String,
    ports: Vec<u16>,
    force: bool,
) -> Result<StopOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize with scans so UI refreshes cannot race the stop validation.
        let state = app.state::<AppState>();
        let _guard = state.scanner.lock().map_err(|_| lock_error())?;
        scanner::stop(pid, &identity, &ports, force)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let mut settings = app
        .state::<AppState>()
        .settings
        .lock()
        .map_err(|_| lock_error())?
        .clone();
    settings.launch_at_login = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
    Ok(settings)
}

#[tauri::command]
fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    settings.validate()?;
    let autostart = app.autolaunch();
    let before = autostart.is_enabled().map_err(|e| e.to_string())?;
    if settings.launch_at_login != before {
        if settings.launch_at_login {
            autostart.enable()
        } else {
            autostart.disable()
        }
        .map_err(|e| format!("Could not update launch at login: {e}"))?;
    }
    let save = (|| -> Result<(), String> {
        let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let temporary = directory.join("settings.json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, directory.join("settings.json")).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = save {
        if settings.launch_at_login != before {
            let _ = if before {
                autostart.enable()
            } else {
                autostart.disable()
            };
        }
        return Err(format!("Could not save settings: {error}"));
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(settings.appearance.theme());
    }
    let state = app.state::<AppState>();
    *state.settings.lock().map_err(|_| lock_error())? = settings;
    let count = *state.last_count.lock().map_err(|_| lock_error())?;
    update_count(&app, count);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MenuGeometry {
    max_height: f64,
}

fn place_menu(
    app: &AppHandle,
    window: &WebviewWindow,
    height: f64,
) -> Result<MenuGeometry, String> {
    let anchor = *app
        .state::<AppState>()
        .anchor
        .lock()
        .map_err(|_| lock_error())?;
    let (rect, point) = anchor.ok_or("Tray icon position is unavailable")?;
    let monitor = app
        .monitor_from_point(point.x, point.y)
        .map_err(|e| e.to_string())?
        .or(app.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("No display is available")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let center = origin.x + size.width / 2.0;
    let left = f64::from(area.position.x);
    let right = left + f64::from(area.size.width);
    let x = (center - WIDTH * scale / 2.0).clamp(
        left + 4.0 * scale,
        (right - (WIDTH + 4.0) * scale).max(left + 4.0 * scale),
    );
    let top = f64::from(area.position.y);
    let bottom = top + f64::from(area.size.height);
    // The macOS menu bar is at the top; a Windows taskbar is usually at the bottom. Open away from it.
    let above = origin.y + size.height / 2.0 > top + f64::from(area.size.height) / 2.0;
    let room = if above {
        origin.y.min(bottom) - top
    } else {
        bottom - (origin.y + size.height).max(top)
    };
    let max_height = (room / scale - GAP - 12.0)
        .min(f64::from(area.size.height) / scale * 0.7)
        .clamp(100.0, MAX_HEIGHT);
    let height = height.clamp(100.0, max_height);
    let y = if above {
        origin.y.min(bottom) - (GAP + height) * scale
    } else {
        (origin.y + size.height).max(top) + GAP * scale
    };
    window
        .set_size(LogicalSize::new(WIDTH, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|e| e.to_string())?;
    Ok(MenuGeometry { max_height })
}

#[tauri::command]
fn menu_ready(app: AppHandle, window: WebviewWindow) -> Result<MenuGeometry, String> {
    let geometry = place_menu(&app, &window, 160.0)?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(geometry)
}

#[tauri::command]
fn resize_menu(app: AppHandle, window: WebviewWindow, height: f64) -> Result<(), String> {
    if !height.is_finite() {
        return Err("Invalid window height".into());
    }
    place_menu(&app, &window, height)?;
    Ok(())
}

/// Opens http://localhost:<port> in the default browser. The URL is built here, never from the frontend.
#[tauri::command]
fn open_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Invalid port".into());
    }
    platform::open_url(&format!("http://localhost:{port}"))
}

/// An app's icon as a 52px PNG data URL (26pt at 2x), or `None` when there is none.
/// Synchronous, so Tauri runs it on the main thread as AppKit expects.
#[tauri::command]
fn app_icon(bundle: String) -> Option<String> {
    use base64::Engine;
    let png = platform::icon_png(&bundle, 52)?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

#[tauri::command]
fn close_menu(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// macOS: Liquid Glass on 26+, the popover material before that. Windows: Acrylic, like system flyouts.
/// Reduce Transparency (macOS) and transparency effects off (Windows) make them solid.
fn glass() -> WindowEffectsConfig {
    WindowEffectsConfig {
        effects: if cfg!(target_os = "macos") {
            vec![Effect::LiquidGlassRegular, Effect::Popover]
        } else {
            vec![Effect::Acrylic]
        },
        state: Some(EffectState::Active),
        // Matches the page's panel; Windows 11 rounds its own corners.
        radius: Some(16.0),
        color: None,
        interactive: false,
    }
}

fn open_menu(app: &AppHandle, rect: Rect, point: PhysicalPosition<f64>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        return window.destroy().map_err(|e| e.to_string());
    }
    let state = app.state::<AppState>();
    // Clicking the tray can blur/destroy the popover on mouse-down, before mouse-up arrives.
    if state
        .last_closed
        .lock()
        .map_err(|_| lock_error())?
        .is_some_and(|when| when.elapsed() < Duration::from_millis(250))
    {
        return Ok(());
    }
    *state.anchor.lock().map_err(|_| lock_error())? = Some((rect, point));
    let theme = state
        .settings
        .lock()
        .map_err(|_| lock_error())?
        .appearance
        .theme();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("PortKiller")
        .inner_size(WIDTH, 160.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        // The system draws and blurs the glass, so the page paints no backdrop of its own.
        .effects(glass())
        .theme(theme)
        .shadow(true)
        .visible(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
    let handle = app.clone();
    let tracked = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) if tracked.is_visible().unwrap_or(false) => {
            let _ = tracked.destroy();
        }
        WindowEvent::Destroyed => {
            let state = handle.state::<AppState>();
            if let Ok(mut last) = state.last_closed.lock() {
                *last = Some(Instant::now());
            }
            // Drop cached process metadata too. No webview, timers or scanning while closed.
            if let Ok(mut scanner) = state.scanner.try_lock() {
                scanner.forget();
            };
        }
        _ => {}
    });
    Ok(())
}

/// Windows: the colour app icon, which reads on light and dark taskbars alike.
#[cfg(windows)]
fn tray_image() -> Image<'static> {
    Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("bundled tray icon")
}

/// The menu bar glyph: a rounded socket with two slots, drawn as a 32px template image.
#[cfg(not(windows))]
fn tray_image() -> Image<'static> {
    const SIZE: usize = 32;
    // Signed distance to a rounded rectangle centred at (cx, cy).
    let rounded = |x: f64, y: f64, cx: f64, cy: f64, hw: f64, hh: f64, r: f64| {
        let dx = (x - cx).abs() - (hw - r);
        let dy = (y - cy).abs() - (hh - r);
        dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - r
    };
    let mut rgba = vec![0_u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            let outline = rounded(px, py, 16.0, 16.0, 12.5, 12.5, 7.0).abs() - 1.4;
            let left = rounded(px, py, 12.4, 16.0, 1.6, 5.0, 1.6);
            let right = rounded(px, py, 19.6, 16.0, 1.6, 5.0, 1.6);
            let distance = outline.min(left).min(right);
            let alpha = (0.5 - distance).clamp(0.0, 1.0);
            rgba[(y * SIZE + x) * 4 + 3] = (alpha * 255.0).round() as u8;
        }
    }
    Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            scan_ports,
            process_details,
            stop_process,
            get_settings,
            set_settings,
            menu_ready,
            resize_menu,
            open_port,
            app_icon,
            close_menu,
            quit_app
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            if let Ok(path) = app.path().app_config_dir() {
                if let Ok(bytes) = fs::read(path.join("settings.json")) {
                    if let Ok(settings) = serde_json::from_slice::<Settings>(&bytes)
                        .map_err(|e| e.to_string())
                        .and_then(|settings| settings.validate().map(|_| settings))
                    {
                        *app.state::<AppState>()
                            .settings
                            .lock()
                            .map_err(|_| lock_error())? = settings;
                    }
                }
            }
            let quit = MenuItem::with_id(app, "quit", "Quit PortKiller", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;
            TrayIconBuilder::with_id("ports")
                .icon(tray_image())
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("PortKiller")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        position,
                        ..
                    } = event
                    {
                        if let Err(error) = open_menu(tray.app_handle(), rect, position) {
                            eprintln!("Could not open PortKiller: {error}");
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start PortKiller")
        .run(|app, event| {
            // Relaunching a running app opens the menu; only macOS reports that.
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = &event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else if let Some(tray) = app.tray_by_id("ports") {
                    if let Ok(Some(rect)) = tray.rect() {
                        let point = rect.position.to_physical::<f64>(1.0);
                        let _ = open_menu(app, rect, point);
                    }
                }
            }
            if let RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
