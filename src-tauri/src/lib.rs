use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::WindowEvent;

mod takeover;

// 桥接 sidecar 仅在正式构建（release）由 Rust 拉起 SEA 可执行文件；
 // 开发（debug）时 sidecar 由 `npm run dev:all` 用 tsx 热跑，Rust 不介入，
 // 避免每次启动都重新 SEA 打包、且改桥接代码即时生效。
#[cfg(not(debug_assertions))]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(not(debug_assertions))]
use rand::{rngs::OsRng, RngCore};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::CommandEvent;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

struct BridgeTokenState(String);

#[tauri::command]
fn get_bridge_token(state: tauri::State<'_, BridgeTokenState>) -> String {
    state.0.clone()
}

/// A1 未读角标：托盘 tooltip 显示未投递数（零素材方案）；0 条回 VOID。
#[tauri::command]
fn tray_set_unread(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let tray = app
        .tray_by_id("void-tray")
        .ok_or_else(|| "托盘不存在".to_string())?;
    let tooltip = if count == 0 {
        "VOID".to_string()
    } else {
        format!("VOID（{count} 条未读）")
    };
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| format!("设置托盘提示失败：{error}"))?;
    Ok(())
}

#[cfg(not(debug_assertions))]
fn generate_bridge_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(debug_assertions)]
fn resolve_bridge_token() -> String {
    std::env::var("VOID_BRIDGE_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg(not(debug_assertions))]
fn resolve_bridge_token() -> String {
    generate_bridge_token()
}

/// 启动桥接 sidecar（仅 release），并把它的 stdout/stderr 转接到 Tauri 日志。
///
/// 桥接 sidecar（void-bridge）承载 STT/TTS 的 WebSocket 桥接与模型/语音 HTTP 转发，
/// 是语音链路在生产环境（无 vite dev）能工作的前提。由 tauri-plugin-shell 在应用退出时
/// 统一回收，避免遗留孤儿进程。
#[cfg(not(debug_assertions))]
fn spawn_bridge_sidecar(
    app: &tauri::App,
    bridge_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let sidecar_command = app
        .shell()
        .sidecar("void-bridge")?
        .env("VOID_BRIDGE_TOKEN", bridge_token);
    let (mut command_events, _child) = sidecar_command.spawn()?;

    // 把 child 交给独立任务持有，保持进程存活；事件循环转发桥接日志，
    // 便于按验收标准核对「桥接日志无 Error 帧」。
    tauri::async_runtime::spawn(async move {
        // _child 移入本闭包，随任务生命周期存活；应用退出时由插件回收。
        let _child = _child;
        while let Some(event) = command_events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[void-bridge] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Stderr(line) => {
                    log::error!("[void-bridge] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Error(message) => {
                    log::error!("[void-bridge] sidecar error: {message}");
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("[void-bridge] sidecar terminated: {:?}", payload);
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// P2 托盘常驻：打开 VOID / 退出。图标复用主窗口图标，不新增资源文件。
fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open_item = MenuItem::with_id(app, "tray-open", "打开 VOID", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("void-tray")
        .menu(&menu)
        .tooltip("VOID")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bridge_token = resolve_bridge_token();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // P2 托盘常驻：窗口可能处于隐藏态，先 show 再聚焦。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None
        ))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(BridgeTokenState(bridge_token.clone()))
        .invoke_handler(tauri::generate_handler![
            get_bridge_token,
            tray_set_unread,
            takeover::takeover_start,
            takeover::takeover_stop,
            takeover::takeover_status,
            takeover::takeover_input
        ])
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 仅正式构建拉起 SEA sidecar；开发期由 npm(dev:all) 的 tsx 进程提供。
            #[cfg(not(debug_assertions))]
            spawn_bridge_sidecar(app, &bridge_token)?;

            // P2 托盘常驻底座：关窗口转隐藏（进程与 sidecar 不停），仅托盘菜单退出才真正结束。
            build_tray(app)?;
            if let Some(window) = app.get_webview_window("main") {
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let _ = hidden.hide();
                        api.prevent_close();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
