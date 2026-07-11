// 桥接 sidecar 仅在正式构建（release）由 Rust 拉起 SEA 可执行文件；
// 开发（debug）时 sidecar 由 `npm run dev:all` 用 tsx 热跑，Rust 不介入，
// 避免每次启动都重新 SEA 打包、且改桥接代码即时生效。
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::process::CommandEvent;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

/// 启动桥接 sidecar（仅 release），并把它的 stdout/stderr 转接到 Tauri 日志。
///
/// 桥接 sidecar（void-bridge）承载 STT/TTS 的 WebSocket 桥接与模型/语音 HTTP 转发，
/// 是语音链路在生产环境（无 vite dev）能工作的前提。由 tauri-plugin-shell 在应用退出时
/// 统一回收，避免遗留孤儿进程。
#[cfg(not(debug_assertions))]
fn spawn_bridge_sidecar(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let sidecar_command = app.shell().sidecar("void-bridge")?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 仅正式构建拉起 SEA sidecar；开发期由 npm(dev:all) 的 tsx 进程提供。
            #[cfg(not(debug_assertions))]
            spawn_bridge_sidecar(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
