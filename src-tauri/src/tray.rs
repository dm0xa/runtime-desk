//! The menu-bar item. It answers the two questions a user asks without opening the window
//! — which profile is selected, and is it running — and forwards Start/Stop to the webview
//! so the window's busy state, notices and list refresh remain the only implementation.
//!
//! Closing the window still quits: this is an ordinary Dock app with a menu-bar shortcut,
//! not a background agent. Trimmed scope, deliberately.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

const TRAY_ID: &str = "main";

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Builds the static part of the menu. The profile rows are filled by [`sync`], which the
/// frontend calls whenever the selection or its running state changes.
pub fn build(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, "tray-show", "Show Runtime Desk", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Runtime Desk", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?, &quit]).map_err(|e| e.to_string())?;
    let icon = app.default_window_icon().cloned()
        .ok_or_else(|| "a window icon is required for the menu-bar item".to_string())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Runtime Desk")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main(app),
            "tray-quit" => app.exit(0),
            // Start and Stop are the window's actions: it owns busy state, notices and the
            // refresh that follows. A hidden or background window still receives the event.
            "tray-start" | "tray-stop" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("tray", event.id().as_ref());
                }
            }
            _ => {}
        })
        .build(app)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Rebuilds the menu for the selected profile. Called from a synchronous command so the
/// menu is created on the main thread, which AppKit requires.
pub fn sync(app: &AppHandle, profile: &str, running: bool) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return Ok(()) };
    let state = if running { "running" } else { "stopped" };
    let header = MenuItem::with_id(app, "tray-profile", format!("{profile} · {state}"), false, None::<&str>).map_err(|e| e.to_string())?;
    let start = MenuItem::with_id(app, "tray-start", "Start", !running, None::<&str>).map_err(|e| e.to_string())?;
    let stop = MenuItem::with_id(app, "tray-stop", "Stop", running, None::<&str>).map_err(|e| e.to_string())?;
    let show = MenuItem::with_id(app, "tray-show", "Show Runtime Desk", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Runtime Desk", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[
        &header,
        &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        &start,
        &stop,
        &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        &show,
        &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        &quit,
    ]).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(format!("Runtime Desk — {profile} {state}"))).map_err(|e| e.to_string())?;
    Ok(())
}
