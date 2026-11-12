// BEH-01 行为观察冒烟：纯单元 + 端点 E2E（隔离运行时根，零触碰真实数据）。
// 覆盖：默认关闭、分钟幂等、活跃阈值、乱序/非法样本、跨天分桶、90 天裁剪、
//       损坏文件隔离、任务计数派生、HTTP 契约与错误码、关闭后拒绝写入。
// 用法：npx tsx scripts/agent-behavior-smoke.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function localKey(ms) {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyDay(date) {
  return {
    date,
    activeMinutesByHour: new Array(24).fill(0),
    activeMinutes: 0,
    firstActiveAt: 0,
    lastActiveAt: 0,
    taskSucceeded: 0,
    taskFailed: 0,
    taskMissed: 0
  };
}

/** BEH-02 纯派生 fixture：hourMinutes 为 { 小时: 活跃分钟 }，首末时间用“当天第几分钟”。 */
function profileDay(date, hourMinutes, firstMinuteOfDay, lastMinuteOfDay) {
  const activeMinutesByHour = new Array(24).fill(0);
  for (const [hour, minutes] of Object.entries(hourMinutes)) {
    activeMinutesByHour[Number(hour)] = minutes;
  }
  const base = new Date(`${date}T00:00:00`).getTime();
  return {
    date,
    activeMinutesByHour,
    activeMinutes: activeMinutesByHour.reduce((sum, value) => sum + value, 0),
    firstActiveAt: firstMinuteOfDay == null ? 0 : base + firstMinuteOfDay * MINUTE_MS,
    lastActiveAt: lastMinuteOfDay == null ? 0 : base + lastMinuteOfDay * MINUTE_MS,
    taskSucceeded: 0,
    taskFailed: 0,
    taskMissed: 0
  };
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-behavior-root-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const behaviorDir = path.join(runtimeRoot, "behavior");
  const behaviorFile = path.join(behaviorDir, "daily.json");
  const schedulerDir = path.join(runtimeRoot, "scheduler");

  const now = Date.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const at = (hour, minute) => dayStart.getTime() + hour * HOUR_MS + minute * MINUTE_MS;
  const tomorrowAt = (hour, minute) => dayStart.getTime() + DAY_MS + hour * HOUR_MS + minute * MINUTE_MS;

  try {
    // 任务计数来源：今天的 1 成功 + 1 失败；昨天的 missed 不应计入今天。
    mkdirSync(schedulerDir, { recursive: true });
    writeFileSync(
      path.join(schedulerDir, "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [],
        runs: [
          {
            id: "run_ok",
            jobId: "job_morning",
            jobName: "早报",
            startedAt: now - 120_000,
            finishedAt: now - 60_000,
            status: "succeeded",
            delivery: { state: "sent", attempts: 1, enqueuedAt: now - 120_000 }
          },
          {
            id: "run_bad",
            jobId: "job_patrol",
            jobName: "巡检",
            startedAt: now - 90_000,
            finishedAt: now - 50_000,
            status: "failed",
            delivery: { state: "failed", attempts: 1, enqueuedAt: now - 90_000 }
          },
          {
            id: "run_yesterday",
            jobId: "job_old",
            jobName: "昨日任务",
            startedAt: now - DAY_MS - 60_000,
            finishedAt: now - DAY_MS,
            status: "missed",
            delivery: { state: "expired", attempts: 0, enqueuedAt: now - DAY_MS - 60_000 }
          }
        ]
      }),
      "utf8"
    );

    const { behaviorStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/behavior/behaviorStore.ts")).href
    );

    // 1. 默认关闭（fail-closed），开关持久化。
    assert(behaviorStore.getStatus(now).enabled === false, "默认必须关闭");
    behaviorStore.setEnabled(true);
    behaviorStore.resetMemory();
    assert(behaviorStore.getStatus(now).enabled === true, "开关应持久化");

    // 2. 分钟桶：3 个活跃分钟（含阈值边界 119s）。
    behaviorStore.ingest(
      [
        { tsMs: at(9, 3), idleSec: 10 },
        { tsMs: at(9, 4), idleSec: 0 },
        { tsMs: at(9, 5), idleSec: 119 }
      ],
      0,
      now
    );
    let status = behaviorStore.getStatus(now);
    assert(status.today.activeMinutesByHour[9] === 3, "9 点应有 3 个活跃分钟");
    assert(status.today.activeMinutes === 3, "总活跃分钟应为 3");
    assert(status.today.firstActiveAt === at(9, 3) && status.today.lastActiveAt === at(9, 5), "首末活跃时间应正确");

    // 3. 幂等：同一分钟重放不重复计数（与游标同分钟，不计入乱序）。
    const replayed = behaviorStore.ingest([{ tsMs: at(9, 5), idleSec: 5 }], 0, now);
    assert(replayed.accepted === 0, "重复分钟不应被接受");
    assert(behaviorStore.getStatus(now).today.activeMinutes === 3, "重复分钟不得放大计数");

    // 4. 阈值：120s 不算活跃，但游标应推进。
    behaviorStore.ingest([{ tsMs: at(9, 6), idleSec: 120 }], 0, now);
    status = behaviorStore.getStatus(now);
    assert(status.today.activeMinutes === 3, "120s 不应计活跃");
    assert(status.lastSampleAt === at(9, 6), "非活跃样本也应推进最近采样时间");

    // 5. 乱序样本丢弃并计数。
    const outOfOrder = behaviorStore.ingest([{ tsMs: at(9, 2), idleSec: 1 }], 0, now);
    assert(outOfOrder.accepted === 0, "乱序样本不应被接受");
    assert(behaviorStore.getStatus(now).outOfOrderSamples === 1, "乱序应计数");

    // 6. 非法样本丢弃并计数。
    const rejected = behaviorStore.ingest([{ tsMs: -1, idleSec: 5 }, { foo: 1 }], 0, now);
    assert(rejected.rejected === 2, "非法样本应被拒");
    assert(behaviorStore.getStatus(now).rejectedSamples === 2, "非法样本应计数");

    // 7. 探测失败计数为覆盖式上报（不累加）。
    behaviorStore.ingest([], 7, now);
    behaviorStore.ingest([], 3, now);
    assert(behaviorStore.getStatus(now).probeReadFailures === 3, "探测失败计数应覆盖而非累加");

    // 8. 跨天分桶。
    behaviorStore.ingest([{ tsMs: at(23, 59), idleSec: 5 }], 0, now);
    behaviorStore.ingest([{ tsMs: tomorrowAt(0, 0), idleSec: 5 }], 0, now);
    assert(behaviorStore.getStatus(tomorrowAt(1, 0)).today.activeMinutesByHour[0] === 1, "跨天样本应落到次日 0 点桶");
    assert(behaviorStore.getStatus(now).today.activeMinutes === 4, "当天应含 9 点的 3 分钟 + 23:59 的 1 分钟");

    // 9. 任务计数：从 scheduler run 只读派生，昨天的 missed 不计入今天。
    status = behaviorStore.getStatus(now);
    assert(status.today.taskSucceeded === 1, "今日成功任务应为 1");
    assert(status.today.taskFailed === 1, "今日失败任务应为 1");
    assert(status.today.taskMissed === 0, "昨日 missed 不应计入今天");
    assert(status.runsScanned === 3, "应扫描到 3 条 run");

    // 10. 关闭后拒绝写入，已有数据不变。
    behaviorStore.setEnabled(false);
    const disabledIngest = behaviorStore.ingest([{ tsMs: at(10, 0), idleSec: 1 }], 0, now);
    assert(disabledIngest.disabled === true && disabledIngest.accepted === 0, "关闭后应拒绝写入");
    assert(behaviorStore.getStatus(now).today.activeMinutes === 4, "关闭不得改动已有聚合");

    // 11. 90 天裁剪（注入 91 天，flush 后只留 90 天）。
    const daysFixture = {};
    for (let index = 0; index < 91; index += 1) {
      const key = localKey(now - index * DAY_MS);
      daysFixture[key] = emptyDay(key);
    }
    writeFileSync(
      behaviorFile,
      JSON.stringify({
        version: 1,
        enabled: true,
        retentionDays: 90,
        lastSampleAt: 0,
        lastMinuteKey: 0,
        rejectedSamples: 0,
        outOfOrderSamples: 0,
        corruptCount: 0,
        probeReadFailures: 0,
        days: daysFixture
      }),
      "utf8"
    );
    behaviorStore.resetMemory();
    behaviorStore.setEnabled(true);
    const pruned = JSON.parse(readFileSync(behaviorFile, "utf8"));
    assert(Object.keys(pruned.days).length === 90, "应只保留 90 天");
    assert(!(localKey(now - 90 * DAY_MS) in pruned.days), "第 91 天应被裁掉");

    // 12. 故障注入：损坏文件隔离 + 空状态继续。
    writeFileSync(behaviorFile, "{broken", "utf8");
    behaviorStore.resetMemory();
    const corruptStatus = behaviorStore.getStatus(now);
    assert(corruptStatus.corruptCount === 1, "损坏应计数 1 次");
    assert(corruptStatus.enabled === false, "重建后回到默认关闭");
    assert(
      readdirSync(behaviorDir).some((name) => name.startsWith("daily.corrupt-")),
      "损坏文件应被改名隔离"
    );

    // 13. BEH-02 纯派生：窗口/门槛/早晚期/活跃块/空档/文案/签名。
    const { deriveBehaviorProfile } = await import(
      pathToFileURL(path.join(projectRoot, "server/behavior/behaviorProfile.ts")).href
    );
    const corruptProfile = deriveBehaviorProfile(behaviorStore.readProfileSource(), now);
    assert(
      corruptProfile.status === "disabled" && corruptProfile.memoryDraft === null,
      "损坏文件重建后画像应为 disabled/N/A"
    );
    const profileNow = dayStart.getTime() + 12 * HOUR_MS;
    const profileDayKey = (daysAgo) => {
      const date = new Date(profileNow);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - daysAgo);
      return localKey(date.getTime());
    };

    const morningDays = [];
    for (let index = 0; index < 6; index += 1) {
      morningDays.push(
        profileDay(profileDayKey(index), { 9: 60, 10: 60, 11: 60, 14: 60, 15: 60 }, 9 * 60, 15 * 60 + 59)
      );
    }
    const morningProfile = deriveBehaviorProfile({ enabled: true, days: morningDays }, profileNow);
    assert(morningProfile.status === "ok", "6 天早型样本应可派生画像");
    assert(morningProfile.chronotype === "early", "上午权重高、末次<23 点应判早型");
    assert(morningProfile.evidence.sampleDays === 6, "样本日应为 6");
    assert(morningProfile.confidence === 0.65, "6 天/1800 分钟应为中等置信度");
    assert(
      morningProfile.activeWindows.some((window) => window.startHour === 9 && window.endHourExclusive === 12),
      "9–12 点应为活跃块"
    );
    assert(
      morningProfile.activeWindows.some((window) => window.startHour === 14 && window.endHourExclusive === 16),
      "14–16 点应为第二个活跃块"
    );
    assert(
      morningProfile.restGaps.some((gap) => gap.startHour === 12 && gap.endHourExclusive === 14),
      "12–14 点应为低活跃空档"
    );
    assert(morningProfile.memoryDraft !== null, "ok 画像应带记忆草稿");
    assert(morningProfile.memoryDraft.content.includes("设备活跃偏早"), "文案应写偏早");
    assert(morningProfile.memoryDraft.content.length <= 80, "文案应 ≤80 字");
    assert(!morningProfile.memoryDraft.content.includes("睡眠"), "文案不得写睡眠");
    assert(!morningProfile.memoryDraft.content.includes("专注"), "文案不得写专注");
    const morningAgain = deriveBehaviorProfile({ enabled: true, days: morningDays }, profileNow);
    assert(morningAgain.signature === morningProfile.signature, "同输入应同签名");
    assert(morningAgain.memoryDraft.content === morningProfile.memoryDraft.content, "同输入应同文案");

    const eveningDays = [];
    for (let index = 0; index < 6; index += 1) {
      eveningDays.push(
        profileDay(profileDayKey(index), {
          14: 60,
          15: 60,
          16: 60,
          17: 60,
          18: 60,
          19: 60,
          21: 60,
          22: 60,
          23: 30
        }, 14 * 60, 23 * 60 + 59)
      );
    }
    const eveningProfile = deriveBehaviorProfile({ enabled: true, days: eveningDays }, profileNow);
    assert(
      eveningProfile.status === "ok" && eveningProfile.chronotype === "late",
      "晚间权重高/末次≥23 点应判晚型"
    );
    assert(eveningProfile.memoryDraft.content.includes("设备活跃偏晚"), "文案应写偏晚");

    const neutralDays = [];
    for (let index = 0; index < 6; index += 1) {
      neutralDays.push(
        profileDay(profileDayKey(index), { 9: 60, 10: 60, 17: 60, 18: 60 }, 9 * 60, 18 * 60 + 59)
      );
    }
    const neutralProfile = deriveBehaviorProfile({ enabled: true, days: neutralDays }, profileNow);
    assert(
      neutralProfile.status === "ok" && neutralProfile.chronotype === "neutral",
      "上午/晚间均衡应判居中"
    );

    const unknownProfile = deriveBehaviorProfile({
      enabled: true,
      days: [
        profileDay(profileDayKey(0), { 9: 60 }, 9 * 60, 9 * 60 + 59),
        profileDay(profileDayKey(1), { 9: 30 }, 9 * 60, 9 * 60 + 29),
        profileDay(profileDayKey(2), { 9: 1 }, 9 * 60, 9 * 60)
      ]
    }, profileNow);
    assert(unknownProfile.status === "ok", "3 天/91 分钟应刚好达到画像门槛");
    assert(unknownProfile.chronotype === "unknown", "有效作息日不足 3 天应判 unknown");

    const insufficientProfile = deriveBehaviorProfile({
      enabled: true,
      days: [
        profileDay(profileDayKey(0), { 9: 60 }, 9 * 60, 9 * 60 + 59),
        profileDay(profileDayKey(1), { 9: 60 }, 9 * 60, 9 * 60 + 59)
      ]
    }, profileNow);
    assert(
      insufficientProfile.status === "insufficient_data" && insufficientProfile.memoryDraft === null,
      "少于 3 个样本日应返回 N/A 且不生成草稿"
    );

    const emptyProfile = deriveBehaviorProfile({ enabled: true, days: [] }, profileNow);
    assert(
      emptyProfile.status === "insufficient_data"
        && emptyProfile.reason.includes("行为数据为空")
        && emptyProfile.memoryDraft === null,
      "0 天样本应返回 N/A 且不生成草稿"
    );

    const threeDaysSparse = deriveBehaviorProfile({
      enabled: true,
      days: [
        profileDay(profileDayKey(0), { 9: 20 }, 9 * 60, 9 * 60 + 19),
        profileDay(profileDayKey(1), { 9: 20 }, 9 * 60, 9 * 60 + 19),
        profileDay(profileDayKey(2), { 9: 20 }, 9 * 60, 9 * 60 + 19)
      ]
    }, profileNow);
    assert(
      threeDaysSparse.status === "insufficient_data" && threeDaysSparse.memoryDraft === null,
      "3 天但累计不足 90 分钟应返回 N/A"
    );

    const staleDays = [];
    for (let index = 0; index < 6; index += 1) {
      staleDays.push(
        profileDay(profileDayKey(5 + index), { 9: 60, 10: 60 }, 9 * 60, 10 * 60 + 59)
      );
    }
    const staleProfile = deriveBehaviorProfile({ enabled: true, days: staleDays }, profileNow);
    assert(
      staleProfile.status === "insufficient_data" && staleProfile.reason.includes("近期无采样"),
      "最近数据超过 3 天应返回 N/A"
    );

    const windowedDays = [
      ...morningDays,
      profileDay(
        profileDayKey(20),
        { 0: 60, 1: 60, 2: 60, 3: 60, 4: 60, 5: 60, 6: 60, 7: 60 },
        0,
        7 * 60 + 59
      )
    ];
    const windowedProfile = deriveBehaviorProfile({ enabled: true, days: windowedDays }, profileNow);
    assert(windowedProfile.evidence.sampleDays === 6, "窗口外数据不得计入样本日");
    assert(windowedProfile.evidence.totalActiveMinutes === 1800, "窗口外数据不得计入累计活跃");

    const disabledProfile = deriveBehaviorProfile({ enabled: false, days: morningDays }, profileNow);
    assert(
      disabledProfile.status === "disabled" && disabledProfile.memoryDraft === null,
      "关闭观察时应返回 disabled 且不生成草稿"
    );

    const malformedProfile = deriveBehaviorProfile({
      enabled: true,
      days: [{
        date: profileDayKey(0),
        activeMinutesByHour: [60, -5, Number.NaN],
        activeMinutes: 999,
        firstActiveAt: 0,
        lastActiveAt: 0,
        taskSucceeded: 0,
        taskFailed: 0,
        taskMissed: 0
      }]
    }, profileNow);
    assert(
      malformedProfile.status === "insufficient_data" && malformedProfile.memoryDraft === null,
      "缺字段/脏值应被清洗后按证据不足处理，不得崩溃或编造"
    );

    // 14. HTTP 契约 + 错误码。
    const { handleBehaviorHttpRequest } = await import(
      pathToFileURL(path.join(projectRoot, "server/behavior/behaviorHttpHandlers.ts")).href
    );
    const httpServer = createServer((request, response) => {
      const pathname = (request.url ?? "").split("?")[0];
      void handleBehaviorHttpRequest(request, response, pathname);
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    const postJson = (pathname, body) =>
      fetch(`${origin}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
      });
    try {
      const initial = await (await fetch(`${origin}/void-behavior/status`)).json();
      assert(initial.ok === true && initial.data.enabled === false, "status 应可读且默认关闭");

      const enabled = await (await postJson("/void-behavior/enabled", { enabled: true })).json();
      assert(enabled.ok === true && enabled.data.enabled === true, "开启应生效");

      const sample = await (await postJson("/void-behavior/sample", {
        samples: [{ tsMs: at(14, 0), idleSec: 5 }],
        probeReadFailures: 2
      })).json();
      assert(sample.ok === true && sample.data.accepted === 1, "样本应入桶");

      const afterSample = await (await fetch(`${origin}/void-behavior/status`)).json();
      assert(afterSample.data.today.activeMinutes >= 1, "状态应反映新样本");
      assert(afterSample.data.probeReadFailures === 2, "探测失败计数应透传");

      const off = await (await postJson("/void-behavior/enabled", { enabled: false })).json();
      assert(off.ok === true && off.data.enabled === false, "关闭应生效");
      const disabled = await (await postJson("/void-behavior/sample", {
        samples: [{ tsMs: at(14, 1), idleSec: 5 }]
      })).json();
      assert(disabled.ok === true && disabled.data.disabled === true, "关闭后端点应如实拒绝写入");

      const badEnabled = await postJson("/void-behavior/enabled", { enabled: "yes" });
      assert(badEnabled.status === 400, "非法 enabled 应 400");

      const tooMany = await postJson("/void-behavior/sample", {
        samples: new Array(61).fill({ tsMs: at(14, 2), idleSec: 5 })
      });
      assert(tooMany.status === 400, "超过 60 条应 400");

      const oversized = await postJson("/void-behavior/enabled", {
        enabled: true,
        pad: "x".repeat(70_000)
      });
      assert(oversized.status === 413, "超大体应 413");

      const unknown = await fetch(`${origin}/void-behavior/nope`);
      assert(unknown.status === 404, "未知端点应 404");

      // BEH-02 端点：关闭时 disabled；写入 6 天 fixture 后 ok。
      const profileDisabled = await (await fetch(`${origin}/void-behavior/profile`)).json();
      assert(
        profileDisabled.ok === true && profileDisabled.data.status === "disabled",
        "关闭时 profile 应为 disabled"
      );
      assert(profileDisabled.data.memoryDraft === null, "关闭时不得生成画像草稿");

      const profileDays = {};
      for (let index = 0; index < 6; index += 1) {
        const date = profileDayKey(index);
        profileDays[date] = profileDay(
          date,
          { 9: 60, 10: 60, 11: 60, 14: 60, 15: 60 },
          9 * 60,
          15 * 60 + 59
        );
      }
      writeFileSync(
        behaviorFile,
        JSON.stringify({
          version: 1,
          enabled: true,
          retentionDays: 90,
          lastSampleAt: now,
          lastMinuteKey: 0,
          rejectedSamples: 0,
          outOfOrderSamples: 0,
          corruptCount: 0,
          probeReadFailures: 0,
          days: profileDays
        }),
        "utf8"
      );
      behaviorStore.resetMemory();
      const profileOk = await (await fetch(`${origin}/void-behavior/profile`)).json();
      assert(profileOk.ok === true && profileOk.data.status === "ok", "6 天样本应返回 ok 画像");
      assert(profileOk.data.enabled === true, "ok 画像应反映 enabled=true");
      assert(profileOk.data.chronotype === "early", "端点画像应为早型");
      assert(profileOk.data.evidence.sampleDays === 6, "端点样本日应为 6");
      assert(
        profileOk.data.memoryDraft && profileOk.data.memoryDraft.content.includes("设备活跃偏早"),
        "端点应返回记忆草稿"
      );
      assert(profileOk.data.memoryDraft.content.length <= 80, "端点文案应 ≤80 字");
      assert(typeof profileOk.data.signature === "string" && profileOk.data.signature.length > 0, "端点应返回签名");
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
    }

    // 15. BEH-02 记忆适配：稳定 id、幂等、墓碑、policy、写盘故障。
    const memoryShim = new Map();
    const globalScope = globalThis;
    const previousWindow = globalScope.window;
    globalScope.window = {
      localStorage: {
        getItem: (key) => (memoryShim.has(key) ? memoryShim.get(key) : null),
        setItem: (key, value) => void memoryShim.set(key, String(value)),
        removeItem: (key) => void memoryShim.delete(key)
      }
    };
    try {
      const memoryStore = await import(
        pathToFileURL(path.join(projectRoot, "src/features/memory/memoryStore.ts")).href
      );
      const profileMemory = await import(
        pathToFileURL(path.join(projectRoot, "src/features/behavior/behaviorProfileMemory.ts")).href
      );
      const {
        applyBehaviorProfileToMemory,
        BEHAVIOR_PROFILE_MEMORY_ID,
        BEHAVIOR_PROFILE_SYNC_STATE_KEY
      } = profileMemory;
      const draft = {
        memoryType: "preference",
        subjectType: "self",
        subjectName: "用户本人",
        content: "设备活跃偏早：主要 09–12 点。近14天6天样本·中等置信度（至11-12，仅电脑活跃）",
        confidence: 0.65,
        source: "behaviorProfile"
      };
      const okProfile = { status: "ok", enabled: true, memoryDraft: draft };
      const t0 = now;

      memoryStore.clearMemories();
      window.localStorage.removeItem(BEHAVIOR_PROFILE_SYNC_STATE_KEY);
      const first = applyBehaviorProfileToMemory(okProfile, t0);
      assert(first.action === "written", "首次应写入画像");
      let entries = memoryStore.listMemories();
      assert(entries.length === 1, "首次写入应只有 1 条");
      assert(entries[0].id === BEHAVIOR_PROFILE_MEMORY_ID, "应使用稳定 id");
      assert(
        entries[0].memoryType === "preference" && entries[0].subjectType === "self",
        "应落 preference/self"
      );
      assert(entries[0].source === "behaviorProfile", "来源应为 behaviorProfile");
      assert(entries[0].createdAt === t0 && entries[0].updatedAt === t0, "首次时间戳应正确");

      const second = applyBehaviorProfileToMemory(okProfile, t0 + 1000);
      assert(second.action === "unchanged", "重复同步应 unchanged");
      entries = memoryStore.listMemories();
      assert(entries.length === 1 && entries[0].updatedAt === t0, "unchanged 不得刷新 updatedAt");

      const secondAgain = applyBehaviorProfileToMemory(okProfile, t0 + 1500);
      assert(secondAgain.action === "unchanged", "第三次同画像仍应 unchanged");
      entries = memoryStore.listMemories();
      assert(
        entries.length === 1 && entries[0].updatedAt === t0,
        "第三次同画像不得新增或刷新时间"
      );

      const changed = {
        ...okProfile,
        memoryDraft: { ...draft, content: draft.content.replace("偏早", "偏晚") }
      };
      const third = applyBehaviorProfileToMemory(changed, t0 + 2000);
      assert(third.action === "updated", "文案变化应原地更新");
      entries = memoryStore.listMemories();
      assert(entries.length === 1 && entries[0].id === BEHAVIOR_PROFILE_MEMORY_ID, "更新后仍应只有 1 条");
      assert(
        entries[0].createdAt === t0 && entries[0].updatedAt === t0 + 2000,
        "更新应保留 createdAt 并刷新 updatedAt"
      );
      assert(entries[0].content.includes("偏晚"), "更新应写入新文案");

      memoryStore.removeMemory(BEHAVIOR_PROFILE_MEMORY_ID);
      const dismissed = applyBehaviorProfileToMemory(okProfile, t0 + 3000);
      assert(
        dismissed.action === "skipped" && dismissed.reason === "dismissed",
        "删除后应墓碑，不自动复活"
      );
      assert(memoryStore.listMemories().length === 0, "墓碑后不得有画像条目");

      const disabled = applyBehaviorProfileToMemory(
        { status: "disabled", enabled: false, memoryDraft: null },
        t0 + 4000
      );
      assert(
        disabled.action === "skipped" && disabled.reason === "disabled",
        "关闭时不得写入"
      );
      const reEnabled = applyBehaviorProfileToMemory(okProfile, t0 + 5000);
      assert(reEnabled.action === "written", "重新开启观察应允许重新写入");
      assert(memoryStore.listMemories().length === 1, "重新开启后应写回 1 条");

      const disabledWithEntry = applyBehaviorProfileToMemory(
        { status: "disabled", enabled: false, memoryDraft: null },
        t0 + 5500
      );
      assert(
        disabledWithEntry.action === "skipped" && disabledWithEntry.reason === "disabled",
        "关闭时已有条目应跳过"
      );
      entries = memoryStore.listMemories();
      assert(
        entries.length === 1 && entries[0].content.includes("偏早"),
        "关闭不得删除或改写已有画像"
      );

      // policy 故障注入：即使 owner 出错产出了凭证文本，也不得落库。
      memoryStore.clearMemories();
      window.localStorage.removeItem(BEHAVIOR_PROFILE_SYNC_STATE_KEY);
      const secret = applyBehaviorProfileToMemory({
        status: "ok",
        enabled: true,
        memoryDraft: { ...draft, content: "密码：abc12345" }
      }, t0 + 6000);
      assert(
        secret.action === "skipped" && secret.reason === "policy_blocked",
        "凭证文本应被 policy 拦截"
      );
      assert(memoryStore.listMemories().length === 0, "policy 拦截后不得落库");

      const invalid = applyBehaviorProfileToMemory({
        status: "ok",
        enabled: true,
        memoryDraft: { ...draft, content: "" }
      }, t0 + 7000);
      assert(
        invalid.action === "skipped" && invalid.reason === "invalid_draft",
        "空文案应判 invalid_draft"
      );

      // 写盘故障注入：localStorage.setItem 抛错时返回 write_failed，不向 UI 抛错。
      memoryStore.clearMemories();
      window.localStorage.removeItem(BEHAVIOR_PROFILE_SYNC_STATE_KEY);
      applyBehaviorProfileToMemory(okProfile, t0 + 8000);
      memoryStore.removeMemory(BEHAVIOR_PROFILE_MEMORY_ID);
      window.localStorage.removeItem(BEHAVIOR_PROFILE_SYNC_STATE_KEY);
      const originalWarn = console.warn;
      const originalSetItem = window.localStorage.setItem;
      let writeFailed;
      try {
        // 预期的配额故障：静音本次 warn，保持 smoke 输出干净。
        console.warn = () => {};
        window.localStorage.setItem = () => {
          throw new Error("quota");
        };
        writeFailed = applyBehaviorProfileToMemory(okProfile, t0 + 9000);
      } finally {
        window.localStorage.setItem = originalSetItem;
        console.warn = originalWarn;
      }
      assert(
        writeFailed.action === "skipped" && writeFailed.reason === "write_failed",
        "写盘失败应返回 write_failed"
      );
      assert(memoryStore.listMemories().length === 0, "写盘失败后不得出现半条记忆");
    } finally {
      globalScope.window = previousWindow;
    }

    console.log("[agent-behavior-smoke] PASSED");
    console.log(
      " - 默认关闭/分钟幂等/阈值/乱序/非法/跨天/任务派生/关闭拒绝写入全对；" +
        "90 天裁剪、损坏隔离、HTTP 400/404/413 全对"
    );
    console.log(
      " - BEH-02 画像：早/晚/居中/证据不足、窗口/空档、稳定 id 幂等、删除墓碑、policy 拦截、写盘故障全对"
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-behavior-smoke] FAILED", error);
  process.exitCode = 1;
});
