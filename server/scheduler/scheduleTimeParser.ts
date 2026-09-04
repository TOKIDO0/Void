/**
 * B 自然语言时间解析：中文口语时间 → at/every/cron（纯函数，可单测）。
 * 策略：无时间默认 09:00 并在结果回显（用户可见可纠正）；今天类已过时间直接拒绝（fail-closed，不猜）。
 * 时区：服务端本地时区（本机运行 = 用户时区）。
 */

export type ParsedScheduleTime =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; expr: string };

const WEEKDAY: Record<string, number> = {
  "日": 0, "天": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6
};
const DEFAULT_HOUR = 9;

function atLocal(base: Date, dayOffset: number, hour: number, minute: number): number {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0);
  return d.getTime();
}

/** 解析 "8点半/8:30/8点05分" 与上下午，返回 [24h, minute]。period: am/pm/noon。 */
function parseClock(hourRaw: string, minuteRaw: string | undefined, period: string): [number, number] {
  let hour = Number(hourRaw);
  let minute = 0;
  if (minuteRaw !== undefined) {
    if (minuteRaw === "半") {
      minute = 30;
    } else {
      minute = Number(minuteRaw.replace("分", ""));
    }
  }
  if (period === "noon") {
    return [12, minute];
  }
  if (period === "pm" && hour < 12) {
    hour += 12;
  }
  if (period === "am" && hour === 12) {
    hour = 0;
  }
  return [hour, minute];
}

function periodOf(text: string): string {
  if (/中午/.test(text)) {
    return "noon";
  }
  if (/下午|晚上|今晚/.test(text)) {
    return "pm";
  }
  return "am";
}

const CLOCK = "(\\d{1,2})点(?:(半)|(\\d{1,2})分)?|(\\d{1,2}):(\\d{2})";

function extractClock(text: string): [number, number] | null {
  const match = text.match(new RegExp(CLOCK));
  if (!match) {
    return null;
  }
  const period = periodOf(text);
  if (match[1] !== undefined) {
    return parseClock(match[1], match[2] ?? match[3], period);
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (period === "pm" && hour < 12) {
    return [hour + 12, minute];
  }
  return [hour, minute];
}

/**
 * 解析自然语言时间；无法理解返回 null（调用方转 INVALID_REQUEST，不猜）。
 * 优先级：间隔 → 日历 cron → 具体日期 at。
 */
export function parseNaturalSchedule(text: string, nowMs: number): ParsedScheduleTime | null {
  const input = (text ?? "").trim();
  if (!input) {
    return null;
  }
  const now = new Date(nowMs);

  // 1) 间隔：每隔X分/时/天、每X分钟/小时/天、半小时后
  const everyMatch = input.match(/每隔\s*(\d+)\s*(分钟|分|小时|时|天)|每\s*(\d+)\s*(分钟|分|小时|时|天)/);
  if (everyMatch) {
    const value = Number(everyMatch[1] ?? everyMatch[3]);
    const unit = everyMatch[2] ?? everyMatch[4];
    const factor = /分/.test(unit) ? 60_000 : /时/.test(unit) ? 3600_000 : 24 * 3600_000;
    return { kind: "every", everyMs: value * factor };
  }

  // 2) 日历 cron
  const clock = extractClock(input);
  const hour = clock ? clock[0] : DEFAULT_HOUR;
  const minute = clock ? clock[1] : 0;
  if (/每天|每日/.test(input)) {
    return { kind: "cron", expr: `${minute} ${hour} * * *` };
  }
  if (/工作日/.test(input)) {
    return { kind: "cron", expr: `${minute} ${hour} * * 1-5` };
  }
  if (/周末/.test(input)) {
    return { kind: "cron", expr: `${minute} ${hour} * * 6,0` };
  }
  const weeklyMatch = input.match(/每周\s*([一二三四五六日天])/);
  if (weeklyMatch) {
    return { kind: "cron", expr: `${minute} ${hour} * * ${WEEKDAY[weeklyMatch[1]]}` };
  }
  const monthlyMatch = input.match(/每月\s*(\d{1,2})\s*号/);
  if (monthlyMatch) {
    const day = Math.min(28, Math.max(1, Number(monthlyMatch[1])));
    return { kind: "cron", expr: `${minute} ${hour} ${day} * *` };
  }

  // 3) 相对分钟/小时/天后、半小时后
  const afterMatch = input.match(/(\d+)\s*(分钟|分|小时|时|天)\s*后/);
  if (afterMatch) {
    const value = Number(afterMatch[1]);
    const unit = afterMatch[2];
    const factor = /分/.test(unit) ? 60_000 : /时/.test(unit) ? 3600_000 : 24 * 3600_000;
    return { kind: "at", atMs: nowMs + value * factor };
  }
  if (/半小时后/.test(input)) {
    return { kind: "at", atMs: nowMs + 30 * 60_000 };
  }

  // 4) 今天/明天/后天/大后天/今晚
  const dayWords: Array<[RegExp, number]> = [
    [/大后天/, 3],
    [/后天/, 2],
    [/明天|明早|明晚/, 1],
    [/今晚/, 0],
    [/今天/, 0]
  ];
  for (const [pattern, offset] of dayWords) {
    if (pattern.test(input)) {
      const time = extractClock(input) ?? (/今晚|明晚/.test(input) ? [20, 0] : [DEFAULT_HOUR, 0]);
      const atMs = atLocal(now, offset, time[0], time[1]);
      if (offset === 0 && atMs <= nowMs) {
        return null;
      }
      return { kind: "at", atMs };
    }
  }

  // 5) X号/X日
  const dayMatch = input.match(/(\d{1,2})\s*[号日]/);
  if (dayMatch) {
    const day = Number(dayMatch[1]);
    if (day < 1 || day > 31) {
      return null;
    }
    const time = extractClock(input) ?? [DEFAULT_HOUR, 0];
    let candidate = new Date(now.getFullYear(), now.getMonth(), day, time[0], time[1], 0, 0).getTime();
    if (candidate <= nowMs) {
      candidate = new Date(now.getFullYear(), now.getMonth() + 1, day, time[0], time[1], 0, 0).getTime();
    }
    return { kind: "at", atMs: candidate };
  }

  // 6) 周X/星期X（含上下周）。注意：裸周X匹配会回溯吞掉"上周"前缀，先拦。
  if (/上周|上星期/.test(input) && !/下周|这周|本周|下星期/.test(input)) {
    return null;
  }
  const weekMatch = input.match(/(上周|下周|这周|本周)?\s*(?:周|星期)\s*([一二三四五六日天])/);
  if (weekMatch) {
    const prefix = weekMatch[1] ?? "";
    const target = WEEKDAY[weekMatch[2]];
    const today = now.getDay();
    const time = extractClock(input) ?? [DEFAULT_HOUR, 0];
    let delta: number;
    if (prefix === "下周") {
      // 下周X：本周同名也算下周（+7 语义）。
      delta = ((target - today + 7) % 7) + 7;
    } else {
      delta = (target - today + 7) % 7;
      const candidate = atLocal(now, delta, time[0], time[1]);
      if (delta === 0 && candidate <= nowMs) {
        delta = 7;
      }
    }
    return { kind: "at", atMs: atLocal(now, delta, time[0], time[1]) };
  }

  return null;
}
