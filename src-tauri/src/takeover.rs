//! P6 高权限接管模式：原始键鼠直控（enigo），Rust 侧会话门禁。
//!
//! 安全模型（fail-closed）：
//! - 默认关闭；`takeover_start` 显式开启，需 allow 白名单（≥1 个进程名片段）+ TTL（5～120min）。
//! - 每次 input 核验：会话有效期内 + 前台进程命中白名单 + 不在反作弊黑名单；任一不满足即拒绝，不执行。
//! - 审计环形保留 200 条；密码/支付类靠 scope 白名单 + 用户盯屏 + 审计兜底（无法可靠识别密码框，不承诺识别）。

use std::collections::VecDeque;
use std::sync::Mutex;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> isize;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, pid: u32) -> isize;
    fn CloseHandle(handle: isize) -> i32;
    fn QueryFullProcessImageNameW(handle: isize, flags: u32, name: *mut u16, size: *mut u32) -> i32;
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const MIN_TTL_MINUTES: u64 = 5;
const MAX_TTL_MINUTES: u64 = 120;
const DEFAULT_TTL_MINUTES: u64 = 30;
const MAX_ALLOW_ENTRIES: usize = 10;
const MAX_TYPE_CHARS: usize = 200;
const MAX_AUDIT_ENTRIES: usize = 200;

