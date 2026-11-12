// PRO-04 安静时段冒烟：纯策略边界 + 持久化损坏 + 投递闸门 + 无假成功。
// 用法：npx tsx scripts/agent-proactivity-smoke.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectInvalid(work) {
  try {
    work();
  } catch (error) {
    assert(error?.proactivityCode === "INVALID_REQUEST", `期望 INVALID_REQUEST，实际 ${error?.proactivityCode}`);
    return;
  }
  throw new Error("预期失败 INVALID_REQUEST，实际成功");
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-proactivity-root-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const {
      DEFAULT_QUIET_HOURS,
      defaultQuietHoursConfig,
      evaluateQuietHours,
      parseQuietHoursConfig
    } = await import(pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityPolicy.ts")).href);
    const { proactivityStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityStore.ts")).href
    );
    const { proactivityLevelStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityLevelStore.ts")).href
    );
    const {
      DEFAULT_PROACTIVITY_LEVEL,
      parseProactivityLevel,
      resolveProactivityBudget
    } = await import(pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityLevelPolicy.ts")).href);
    const { handleProactivityLevelHttpRequest } = await import(
      pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityLevelHttpHandlers.ts")).href
    );
    const { schedulerStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/scheduler/schedulerStore.ts")).href
    );
    const { handleProactivityHttpRequest } = await import(
      pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityHttpHandlers.ts")).href
    );

    // 固定本地墙钟；不依赖测试执行时的真实时间。
    const t = (hour, minute, day = 12) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();

    function useProactivityDir(name) {
      process.env.VOID_PROACTIVITY_DIR = path.join(runtimeRoot, `proactivity-${name}`);
      proactivityStore.resetMemory();
      proactivityLevelStore.resetMemory();
      return process.env.VOID_PROACTIVITY_DIR;
    }

    function useLevelDir(name) {
      process.env.VOID_PROACTIVITY_DIR = path.join(runtimeRoot, `level-${name}`);
      proactivityLevelStore.resetMemory();
      return process.env.VOID_PROACTIVITY_DIR;
    }

    function useSchedulerDir(name) {
      process.env.VOID_SCHEDULER_DIR = path.join(runtimeRoot, `scheduler-${name}`);
      schedulerStore.resetMemory();
    }

    function appendPendingRun({ jobId, origin, enqueuedAt }) {
      return schedulerStore.appendRun({
        jobId,
        jobName: jobId,
        startedAt: enqueuedAt,
        status: "succeeded",
        summary: jobId,
        origin,
        delivery: { state: "pending", attempts: 0, enqueuedAt }
      });
    }

    // 1) 默认窗口边界：开始含、结束不含。
    const defaultConfig = defaultQuietHoursConfig();
    assert(DEFAULT_QUIET_HOURS.enabled === true, "默认应开启安静时段");
    assert(evaluateQuietHours(defaultConfig, t(22, 59)).quiet === false, "22:59 不应安静");
    assert(evaluateQuietHours(defaultConfig, t(23, 0)).quiet === true, "23:00 应进入安静");
    assert(evaluateQuietHours(defaultConfig, t(0, 0)).quiet === true, "00:00 应安静");
    assert(evaluateQuietHours(defaultConfig, t(7, 59)).quiet === true, "07:59 应安静");
    assert(evaluateQuietHours(defaultConfig, t(8, 0)).quiet === false, "08:00 应解除安静");

    // 2) 跨午夜结束时间：23:30 指向明天 08:00；07:30 指向今天 08:00。
    const lateNight = evaluateQuietHours(defaultConfig, t(23, 30));
    assert(lateNight.quiet === true && lateNight.windowEndsAt === t(8, 0, 13), "23:30 应延至次日 08:00");
    const earlyMorning = evaluateQuietHours(defaultConfig, t(7, 30));
    assert(earlyMorning.quiet === true && earlyMorning.windowEndsAt === t(8, 0, 12), "07:30 应延至当天 08:00");

    // 3) 同日窗口。
    const noonWindow = { enabled: true, startMinutes: 12 * 60, endMinutes: 14 * 60 };
    assert(evaluateQuietHours(noonWindow, t(11, 59)).quiet === false, "11:59 不应安静");
    assert(evaluateQuietHours(noonWindow, t(12, 0)).quiet === true, "12:00 应安静");
    assert(evaluateQuietHours(noonWindow, t(13, 59)).quiet === true, "13:59 应安静");
    assert(evaluateQuietHours(noonWindow, t(14, 0)).quiet === false, "14:00 应解除");

    // 4) 关闭开关；非法配置必须回退默认，绝不变成全天放行。
    assert(evaluateQuietHours({ ...defaultConfig, enabled: false }, t(23, 30)).quiet === false, "关闭后不应安静");
    assert(evaluateQuietHours({ enabled: true, startMinutes: 600, endMinutes: 600 }, t(23, 30)).quiet === true,
      "start==end 非法配置应回退默认安静窗口");

    // 5) 配置解析边界。
    assert(parseQuietHoursConfig({ enabled: true, startMinutes: 1380, endMinutes: 480 }).ok === true, "合法配置应通过");
    assert(parseQuietHoursConfig({ enabled: true, startMinutes: 600, endMinutes: 600 }).ok === false, "同值应拒绝");
    assert(parseQuietHoursConfig({ enabled: true, startMinutes: -1, endMinutes: 480 }).ok === false, "越界应拒绝");
    assert(parseQuietHoursConfig({ enabled: true, startMinutes: 720, endMinutes: 1440 }).ok === false, "1440 应拒绝");
    assert(parseQuietHoursConfig({ enabled: "yes", startMinutes: 720, endMinutes: 840 }).ok === false, "非布尔应拒绝");

    // 6) 配置缺失：用默认窗口，不写文件。
    const missingDir = useProactivityDir("missing");
    const missing = proactivityStore.getStatus(t(23, 30));
    assert(missing.configStatus === "missing" && missing.config.enabled === true, "缺失应回默认开启");
    assert(missing.quiet === true && missing.config.startMinutes === 23 * 60, "缺失时夜间仍应安静");
    assert(existsSync(path.join(missingDir, "quiet-hours.json")) === false, "只读状态不应写配置文件");

    // 7) 配置损坏：隔离坏文件，按默认窗口继续；白天不得变成全天静默。
    const corruptDir = useProactivityDir("corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(path.join(corruptDir, "quiet-hours.json"), "{broken", "utf8");
    const corrupt = proactivityStore.getStatus(t(23, 30));
    assert(corrupt.configStatus === "corrupt" && corrupt.quiet === true, "损坏时应回默认安静窗口");
    assert(
      readdirSync(corruptDir).some((name) => name.startsWith("quiet-hours.corrupt-")),
      "损坏文件应被改名隔离"
    );
    assert(proactivityStore.getStatus(t(12, 0)).quiet === false, "损坏不得变成全天可打扰，也不得全天静默");

    // 8) 保存 → 重读 → 非法保存不覆盖。
    useProactivityDir("save");
    const saved = proactivityStore.setQuietHours(
      { enabled: true, startMinutes: 12 * 60, endMinutes: 14 * 60 },
      t(13, 0)
    );
    assert(saved.configStatus === "ok" && saved.quiet === true, "保存后应立即可读");
    proactivityStore.resetMemory();
    const reloaded = proactivityStore.getStatus(t(13, 0));
    assert(reloaded.configStatus === "ok" && reloaded.config.startMinutes === 720 && reloaded.config.endMinutes === 840,
      "重启后配置应恢复");
    expectInvalid(() => proactivityStore.setQuietHours({ enabled: true, startMinutes: 600, endMinutes: 600 }, t(13, 0)));
    assert(proactivityStore.getStatus(t(13, 0)).config.startMinutes === 720, "非法保存不得覆盖已保存配置");

    // 9) 白天/夜间投递闸门：用户提醒与代理主动同样 hold，来源保留。
    useSchedulerDir("hold");
    useProactivityDir("hold");
    proactivityStore.setQuietHours({ enabled: true, startMinutes: 23 * 60, endMinutes: 8 * 60 }, t(12, 0));
    const quietNow = t(23, 30);
    const userRun = appendPendingRun({ jobId: "user-reminder", origin: "calendar", enqueuedAt: quietNow - 2 * 60 * 60_000 });
    const agentRun = appendPendingRun({ jobId: "agent-proactive", origin: "agent", enqueuedAt: quietNow - 2 * 60 * 60_000 });
    const held = schedulerStore.claimPendingDelivery(10, quietNow);
    assert(held.length === 0, "安静时段 claim 必须返回空");
    const heldRuns = schedulerStore.listRuns(100);
    for (const [run, origin] of [[userRun, "calendar"], [agentRun, "agent"]]) {
      const view = heldRuns.find((item) => item.id === run.id);
      assert(view.delivery.state === "pending", "被拦消息必须保持 pending");
      assert(view.delivery.holdReason === "QUIET_HOURS", "被拦消息必须带 QUIET_HOURS 原因");
      assert(view.delivery.holdUntil === t(8, 0, 13), "holdUntil 应指向安静结束");
      assert(view.delivery.attempts === 0, "安静时不得递增 attempts");
      assert(view.origin === origin, "run 应保留投递来源");
    }
    assert(schedulerStore.countUndelivered() === 2, "托盘未读计数应包含被延后消息");

    // 无假成功：pending 不能被 ack 成 sent。
    const fakeAck = schedulerStore.recordDeliveryResults([{ runId: userRun.id, result: "sent" }]);
    assert(fakeAck === 0, "pending 不应接受 sent ack");
    assert(
      schedulerStore.listRuns(100).find((run) => run.id === userRun.id).delivery.state === "pending",
      "假 ack 后必须仍是 pending"
    );

    // 崩溃恢复：hold 字段必须已落盘，重启后仍能看到延后原因。
    schedulerStore.resetMemory();
    const afterRestart = schedulerStore.listRuns(100);
    assert(
      afterRestart.find((run) => run.id === userRun.id)?.delivery.holdReason === "QUIET_HOURS"
        && afterRestart.find((run) => run.id === userRun.id)?.delivery.holdUntil === t(8, 0, 13),
      "重启后 holdUntil/holdReason 应保留"
    );

    // 安静结束：两条都应在 08:00 被领取，再按真实结果落账。
    const released = schedulerStore.claimPendingDelivery(10, t(8, 0, 13));
    assert(released.some((run) => run.id === userRun.id) && released.some((run) => run.id === agentRun.id),
      "08:00 应解除 hold 并领取两条");
    const delivered = schedulerStore.recordDeliveryResults([
      { runId: userRun.id, result: "sent" },
      { runId: agentRun.id, result: "sent" }
    ]);
    assert(delivered === 2, "真实 ack 应落两条 sent");

    // 10) 安静时段内不判过期；解除后按 holdUntil 起算新鲜度。
    useSchedulerDir("no-expire");
    useProactivityDir("no-expire");
    proactivityStore.setQuietHours({ enabled: true, startMinutes: 23 * 60, endMinutes: 8 * 60 }, t(12, 0));
    const staleButHeld = appendPendingRun({ jobId: "stale-held", origin: "user", enqueuedAt: t(22, 0) });
    assert(schedulerStore.claimPendingDelivery(10, t(23, 30)).length === 0, "安静时应拦截");
    const staleHeldView = schedulerStore.listRuns(100).find((run) => run.id === staleButHeld.id);
    assert(staleHeldView.delivery.state === "pending", "入队 90 分钟也不能在安静时段过期");
    const freshAfterQuiet = schedulerStore.claimPendingDelivery(10, t(8, 30, 13));
    assert(freshAfterQuiet.some((run) => run.id === staleButHeld.id), "解除后 30 分钟仍应可投递");

    useSchedulerDir("expired");
    useProactivityDir("expired");
    proactivityStore.setQuietHours({ enabled: true, startMinutes: 23 * 60, endMinutes: 8 * 60 }, t(12, 0));
    const staleAfterQuiet = appendPendingRun({ jobId: "stale-after", origin: "user", enqueuedAt: t(22, 0) });
    assert(schedulerStore.claimPendingDelivery(10, t(23, 30)).length === 0, "安静时应拦截");
    const expiredClaim = schedulerStore.claimPendingDelivery(10, t(9, 1, 13));
    assert(!expiredClaim.some((run) => run.id === staleAfterQuiet.id), "解除后超过 60 分钟不应补发");
    assert(
      schedulerStore.listRuns(100).find((run) => run.id === staleAfterQuiet.id).delivery.state === "expired",
      "解除后超时应落 expired 留痕"
    );

    // 11) 用户提前关闭安静：下一轮立即解除，不等原窗口结束。
    useSchedulerDir("early");
    useProactivityDir("early");
    proactivityStore.setQuietHours({ enabled: true, startMinutes: 23 * 60, endMinutes: 8 * 60 }, t(12, 0));
    const earlyRun = appendPendingRun({ jobId: "early", origin: "user", enqueuedAt: t(23, 30) });
    assert(schedulerStore.claimPendingDelivery(10, t(23, 30)).length === 0, "安静时应拦截");
    proactivityStore.setQuietHours({ enabled: false, startMinutes: 23 * 60, endMinutes: 8 * 60 }, t(23, 30));
    const earlyClaim = schedulerStore.claimPendingDelivery(10, t(23, 31));
    assert(earlyClaim.some((run) => run.id === earlyRun.id), "关闭安静后应立即解除 hold");

    // 12) 策略异常 fail-closed：本轮不领取，pending 保留并带可见原因。
    useSchedulerDir("policy-error");
    useProactivityDir("policy-error");
    proactivityStore.setQuietHours({ enabled: false, startMinutes: 23 * 60, endMinutes: 8 * 60 }, t(12, 0));
    const errorRun = appendPendingRun({ jobId: "policy-error", origin: "user", enqueuedAt: t(12, 0) });
    const originalEvaluate = proactivityStore.evaluate;
    proactivityStore.evaluate = () => {
      throw new Error("injected policy failure");
    };
    try {
      const errorClaim = schedulerStore.claimPendingDelivery(10, t(12, 1));
      assert(errorClaim.length === 0, "策略异常时不得投递");
      const errorView = schedulerStore.listRuns(100).find((run) => run.id === errorRun.id);
      assert(
        errorView.delivery.state === "pending"
          && errorView.delivery.holdReason === "QUIET_POLICY_ERROR"
          && errorView.delivery.holdUntil > t(12, 1),
        "策略异常应落 pending + QUIET_POLICY_ERROR"
      );
    } finally {
      proactivityStore.evaluate = originalEvaluate;
    }
    const recovered = schedulerStore.claimPendingDelivery(10, t(12, 2));
    assert(recovered.some((run) => run.id === errorRun.id), "策略恢复后应解除暂停");

    // 13) PRO-02 主动等级：默认平衡、三档预算、非法拒绝、损坏隔离、落盘重读。
    useLevelDir("policy");
    const defaultLevel = proactivityLevelStore.getStatus(t(9, 0));
    assert(defaultLevel.level === "balanced" && defaultLevel.configStatus === "missing", "等级缺失应回退平衡");
    assert(DEFAULT_PROACTIVITY_LEVEL === "balanced", "默认等级必须是平衡");
    assert(defaultLevel.budget.heartbeatIntervalMs === 60 * 60_000 && defaultLevel.budget.heartbeatDailyCap === 24,
      "平衡档预算应为 60min/24");
    assert(resolveProactivityBudget("restrained") === null, "克制档必须停止代理主动");
    const attentiveBudget = resolveProactivityBudget("attentive");
    assert(attentiveBudget.heartbeatIntervalMs === 30 * 60_000 && attentiveBudget.heartbeatDailyCap === 48,
      "积极档预算应为 30min/48");
    assert(parseProactivityLevel({ level: "medium" }).ok === false, "未知档位应拒绝");
    assert(parseProactivityLevel({ level: 2 }).ok === false, "数字档位应拒绝");

    const savedLevel = proactivityLevelStore.setLevel({ level: "attentive" }, t(10, 0));
    assert(savedLevel.level === "attentive" && savedLevel.configStatus === "ok", "保存后应立即可读");
    proactivityLevelStore.resetMemory();
    const reloadedLevel = proactivityLevelStore.getStatus(t(10, 0));
    assert(reloadedLevel.level === "attentive" && reloadedLevel.budget.heartbeatDailyCap === 48, "重启后等级应恢复");
    expectInvalid(() => proactivityLevelStore.setLevel({ level: "medium" }, t(10, 0)));
    assert(proactivityLevelStore.getStatus(t(10, 0)).level === "attentive", "非法保存不得覆盖已保存等级");

    const corruptLevelDir = useLevelDir("corrupt");
    mkdirSync(corruptLevelDir, { recursive: true });
    writeFileSync(path.join(corruptLevelDir, "level.json"), "{broken", "utf8");
    const corruptLevel = proactivityLevelStore.getStatus(t(10, 0));
    assert(corruptLevel.configStatus === "corrupt" && corruptLevel.level === "balanced",
      "损坏应隔离并回退平衡，绝不静默变成积极");
    assert(readdirSync(corruptLevelDir).some((name) => name.startsWith("level.corrupt-")),
      "损坏等级文件应被隔离");

    // 14) HTTP 契约：读、非法保存、合法保存、未知端点。
    useProactivityDir("http");
    const httpServer = createServer((request, response) => {
      const pathname = (request.url ?? "").split("?")[0];
      if (pathname === "/void-proactivity/level") {
        void handleProactivityLevelHttpRequest(request, response, pathname);
        return;
      }
      void handleProactivityHttpRequest(request, response, pathname);
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    const getJson = async (pathname) => (await fetch(`${origin}${pathname}`)).json();
    const postJson = async (pathname, body) => (await fetch(`${origin}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })).json();
    try {
      const status0 = await getJson("/void-proactivity/status");
      assert(status0.ok === true && status0.data.configStatus === "missing", "首次读取应为 missing + 默认值");

      const bad = await postJson("/void-proactivity/quiet-hours", { enabled: true, startMinutes: 600, endMinutes: 600 });
      assert(bad.ok === false && bad.error.code === "INVALID_REQUEST", "同值保存应 400");

      const good = await postJson("/void-proactivity/quiet-hours", { enabled: true, startMinutes: 720, endMinutes: 840 });
      assert(good.ok === true && good.data.config.startMinutes === 720 && good.data.configStatus === "ok",
        "合法保存应返回新状态");

      const status1 = await getJson("/void-proactivity/status");
      assert(status1.data.config.endMinutes === 840, "读取应反映已保存配置");

      const missingRoute = await getJson("/void-proactivity/nope");
      assert(missingRoute.ok === false && missingRoute.error.code === "NOT_FOUND", "未知端点应 404 语义");

      const level0 = await getJson("/void-proactivity/level");
      assert(level0.ok === true && level0.data.level === "balanced", "等级缺失应回退平衡");
      const badLevel = await postJson("/void-proactivity/level", { level: "medium" });
      assert(badLevel.ok === false && badLevel.error.code === "INVALID_REQUEST", "非法等级应 400");
      const goodLevel = await postJson("/void-proactivity/level", { level: "restrained" });
      assert(goodLevel.ok === true && goodLevel.data.budget === null, "克制档预算应为 null");
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
    }

    console.log("[agent-proactivity-smoke] PASSED");
    console.log(" - 边界：默认 23:00–08:00，开始含/结束不含；同日窗口；关闭开关；非法配置回退默认");
    console.log(" - 跨午夜：23:30→次日 08:00，07:30→当天 08:00；nextChangeAt/holdUntil 正确");
    console.log(" - 配置：缺失用默认不写盘；损坏隔离并回默认；保存/重读；非法保存不覆盖");
    console.log(" - 投递闸门：用户提醒与代理主动同样 hold；来源保留；托盘计数包含延后消息");
    console.log(" - 无假成功：pending 不接受 ack(sent)；解除后按真实结果 sent");
    console.log(" - 崩溃恢复：hold 字段落盘，重启后仍保留原因与解除时间");
    console.log(" - 新鲜度：安静内不判过期；解除后 30 分钟可投；超过 60 分钟 expired");
    console.log(" - 提前关闭：下一轮立即解除；策略异常 fail-closed；HTTP 契约读写/400/404");
    console.log(" - PRO-02 等级：默认平衡；三档预算（克制 null/平衡 60min·24/积极 30min·48）；非法拒绝；损坏回退平衡");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-proactivity-smoke] FAILED", error);
  process.exitCode = 1;
});
