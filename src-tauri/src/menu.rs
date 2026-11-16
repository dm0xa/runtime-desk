//! The macOS menu bar. Everything the window can do that is not a row action lives here
//! with its accelerator, so the app behaves like a Mac app even when the pointer is
//! somewhere else. Items that change what the window shows forward their id to the
//! webview as a single `menu` event; the frontend owns the screens.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Builds the whole bar. Accelerators are the system ones (⌘N, ⌘F, ⌘R, ⌘,) so they are
/// never reassigned to something a Mac user would not expect.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let new_profile = MenuItem::with_id(app, "new-profile", "New Profile…", true, Some("CmdOrCtrl+N"))?;
    let search = MenuItem::with_id(app, "search", "Search…", true, Some("CmdOrCtrl+F"))?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;
    let sidebar = MenuItem::with_id(app, "toggle-sidebar", "Show Sidebar", true, Some("CmdOrCtrl+Alt+S"))?;
    let help = MenuItem::with_id(app, "help", "Runtime Desk Help", true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        "Runtime Desk",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Runtime Desk"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Hide Runtime Desk"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit Runtime Desk"))?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&new_profile, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::close_window(app, None)?],
    )?;

    // Text editing is the webview's; these predefined items route to the focused field.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &search,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &sidebar,
            &PredefinedMenuItem::separator(app)?,
            &refresh,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(app, "Help", true, &[&help])?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

/// Forwards an id from the bar to the only window that owns the screens.
pub fn dispatch(app: &AppHandle, id: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("menu", id);
    }
}