/// 反作弊/竞技类进程默认黑名单（子串匹配，小写）。豁免不在 v1：要玩先移除敌意是产品红线，不开豁免口。
const ANTI_CHEAT_BLOCKLIST: &[&str] = &[
    "cs2",
    "csgo",
    "valorant",
    "overwatch",
    "apex_legends",
    "fortniteclient-win64-shipping",
    "pubg",
    "tlsgame",
    "rainbow6",
    "destiny2",
    "leagueoflegends",
    "leagueclient",
    "warzone",
    "cod22",
    "easyanticheat",
    "battleye",
    "bedaisy",
    "vgc",
    "vgk",
];

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 前台窗口所属进程的文件名小写（如 `notepad.exe`）；拿不到返回 None（fail-closed 调用方拒绝）。
fn foreground_exe_name() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid as *mut u32);
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return None;
        }
        let mut buffer = [0u16; 260];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size as *mut u32);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        Some(
            path.rsplit(['\\', '/'])
                .next()
                .unwrap_or("")
                .to_lowercase(),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TakeoverInput {
    KeyTap { key: String, modifiers: Option<Vec<String>> },
    KeyDown { key: String },
    KeyUp { key: String },
    TypeText { text: String },
    MouseMove { x: i32, y: i32 },
    MouseClick { button: String, x: Option<i32>, y: Option<i32> },
    MouseDoubleClick { button: String, x: Option<i32>, y: Option<i32> },
    MouseScroll { delta_x: Option<i32>, delta_y: Option<i32> },
    MouseDrag { from_x: i32, from_y: i32, to_x: i32, to_y: i32, button: Option<String> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverAuditEntry {
    at: u64,
    action: String,
    foreground_exe: String,
}

struct TakeoverSession {
    id: String,
    started_at_ms: u64,
    ttl_ms: u64,
    allow: Vec<String>,
    audit: VecDeque<TakeoverAuditEntry>,
}

static TAKEOVER_STATE: Mutex<Option<TakeoverSession>> = Mutex::new(None);

fn parse_key(name: &str) -> Result<Key, String> {
    let lowered = name.trim().to_lowercase();
    if lowered.is_empty() || lowered.len() > 16 {
        return Err(format!("未知按键：{name}"));
    }
    if lowered.len() == 1 {
        if let Some(ch) = lowered.chars().next() {
            return Ok(Key::Unicode(ch));
        }
    }
    let mapped = match lowered.as_str() {
        "space" => Key::Space,
        "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "backspace" => Key::Backspace,
        "shift" => Key::Shift,
        "ctrl" | "control" => Key::Control,
        "alt" => Key::Alt,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "insert" => Key::Insert,
        "delete" => Key::Delete,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        _ => return Err(format!("未知按键：{name}")),
    };
    Ok(mapped)
}

fn parse_button(name: &str) -> Result<Button, String> {
    match name.trim().to_lowercase().as_str() {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        _ => Err(format!("未知鼠标键（仅 left/right/middle）：{name}")),
    }
}

fn parse_modifier(name: &str) -> Result<Key, String> {
    match name.trim().to_lowercase().as_str() {
        "ctrl" | "control" => Ok(Key::Control),
        "shift" => Ok(Key::Shift),
        "alt" => Ok(Key::Alt),
        _ => Err(format!("未知修饰键（仅 ctrl/shift/alt）：{name}")),
    }
}

fn push_audit(session: &mut TakeoverSession, action: String, foreground_exe: String) {
    session.audit.push_back(TakeoverAuditEntry {
        at: now_ms(),
        action,
        foreground_exe,
    });
    while session.audit.len() > MAX_AUDIT_ENTRIES {
        session.audit.pop_front();
    }
}

fn summarize_input(input: &TakeoverInput) -> String {
    match input {
        TakeoverInput::KeyTap { key, modifiers } => match modifiers {
            Some(keys) if !keys.is_empty() => format!("keyTap {}+{key}", keys.join("+")),
            _ => format!("keyTap {key}"),
        },
        TakeoverInput::KeyDown { key } => format!("keyDown {key}"),
        TakeoverInput::KeyUp { key } => format!("keyUp {key}"),
        TakeoverInput::TypeText { text } => {
            // 审计不存完整文本：长度 + 前 32 字（防密码/敏感串进日志）。
            let head: String = text.chars().take(32).collect();
            format!("typeText len={} head={}", text.chars().count(), head)
        }
        TakeoverInput::MouseMove { x, y } => format!("mouseMove {x},{y}"),
        TakeoverInput::MouseClick { button, x, y } => match (x, y) {
            (Some(x), Some(y)) => format!("mouseClick {button} {x},{y}"),
            _ => format!("mouseClick {button}"),
        },
        TakeoverInput::MouseDoubleClick { button, x, y } => match (x, y) {
            (Some(x), Some(y)) => format!("mouseDoubleClick {button} {x},{y}"),
            _ => format!("mouseDoubleClick {button}"),
        },
        TakeoverInput::MouseScroll { delta_x, delta_y } => {
            format!("mouseScroll {},{}", delta_x.unwrap_or(0), delta_y.unwrap_or(0))
        }
        TakeoverInput::MouseDrag { from_x, from_y, to_x, to_y, button } => format!(
            "mouseDrag {from_x},{from_y}->{to_x},{to_y} {}",
            button.as_deref().unwrap_or("left")
        ),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverSessionView {
    pub session_id: String,
    pub expires_in_sec: u64,
    pub allow: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverStatusView {
    pub active: bool,
    pub session_id: Option<String>,
    pub expires_in_sec: u64,
    pub allow: Vec<String>,
    pub audit_tail: Vec<TakeoverAuditEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverInputReceipt {
    pub ok: bool,
    pub foreground_exe: String,
    pub at: u64,
}

fn active_session_guard(state: &mut Option<TakeoverSession>) -> Result<(String, Vec<String>), String> {
    let session = state.as_mut().ok_or_else(|| "接管未开启：先调用 takeover_start".to_string())?;
    if now_ms().saturating_sub(session.started_at_ms) >= session.ttl_ms {
        *state = None;
        return Err("接管已过期自动关闭：重新 takeover_start".to_string());
    }
    Ok((session.id.clone(), session.allow.clone()))
}

#[tauri::command]
pub fn takeover_start(ttl_minutes: Option<u64>, allow_processes: Vec<String>) -> Result<TakeoverSessionView, String> {
    let ttl = ttl_minutes.unwrap_or(DEFAULT_TTL_MINUTES).clamp(MIN_TTL_MINUTES, MAX_TTL_MINUTES);
    let allow: Vec<String> = allow_processes
        .into_iter()
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .take(MAX_ALLOW_ENTRIES)
        .collect();
    if allow.is_empty() {
        return Err("接管必须指定白名单应用（allow_processes ≥ 1），fail-closed 拒绝空 scope".to_string());
    }
    let mut id_bytes = [0u8; 8];
    getrandom_id(&mut id_bytes);
    let session = TakeoverSession {
        id: id_bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        started_at_ms: now_ms(),
        ttl_ms: ttl * 60_000,
        allow: allow.clone(),
        audit: VecDeque::new(),
    };
    let view = TakeoverSessionView {
        session_id: session.id.clone(),
        expires_in_sec: ttl * 60,
        allow,
    };
    *TAKEOVER_STATE.lock().map_err(|_| "接管状态锁异常".to_string())? = Some(session);
    Ok(view)
}

fn getrandom_id(buffer: &mut [u8]) {
    // rand 0.8 已在依赖：用系统熵填会话 id。
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(buffer);
}

#[tauri::command]
pub fn takeover_stop() -> Result<bool, String> {
    let mut state = TAKEOVER_STATE.lock().map_err(|_| "接管状态锁异常".to_string())?;
    Ok(state.take().is_some())
}

#[tauri::command]
pub fn takeover_status() -> Result<TakeoverStatusView, String> {
    let mut state = TAKEOVER_STATE.lock().map_err(|_| "接管状态锁异常".to_string())?;
    if let Some(session) = state.as_mut() {
        if now_ms().saturating_sub(session.started_at_ms) >= session.ttl_ms {
            *state = None;
        }
    }
    match state.as_ref() {
        None => Ok(TakeoverStatusView {
            active: false,
            session_id: None,
            expires_in_sec: 0,
            allow: vec![],
            audit_tail: vec![],
        }),
        Some(session) => Ok(TakeoverStatusView {
            active: true,
            session_id: Some(session.id.clone()),
            expires_in_sec: session.ttl_ms.saturating_sub(now_ms().saturating_sub(session.started_at_ms)) / 1000,
            allow: session.allow.clone(),
            audit_tail: session.audit.iter().rev().take(10).cloned().collect(),
        }),
    }
}

#[tauri::command]
pub fn takeover_input(input: TakeoverInput) -> Result<TakeoverInputReceipt, String> {
    // 文本长度先验（与前端契约一致，双保险）。
    if let TakeoverInput::TypeText { text } = &input {
        if text.chars().count() > MAX_TYPE_CHARS {
            return Err(format!("typeText 不得超过 {MAX_TYPE_CHARS} 字"));
        }
    }
    let foreground = foreground_exe_name().ok_or_else(|| "无法识别前台应用：fail-closed 拒绝键鼠".to_string())?;
    if ANTI_CHEAT_BLOCKLIST.iter().any(|blocked| foreground.contains(blocked)) {
        return Err(format!("前台 {foreground} 在反作弊黑名单：拒绝键鼠（红线无豁免）"));
    }
    let mut state = TAKEOVER_STATE.lock().map_err(|_| "接管状态锁异常".to_string())?;
    let (_session_id, allow) = active_session_guard(&mut state)?;
    if !allow.iter().any(|entry| foreground.contains(entry)) {
        return Err(format!("前台 {foreground} 不在接管白名单：拒绝键鼠"));
    }
    let summary = summarize_input(&input);
    execute_input(&input).map_err(|error| format!("键鼠执行失败：{error}"))?;
    if let Some(session) = state.as_mut() {
        push_audit(session, summary, foreground.clone());
    }
    Ok(TakeoverInputReceipt {
        ok: true,
        foreground_exe: foreground,
        at: now_ms(),
    })
}

fn execute_input(input: &TakeoverInput) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|error| format!("输入后端初始化失败：{error}"))?;
    match input {
        TakeoverInput::KeyTap { key, modifiers } => {
            let mods: Vec<Key> = match modifiers {
                Some(list) => list.iter().map(|name| parse_modifier(name)).collect::<Result<Vec<_>, _>>()?,
                None => vec![],
            };
            for modifier in &mods {
                enigo
                    .key(*modifier, Direction::Press)
                    .map_err(|error| format!("修饰键按下失败：{error}"))?;
            }
            let tapped = enigo
                .key(parse_key(key)?, Direction::Click)
                .map_err(|error| format!("按键失败：{error}"));
            for modifier in mods.iter().rev() {
                let _ = enigo.key(*modifier, Direction::Release);
            }
            tapped?;
        }
        TakeoverInput::KeyDown { key } => {
            enigo
                .key(parse_key(key)?, Direction::Press)
                .map_err(|error| format!("按下失败：{error}"))?;
        }
        TakeoverInput::KeyUp { key } => {
            enigo
                .key(parse_key(key)?, Direction::Release)
                .map_err(|error| format!("松开失败：{error}"))?;
        }
        TakeoverInput::TypeText { text } => {
            enigo.text(text).map_err(|error| format!("输入文本失败：{error}"))?;
        }
        TakeoverInput::MouseMove { x, y } => {
            enigo
                .move_mouse(*x, *y, Coordinate::Abs)
                .map_err(|error| format!("移动鼠标失败：{error}"))?;
        }
        TakeoverInput::MouseClick { button, x, y } => {
            if let (Some(x), Some(y)) = (x, y) {
                enigo
                    .move_mouse(*x, *y, Coordinate::Abs)
                    .map_err(|error| format!("移动鼠标失败：{error}"))?;
            }
            enigo
                .button(parse_button(button)?, Direction::Click)
                .map_err(|error| format!("点击失败：{error}"))?;
        }
        TakeoverInput::MouseDoubleClick { button, x, y } => {
            if let (Some(x), Some(y)) = (x, y) {
                enigo
                    .move_mouse(*x, *y, Coordinate::Abs)
                    .map_err(|error| format!("移动鼠标失败：{error}"))?;
            }
            let pressed = parse_button(button)?;
            for _ in 0..2 {
                enigo
                    .button(pressed, Direction::Click)
                    .map_err(|error| format!("双击失败：{error}"))?;
            }
        }
        TakeoverInput::MouseScroll { delta_x, delta_y } => {
            let dx = delta_x.unwrap_or(0).clamp(-100, 100);
            let dy = delta_y.unwrap_or(0).clamp(-100, 100);
            if dx == 0 && dy == 0 {
                return Err("滚轮增量全零：至少给 deltaX/deltaY 之一".to_string());
            }
            if dx != 0 {
                enigo
                    .scroll(dx, Axis::Horizontal)
                    .map_err(|error| format!("横向滚动失败：{error}"))?;
            }
            if dy != 0 {
                enigo
                    .scroll(dy, Axis::Vertical)
                    .map_err(|error| format!("纵向滚动失败：{error}"))?;
            }
        }
        TakeoverInput::MouseDrag { from_x, from_y, to_x, to_y, button } => {
            for (name, value) in [("fromX", from_x), ("fromY", from_y), ("toX", to_x), ("toY", to_y)] {
                if !(-10000..=10000).contains(value) {
                    return Err(format!("{name} 超出屏幕坐标范围"));
                }
            }
            let pressed = parse_button(button.as_deref().unwrap_or("left"))?;
            enigo
                .move_mouse(*from_x, *from_y, Coordinate::Abs)
                .map_err(|error| format!("移动鼠标失败：{error}"))?;
            enigo
                .button(pressed, Direction::Press)
                .map_err(|error| format!("按下失败：{error}"))?;
            let dragged = enigo
                .move_mouse(*to_x, *to_y, Coordinate::Abs)
                .map_err(|error| format!("拖拽移动失败：{error}"));
            let _ = enigo.button(pressed, Direction::Release);
            dragged?;
        }
    }
    Ok(())
}
