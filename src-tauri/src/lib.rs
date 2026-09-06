use std::sync::Mutex;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::WindowEvent;

mod takeover;
mod ocr;

// 桥接 sidecar 仅在正式构建（release）由 Rust 拉起（Node 解释器 + sidecar-app 真实文件）；
// 开发（debug）时 sidecar 由 `npm run dev:all` 用 tsx 热跑，Rust 不介入，
// 避免每次启动都重新打包、且改桥接代码即时生效。
#[cfg(not(debug_assertions))]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(not(debug_assertions))]
use rand::{rngs::OsRng, RngCore};
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::CommandEvent;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

struct BridgeTokenState(String);

/// sidecar 生命周期状态（L3 可观测）。
/// 0.2.4 教训：release 无日志 + 启动崩溃无记录，前端只能看到裸 `Failed to fetch`。
/// 本状态机是“sidecar 起没起来”的唯一真源，前端探针横幅只读它，不猜。
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSidecarStatus {
    /// spawn 是否成功（debug 下 Rust 不拉 sidecar，恒为 false，由前端直连判定）。
    spawned: bool,
    /// spawn 失败原因（缺二进制/权限等），成功为空。
    spawn_error: Option<String>,
    /// 进程异常事件（error/terminated payload），正常运行为空。
    terminated: Option<String>,
}

struct BridgeSidecarState(Mutex<BridgeSidecarStatus>);

#[tauri::command]
fn get_bridge_token(state: tauri::State<'_, BridgeTokenState>) -> String {
    state.0.clone()
}

/// 前端启动探针读取 sidecar 真实状态（只读，不触发任何拉起/重启）。
#[tauri::command]
fn get_bridge_status(state: tauri::State<'_, BridgeSidecarState>) -> BridgeSidecarStatus {
    state.0.lock().map(|guard| guard.clone()).unwrap_or_default()
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
/// 分发形态（0.2.4 教训后定案）：Node 解释器本身作为 sidecar 二进制
///（externalBin binaries/node），服务 bundle + playwright-core 以真实文件随包
///（resources sidecar-app），用 args 指向入口 cjs。凡是按磁盘相对路径自读文件的
///依赖都不进单文件快照——SEA 在该场景启动即崩，已废弃，勿回退。
/// 由 tauri-plugin-shell 在应用退出时统一回收，避免遗留孤儿进程。
#[cfg(not(debug_assertions))]
fn spawn_bridge_sidecar(
    app: &tauri::App,
    bridge_token: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let entry = resource_dir.join("sidecar-app").join("void-bridge.cjs");
    if !entry.is_file() {
        return Err(format!(
            "sidecar 入口缺失：{}（安装包资源不完整）",
            entry.display()
        )
        .into());
    }
    let Some(entry_text) = entry.to_str() else {
        return Err("sidecar 入口路径含非法字符，无法作为参数传递".into());
    };
    let sidecar_command = app
        .shell()
        .sidecar("node")?
        .args([entry_text])
        .env("VOID_BRIDGE_TOKEN", bridge_token);
    let (mut command_events, _child) = sidecar_command.spawn()?;

    // 把 child 交给独立任务持有，保持进程存活；事件循环转发桥接日志，
    // 便于按验收标准核对「桥接日志无 Error 帧」。异常事件同时写入状态机，供前端探针读取。
    // 根因修复（v0.2.5 CI E0521）：`app.state()` 返回的 State 借用 `&App`，
    // 不能移入要求 'static 的 spawn 任务。改传 owned AppHandle（'static），
    // 在任务内再取 state——与 tray_set_unread 取 AppHandle 的做法一致。
    let status_handle = app.handle().clone();
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
                    if let Ok(mut guard) = status_handle.state::<BridgeSidecarState>().0.lock() {
                        guard.terminated = Some(format!("sidecar error: {message}"));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("[void-bridge] sidecar terminated: {:?}", payload);
                    if let Ok(mut guard) = status_handle.state::<BridgeSidecarState>().0.lock() {
                        guard.terminated = Some(format!("sidecar terminated: {:?}", payload));
                    }
                }
                _ => {}
            }
        }
    });

    if let Ok(mut guard) = app.state::<BridgeSidecarState>().0.lock() {
        guard.spawned = true;
        guard.spawn_error = None;
    }

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(BridgeTokenState(bridge_token.clone()))
        .manage(BridgeSidecarState(Mutex::new(BridgeSidecarStatus::default())))
        .invoke_handler(tauri::generate_handler![
            get_bridge_token,
            get_bridge_status,
            tray_set_unread,
            takeover::takeover_start,
            takeover::takeover_stop,
            takeover::takeover_status,
            takeover::takeover_input,
            ocr::ocr_image_file
        ])
        .setup(move |app| {
            // 日志常开（debug 与 release 一致）：release 无控制台，sidecar 转发的日志
            // 只写文件（LogDir/void.log）才不会丢失；0.2.4 盲飞的教训。
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    ))
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("void".to_string()),
                        },
                    ))
                    .build(),
            )?;

            // 仅正式构建拉起 SEA sidecar；开发期由 npm(dev:all) 的 tsx 进程提供。
            // 拉起失败不崩主应用：记入状态机，前端探针横幅如实展示（崩应用比降级更差）。
            #[cfg(not(debug_assertions))]
            if let Err(error) = spawn_bridge_sidecar(app, &bridge_token) {
                log::error!("[void-bridge] sidecar spawn 失败：{error}");
                if let Ok(mut guard) = app
                    .state::<BridgeSidecarState>()
                    .0
                    .lock()
                {
                    guard.spawned = false;
                    guard.spawn_error = Some(error.to_string());
                }
            }

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

            // AR 全局热键：Ctrl+Alt+V 切换主窗口显隐（被占用记 warn 不崩）。
            #[cfg(desktop)]
            {
                use tauri::{Emitter, Manager};
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV);
                let push_to_talk = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyR);
                let register_toggle = app.global_shortcut().on_shortcut(toggle, |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(true) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                });
                // A 一键语音速记：Ctrl+Alt+R 只发事件，采集与发送由前端 STT 会话接管。
                let register_ptt = app.global_shortcut().on_shortcut(push_to_talk, |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("void:push-to-talk", ());
                    }
                });
                match (register_toggle, register_ptt) {
                    (Ok(()), Ok(())) => log::info!("[void] 全局热键 Ctrl+Alt+V / Ctrl+Alt+R 已注册"),
                    (Err(error), _) => log::warn!("[void] 全局热键 Ctrl+Alt+V 注册失败，跳过：{error}"),
                    (_, Err(error)) => log::warn!("[void] 全局热键 Ctrl+Alt+R 注册失败，跳过：{error}"),
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
