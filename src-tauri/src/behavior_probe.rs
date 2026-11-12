//! BEH-01 设备活跃传感器（唯一传感器，不含业务语义）。
//!
//! 职责边界：
//! - 只读取系统空闲时长（GetLastInputInfo），每 60s 采一次；
//! - 样本进有界环缓冲（24h × 1/min），由前端泵经 `behavior_probe_take` 取走；
//! - 不做聚合、不写文件、不联网、不记录应用名或窗口标题；
//! - `configure(false)` 立即停止采样并清空环缓冲（关闭即不观测）。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// 环缓冲上限：24 小时 × 每分钟 1 条。
const RING_CAPACITY: usize = 1440;
/// 采样间隔（与前端泵的 60s 对齐）。
const SAMPLE_INTERVAL: Duration = Duration::from_secs(60);
/// 停止时的检查粒度：决定 stop 的 join 最坏阻塞。
const STOP_CHECK_INTERVAL: Duration = Duration::from_millis(100);

#[cfg(windows)]
#[repr(C)]
struct LastInputInfo {
    cb_size: u32,
    dw_time: u32,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount() -> u32;
}

/// 当前系统空闲秒数；读取失败返回 None（调用方计数并跳过，不猜测）。
#[cfg(windows)]
fn read_idle_sec() -> Option<u64> {
    let mut info = LastInputInfo {
        cb_size: std::mem::size_of::<LastInputInfo>() as u32,
        dw_time: 0,
    };
    // SAFETY: info 为栈上有效结构，cb_size 已按结构体大小填写。
    let ok = unsafe { GetLastInputInfo(&mut info) };
    if ok == 0 {
        return None;
    }
    // SAFETY: 无参数、无副作用；wrapping_sub 处理 49.7 天回绕。
    let now_tick = unsafe { GetTickCount() };
    let idle_ms = now_tick.wrapping_sub(info.dw_time);
    Some(u64::from(idle_ms) / 1000)
}

/// 非 Windows 平台不做任何猜测性观测。
#[cfg(not(windows))]
fn read_idle_sec() -> Option<u64> {
    None
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSample {
    pub ts_ms: i64,
    pub idle_sec: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeTake {
    pub samples: Vec<ProbeSample>,
    pub running: bool,
    /// 本进程内读取系统空闲失败的累计次数（只读诊断，不参与活跃判定）。
    pub read_failures: u64,
}

struct ProbeState {
    samples: VecDeque<ProbeSample>,
    handle: Option<JoinHandle<()>>,
    stop: Option<Arc<AtomicBool>>,
    read_failures: u64,
}

static PROBE: Mutex<ProbeState> = Mutex::new(ProbeState {
    samples: VecDeque::new(),
    handle: None,
    stop: None,
    read_failures: 0,
});

/// 采样线程 panic 不能拖垮整个 app：锁中毒后继续用原数据。
fn lock_probe() -> MutexGuard<'static, ProbeState> {
    PROBE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn record_sample() {
    let sampled = read_idle_sec();
    let mut state = lock_probe();
    match sampled {
        Some(idle_sec) => {
            if state.samples.len() >= RING_CAPACITY {
                state.samples.pop_front();
            }
            state.samples.push_back(ProbeSample {
                ts_ms: now_ms(),
                idle_sec,
            });
        }
        None => {
            state.read_failures = state.read_failures.saturating_add(1);
        }
    }
}

fn sampler_loop(stop: Arc<AtomicBool>) {
    loop {
        record_sample();
        let mut waited = Duration::ZERO;
        while waited < SAMPLE_INTERVAL {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(STOP_CHECK_INTERVAL);
            waited += STOP_CHECK_INTERVAL;
        }
        if stop.load(Ordering::Relaxed) {
            return;
        }
    }
}

fn start_sampler() {
    let mut state = lock_probe();
    if state.handle.is_some() {
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    state.stop = Some(stop);
    state.handle = Some(thread::spawn(move || sampler_loop(thread_stop)));
}

fn stop_sampler() {
    // 先放手再 join：采样线程也要拿同一把锁写环缓冲，持锁 join 会死锁。
    let (handle, stop) = {
        let mut state = lock_probe();
        (state.handle.take(), state.stop.take())
    };
    let Some(handle) = handle else {
        return;
    };
    if let Some(stop) = stop {
        stop.store(true, Ordering::Relaxed);
    }
    let _ = handle.join();
    let mut state = lock_probe();
    state.samples.clear();
    state.read_failures = 0;
}

/// 打开/关闭采样。返回设置后的运行状态；重复调用幂等。
#[tauri::command]
pub fn behavior_probe_configure(enabled: bool) -> bool {
    if enabled {
        start_sampler();
    } else {
        stop_sampler();
    }
    lock_probe().handle.is_some()
}

/// 取走当前环缓冲（drain），返回运行状态与读取失败计数。
#[tauri::command]
pub fn behavior_probe_take() -> ProbeTake {
    let mut state = lock_probe();
    let samples: Vec<ProbeSample> = state.samples.drain(..).collect();
    ProbeTake {
        samples,
        running: state.handle.is_some(),
        read_failures: state.read_failures,
    }
}
