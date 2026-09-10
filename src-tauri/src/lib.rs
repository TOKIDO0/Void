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
#[cfg(not(debug_assertions))]
fn get_bridge_token(state: tauri::State<'_, BridgeTokenState>) -> String {
    state.0.clone()
}

/// debug 下每次调用都 live 重读（env → 共享文件），不只用启动快照：
/// tauri dev 常先于 bridge(tsx) 启动，启动快照恒为空会导致 bridge 起后仍 403。
/// release 保持启动时随机 token 不变（sidecar env 同源注入，不读文件）。
#[tauri::command]
#[cfg(debug_assertions)]
fn get_bridge_token(state: tauri::State<'_, BridgeTokenState>) -> String {
    let live = resolve_bridge_token();
    if !live.is_empty() {
        return live;
    }
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

/// debug dev token 单一真源：环境变量优先，否则读 Node 侧共享文件
/// （server/bridge/bridgeAuth.ts resolveDevBridgeTokenFilePath 同约定：
/// VOID_BRIDGE_TOKEN_FILE > VOID_RUNTIME_DIR > VOID_RUNTIME_ROOT > 默认 D 盘运行时目录）。
/// 读不到视同 bridge 未起，返回空由前端给诚实错误（Failed to fetch），不伪造 token。
#[cfg(debug_assertions)]
fn resolve_dev_token_file_path() -> std::path::PathBuf {
    if let Ok(direct) = std::env::var("VOID_BRIDGE_TOKEN_FILE") {
        let trimmed = direct.trim().to_string();
        if !trimmed.is_empty() {
            return std::path::PathBuf::from(trimmed);
        }
    }
    let runtime_dir = read_non_empty_env("VOID_RUNTIME_DIR")
        .or_else(|| read_non_empty_env("VOID_RUNTIME_ROOT"))
        .unwrap_or_else(|| "D:\\AI\\void-runtime".to_string());
    std::path::Path::new(&runtime_dir).join(".bridge-token")
}

#[cfg(debug_assertions)]
fn read_non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(debug_assertions)]
fn read_dev_token_file() -> String {
    let path = resolve_dev_token_file_path();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let token = content.trim().to_string();
    // 与 Node 侧同口径：拒绝空/夹带换行/超长垃圾，防投毒文件。
    if token.len() < 16
        || token.len() > 512
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '+' | '/' | '.' | '='))
    {
        return String::new();
    }
    token
}

#[cfg(debug_assertions)]
fn resolve_bridge_token() -> String {
    let from_env = std::env::var("VOID_BRIDGE_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string();
    if !from_env.is_empty() {
        return from_env;
    }
    read_dev_token_file()
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
    let sidecar_app_dir = resource_dir.join("sidecar-app");
    let entry = sidecar_app_dir.join("void-bridge.cjs");
    if !entry.is_file() {
        return Err(format!(
            "sidecar 入口缺失：{}（安装包资源不完整）",
            entry.display()
        )
        .into());
    }
    // 诊断生命线：0.2.6 曾出现 node 收到的入口被截成 `D:`（EISDIR 启动崩）。
    // 无论截断发生在参数传输的哪一环，这里必须留下当时的入口与工作目录，否则下次依然盲猜。
    log::info!("[void-bridge] 入口：{}，工作目录：{}", entry.display(), sidecar_app_dir.display());
    // 不传绝对路径当参数：Windows 绝对路径（含盘符/反斜杠）在参数传输链上曾被截断；
    // 改为把工作目录直接设到 sidecar-app，只传裸文件名，彻底消灭该故障面。
    // node 按自身 cwd 解析相对入口；cjs 内部 require 按文件位置解析，不受 cwd 影响。
    let sidecar_command = app
        .shell()
        .sidecar("node")?
        .current_dir(&sidecar_app_dir)
        .args(["void-bridge.cjs"])
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
            // Stronghold 密钥库：官方文档模式，salt 落 app 本地数据目录。
            {
                use tauri::Manager;
                let salt_path = app
                    .path()
                    .app_local_data_dir()
                    .expect("could not resolve app local data path")
                    .join("salt.txt");
                app.handle().plugin(
                    tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build(),
                )?;
            }
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
