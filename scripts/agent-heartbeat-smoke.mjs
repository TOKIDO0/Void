// PRO-05 静默巡检冒烟：确定性检查 + 24h 去重 + PRO-06 入队 + PRO-04 闸门 + 故障注入。
// 用法：npx tsx scripts/agent-heartbeat-smoke.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-heartbeat-root-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const {
      filterFreshIssues,
      localDayKey,
      parseHeartbeatChecklist
    } = await import(pathToFileURL(path.join(projectRoot, "server/heartbeat/heartbeatPolicy.ts")).href);
    const { heartbeatStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/heartbeat/heartbeatStore.ts")).href
    );
    const {
      getHeartbeatStatus,
      runHeartbeatRound,
      setHeartbeatEnabled,
      shouldRunHeartbeatNow
    } = await import(pathToFileURL(path.join(projectRoot, "server/heartbeat/heartbeatRunner.ts")).href);
    const { handleHeartbeatHttpRequest } = await import(
      pathToFileURL(path.join(projectRoot, "server/heartbeat/heartbeatHttpHandlers.ts")).href
    );
    const { MAX_PENDING_DELIVERY, schedulerStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/scheduler/schedulerStore.ts")).href
    );
    const { calendarStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/calendar/calendarStore.ts")).href
    );
    const { proactivityStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityStore.ts")).href
    );
    const { proactivityLevelStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/proactivity/proactivityLevelStore.ts")).href
    );

    // 固定本地墙钟；不依赖测试执行时的真实时间。
    const t = (hour, minute, day = 12) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
    const DAY_MS = 24 * 60 * 60 * 1000;

    let dirCounter = 0;
    function useDirs(name) {
      dirCounter += 1;
      const suffix = `${name}-${dirCounter}`;
      process.env.VOID_HEARTBEAT_DIR = path.join(runtimeRoot, `heartbeat-${suffix}`);
      process.env.VOID_SCHEDULER_DIR = path.join(runtimeRoot, `scheduler-${suffix}`);
      process.env.VOID_CALENDAR_DIR = path.join(runtimeRoot, `calendar-${suffix}`);
      process.env.VOID_PROACTIVITY_DIR = path.join(runtimeRoot, `proactivity-${suffix}`);
      heartbeatStore.resetMemory();
      schedulerStore.resetMemory();
      calendarStore.resetMemory();
      proactivityStore.resetMemory();
      proactivityLevelStore.resetMemory();
    }

    const heartbeatDir = () => process.env.VOID_HEARTBEAT_DIR;
    const checklistPath = () => path.join(heartbeatDir(), "HEARTBEAT.md");
    const statePath = () => path.join(heartbeatDir(), "state.json");

    function writeChecklist(text) {
      mkdirSync(heartbeatDir(), { recursive: true });
      writeFileSync(checklistPath(), text, "utf8");
    }

    function readState() {
      return JSON.parse(readFileSync(statePath(), "utf8"));
    }

    function writeState(state) {
      mkdirSync(heartbeatDir(), { recursive: true });
      writeFileSync(statePath(), JSON.stringify(state), "utf8");
      heartbeatStore.resetMemory();
    }

    function addEvent({ title, startAt, endAt, remindMinutesBefore = 0, reminderJobId, allDay = false }) {
      return calendarStore.insertEvent({
        title,
        startAt,
        endAt,
        allDay,
        participants: [],
        status: "planned",
        remindMinutesBefore,
        source: "user",
        reminderJobId
      });
    }

    function heartbeatRuns() {
      return schedulerStore.listRuns(100).filter((run) => run.jobId === "heartbeat");
    }

    // 0) 结构约束：巡检器不得新开通知/语音通道，也不得调用模型。
    const runnerSource = readFileSync(path.join(projectRoot, "server/heartbeat/heartbeatRunner.ts"), "utf8");
    const policySource = readFileSync(path.join(projectRoot, "server/heartbeat/heartbeatPolicy.ts"), "utf8");
    assert(!/sendNotification|speakDeliveryText|tray_set_unread/.test(runnerSource),
      "巡检器不得直接发通知或播报");
    assert(!/runAgentToolLoop|modelConfig|apiKey|chatCompletion/i.test(runnerSource + policySource),
      "巡检不得依赖模型（本轮零 LLM）");
    assert(!/features\/voice|voidConversation/.test(runnerSource + policySource),
      "巡检不得触碰用户主动对话链路");

    // 1) 默认关闭：不读清单、不写 run、不产生通知。
    useDirs("default");
    const defaultStatus = getHeartbeatStatus(t(9, 0));
    assert(defaultStatus.enabled === false && defaultStatus.configStatus === "missing", "默认必须关闭");
    assert(defaultStatus.checklist.status === "missing", "默认清单应缺失");
    const disabledRound = runHeartbeatRound({ nowMs: t(9, 0) });
    assert(disabledRound.outcome === "SKIPPED" && disabledRound.skippedReason === "DISABLED", "关闭时应跳过");
    assert(schedulerStore.listRuns(100).length === 0, "关闭时不得写 run");

    // 2) 开启生成模板；已有清单绝不覆盖。
    useDirs("enable");
    const enabled = setHeartbeatEnabled(true, t(9, 0));
    assert(enabled.createdChecklist === true, "开启且无清单时应生成模板");
    assert(enabled.status.enabled === true && enabled.status.checklist.status === "ok", "开启后清单应可用");
    assert(enabled.status.checklist.checks.length === 5, "模板应启用 5 项检查");
    const customChecklist = "- calendar-conflict\n";
    writeChecklist(customChecklist);
    const again = setHeartbeatEnabled(true, t(9, 0));
    assert(again.createdChecklist === false, "已有清单不得重复创建");
    assert(readFileSync(checklistPath(), "utf8") === customChecklist, "用户清单内容必须原样保留");
    assert(again.status.checklist.checks.length === 1, "清单只应启用写明的检查");

    // 3) 无变化：NO_ISSUES，不写 run。
    useDirs("no-issues");
    setHeartbeatEnabled(true, t(9, 0));
    const noIssues = runHeartbeatRound({ nowMs: t(9, 0) });
    assert(noIssues.outcome === "NO_ISSUES" && noIssues.notified === 0, "无变化应为 NO_ISSUES");
    assert(schedulerStore.listRuns(100).length === 0, "无变化不得写 run");

    // 4) 可行动问题：入 PRO-06 pending → claim → sent；pending 不得假 ack。
    useDirs("notify");
    setHeartbeatEnabled(true, t(9, 0));
    addEvent({ title: "评审", startAt: t(10, 0), endAt: t(11, 0) });
    addEvent({ title: "周会", startAt: t(10, 30), endAt: t(11, 30) });
    const notified = runHeartbeatRound({ nowMs: t(9, 0) });
    assert(notified.outcome === "NOTIFIED" && notified.notified >= 1, "有可行动问题时应入队");
    assert(notified.summary && notified.summary.length <= 190, "汇总不得超过 190 字");
    assert(heartbeatRuns().length === 1, "一轮只产生一条 run");
    const heartbeatRun = heartbeatRuns()[0];
    assert(heartbeatRun.origin === "agent" && heartbeatRun.jobName === "静默巡检", "run 必须标记代理主动");
    assert(heartbeatRun.delivery.state === "pending", "入队必须 pending");
    assert(schedulerStore.recordDeliveryResults([{ runId: heartbeatRun.id, result: "sent" }]) === 0,
      "pending 不得被 ack 成 sent（无假成功）");
    assert(heartbeatRuns()[0].delivery.state === "pending", "假 ack 后必须仍是 pending");
    const claimed = schedulerStore.claimPendingDelivery(10, t(9, 1));
    assert(claimed.some((run) => run.id === heartbeatRun.id), "非安静时段应被领取");
    const claimedHeartbeat = claimed.find((run) => run.id === heartbeatRun.id);
    assert(claimedHeartbeat.delivery.speechPlan?.allowed === false
      && claimedHeartbeat.delivery.speechPlan.reason === "AGENT_SILENT",
    "代理主动必须永不播报（PRO-01）");
    assert(schedulerStore.recordDeliveryResults([{ runId: heartbeatRun.id, result: "sent" }]) === 1,
      "真实结果应落 sent");
    assert(heartbeatRuns()[0].delivery.state === "sent", "送达后应为 sent");

    // 5) 同一问题重复巡检：fingerprint 去重，不重复提醒。
    const duplicate = runHeartbeatRound({ nowMs: t(10, 0) });
    assert(duplicate.outcome === "SUPPRESSED_DUPLICATE" && duplicate.notified === 0, "重复问题应被抑制");
    assert(heartbeatRuns().length === 1, "去重后不得新增 run");

    // 5b) TTL 到期仍可行动 → 再次提醒。
    const aged = readState();
    assert(aged.fingerprints.length > 0, "首轮应写入 fingerprint");
    for (const record of aged.fingerprints) {
      record.lastNotifiedAt = t(10, 0) - DAY_MS - 1000;
    }
    writeState(aged);
    const retried = runHeartbeatRound({ nowMs: t(10, 0) });
    assert(retried.outcome === "NOTIFIED" && retried.notified >= 1, "TTL 到期后应再次提醒");
    assert(heartbeatRuns().length === 2, "TTL 到期应新增一条 run");

    // 6) 安静时段：入队成功但 claim 返回空，状态 pending + QUIET_HOURS；解除后送达。
    useDirs("quiet");
    setHeartbeatEnabled(true, t(12, 0));
    proactivityStore.setQuietHours({ enabled: true, startMinutes: 23 * 60, endMinutes: 8 * 60 }, t(12, 0));
    addEvent({ title: "夜间评审", startAt: t(23, 30), endAt: t(23, 50) });
    addEvent({ title: "夜间周会", startAt: t(23, 40), endAt: t(23, 55) });
    const quietRound = runHeartbeatRound({ nowMs: t(23, 30) });
    assert(quietRound.outcome === "NOTIFIED", "安静时段仍应入队（不直接投递）");
    const quietRunId = heartbeatRuns()[0].id;
    assert(schedulerStore.claimPendingDelivery(10, t(23, 31)).length === 0, "安静时段 claim 必须返回空");
    const heldView = heartbeatRuns()[0];
    assert(heldView.delivery.state === "pending", "被拦消息必须保持 pending");
    assert(heldView.delivery.holdReason === "QUIET_HOURS", "被拦消息必须带 QUIET_HOURS");
    assert(heldView.delivery.holdUntil === t(8, 0, 13), "holdUntil 应指向安静结束");
    const morning = schedulerStore.claimPendingDelivery(10, t(8, 1, 13));
    assert(morning.some((run) => run.id === quietRunId), "安静结束后应投递");
    assert(schedulerStore.recordDeliveryResults([{ runId: quietRunId, result: "sent" }]) === 1, "解除后应落 sent");

    // 7) 清单边界：未识别行可见但不执行；缺失/无有效项/超行/超大 都 no-op。
    useDirs("checklist");
    setHeartbeatEnabled(true, t(9, 0));
    writeChecklist("- calendar-conflict\n- 看天气\n");
    const mixed = getHeartbeatStatus(t(9, 0));
    assert(mixed.checklist.status === "ok" && mixed.checklist.checks.length === 1, "只执行识别出的检查");
    assert(mixed.checklist.unsupported.length === 1, "未识别行必须可见");
    assert(mixed.checklist.unsupported[0] === "看天气", "未识别行应原样记录");
    assert(runHeartbeatRound({ nowMs: t(9, 0) }).outcome === "NO_ISSUES", "未识别行不得被执行");

    rmSync(checklistPath());
    const missingRound = runHeartbeatRound({ nowMs: t(9, 5) });
    assert(missingRound.outcome === "SKIPPED" && missingRound.skippedReason === "NO_CHECKLIST", "清单缺失应跳过");

    writeChecklist("- 看天气\n- 早点睡\n");
    const invalidStatus = getHeartbeatStatus(t(9, 10));
    assert(invalidStatus.checklist.status === "invalid" && invalidStatus.checklist.reason === "NO_VALID_CHECKS",
      "无有效检查应判 invalid");
    assert(runHeartbeatRound({ nowMs: t(9, 10) }).skippedReason === "INVALID_CHECKLIST", "无效清单应跳过");

    writeChecklist(`${"- calendar-conflict\n"}${"# 注释\n".repeat(100)}`);
    assert(getHeartbeatStatus(t(9, 15)).checklist.reason === "TOO_MANY_LINES", "超过 100 行应判 invalid");

    writeChecklist(`- calendar-conflict\n${"#".repeat(9000)}`);
    assert(getHeartbeatStatus(t(9, 20)).checklist.reason === "TOO_LARGE", "超过 8 KB 应判 invalid");
    assert(parseHeartbeatChecklist({ path: checklistPath(), exists: false, text: "", tooLarge: false, unreadable: false }).status === "missing",
      "缺失应返回 missing");

    // 8) 状态文件损坏：隔离 + 当轮不通知 + 不崩溃；下一轮恢复。
    useDirs("state-corrupt");
    setHeartbeatEnabled(true, t(9, 0));
    addEvent({ title: "A", startAt: t(10, 0), endAt: t(11, 0) });
    addEvent({ title: "B", startAt: t(10, 30), endAt: t(11, 30) });
    writeFileSync(statePath(), "{broken", "utf8");
    heartbeatStore.resetMemory();
    const corruptRound = runHeartbeatRound({ nowMs: t(9, 0) });
    assert(corruptRound.outcome === "SUPPRESSED_STATE_CORRUPT" && corruptRound.notified === 0,
      "状态损坏后第一轮不得通知");
    assert(heartbeatRuns().length === 0, "状态损坏不得产生通知 run");
    assert(readdirSync(heartbeatDir()).some((name) => name.startsWith("state.json.corrupt-")),
      "坏状态文件应被隔离");
    const recoveredRound = runHeartbeatRound({ nowMs: t(9, 1) });
    assert(recoveredRound.outcome === "NOTIFIED", "状态重建后应恢复巡检");

    // 9) 队列满：ENQUEUE_FAILED + QUEUE_FULL 可见；不记 fingerprint（下轮可重试）。
    useDirs("queue-full");
    setHeartbeatEnabled(true, t(9, 0));
    for (let index = 0; index < MAX_PENDING_DELIVERY; index += 1) {
      schedulerStore.appendRun({
        jobId: `fill-${index}`,
        jobName: `fill-${index}`,
        startedAt: t(8, 0),
        status: "succeeded",
        summary: "占用队列",
        delivery: { state: "pending", attempts: 0, enqueuedAt: t(8, 0) }
      });
    }
    addEvent({ title: "C", startAt: t(10, 0), endAt: t(11, 0) });
    addEvent({ title: "D", startAt: t(10, 30), endAt: t(11, 30) });
    const fullRound = runHeartbeatRound({ nowMs: t(9, 0) });
    assert(fullRound.outcome === "ENQUEUE_FAILED", "队列满必须如实失败");
    assert(fullRound.errorCode === "QUEUE_FULL", `期望 QUEUE_FULL，实际 ${fullRound.errorCode}`);
    assert(readState().fingerprints.length === 0, "入队失败不得记 fingerprint");

    // 10) 每天最多 24 轮；日上限用尽后跳过。
    useDirs("cap");
    setHeartbeatEnabled(true, t(9, 0));
    writeState({
      version: 1,
      lastRunAt: t(8, 0),
      lastRunDayKey: localDayKey(t(9, 0)),
      roundsToday: 24,
      fingerprints: [],
      lastResult: null
    });
    const capRound = runHeartbeatRound({ nowMs: t(9, 0) });
    assert(capRound.outcome === "SKIPPED" && capRound.skippedReason === "DAILY_CAP", "日上限应跳过");
    assert(shouldRunHeartbeatNow(t(9, 0)) === false, "日上限用尽后不应到期");

    // 11) 时钟回拨：允许补一轮，但不能连续补跑。
    writeState({
      version: 1,
      lastRunAt: t(11, 0),
      lastRunDayKey: localDayKey(t(9, 0)),
      roundsToday: 5,
      fingerprints: [],
      lastResult: null
    });
    assert(shouldRunHeartbeatNow(t(9, 0)) === true, "回拨后应允许补一轮");
    runHeartbeatRound({ nowMs: t(9, 0) });
    assert(shouldRunHeartbeatNow(t(9, 0)) === false, "补跑后不得连续补跑");

    // 12) PRO-02 等级是上限：克制档停止生成但不影响用户提醒；积极档放开频率与上限。
    useDirs("level-restrained");
    setHeartbeatEnabled(true, t(9, 0));
    proactivityLevelStore.setLevel({ level: "restrained" }, t(9, 0));
    const restrainedStatus = getHeartbeatStatus(t(9, 0));
    assert(restrainedStatus.levelRestrained === true && restrainedStatus.dailyCap === 0, "克制档应暂停主动并显示上限 0");
    assert(shouldRunHeartbeatNow(t(9, 0)) === false, "克制档不应到期");
    const restrainedRound = runHeartbeatRound({ nowMs: t(9, 0) });
    assert(restrainedRound.outcome === "SKIPPED" && restrainedRound.skippedReason === "LEVEL_RESTRAINED",
      "克制档应返回 LEVEL_RESTRAINED");
    assert(heartbeatRuns().length === 0, "克制档不得产生通知");
    const userReminderRun = schedulerStore.appendRun({
      jobId: "user-reminder",
      jobName: "用户提醒",
      startedAt: t(9, 0),
      status: "succeeded",
      summary: "用户自己的提醒",
      origin: "user",
      delivery: { state: "pending", attempts: 0, enqueuedAt: t(9, 0) }
    });
    const userClaim = schedulerStore.claimPendingDelivery(10, t(9, 1));
    assert(userClaim.some((run) => run.id === userReminderRun.id), "克制档不得影响用户提醒的投递");

    useDirs("level-attentive");
    setHeartbeatEnabled(true, t(9, 0));
    proactivityLevelStore.setLevel({ level: "attentive" }, t(9, 0));
    writeState({
      version: 1,
      lastRunAt: t(9, 0) - 31 * 60_000,
      lastRunDayKey: localDayKey(t(9, 0)),
      roundsToday: 5,
      fingerprints: [],
      lastResult: null
    });
    assert(shouldRunHeartbeatNow(t(9, 0)) === true, "积极档 31 分钟前应到期");
    proactivityLevelStore.setLevel({ level: "balanced" }, t(9, 0));
    assert(shouldRunHeartbeatNow(t(9, 0)) === false, "平衡档 31 分钟前不应到期");
    assert(getHeartbeatStatus(t(9, 0)).dailyCap === 24, "平衡档上限应为 24");
    writeState({
      version: 1,
      lastRunAt: t(8, 0),
      lastRunDayKey: localDayKey(t(9, 0)),
      roundsToday: 30,
      fingerprints: [],
      lastResult: null
    });
    proactivityLevelStore.setLevel({ level: "attentive" }, t(9, 0));
    assert(shouldRunHeartbeatNow(t(9, 0)) === true, "积极档 30 轮后仍可巡检（上限 48）");
    proactivityLevelStore.setLevel({ level: "balanced" }, t(9, 0));
    assert(shouldRunHeartbeatNow(t(9, 0)) === false, "平衡档 30 轮后应停下（上限 24）");

    // 13) HTTP 契约：状态、非法开关、合法开关、手动巡检、未知端点。
    useDirs("http");
    const httpServer = createServer((request, response) => {
      const pathname = (request.url ?? "").split("?")[0];
      void handleHeartbeatHttpRequest(request, response, pathname);
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
      const status0 = await getJson("/void-heartbeat/status");
      assert(status0.ok === true && status0.data.enabled === false, "首次读取应为关闭 + missing");

      const bad = await postJson("/void-heartbeat/config", { enabled: "yes" });
      assert(bad.ok === false && bad.error.code === "INVALID_REQUEST", "非布尔开关应 400");

      const good = await postJson("/void-heartbeat/config", { enabled: true });
      assert(good.ok === true && good.data.status.enabled === true, "合法开关应生效");
      assert(good.data.createdChecklist === true, "开启时应生成模板");

      const run = await postJson("/void-heartbeat/run", {});
      assert(run.ok === true && run.data.result.outcome === "NO_ISSUES", "手动巡检应返回结果");
      assert(existsSync(checklistPath()), "模板文件应存在");

      const missingRoute = await getJson("/void-heartbeat/nope");
      assert(missingRoute.ok === false && missingRoute.error.code === "NOT_FOUND", "未知端点应 404 语义");
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
    }

    // 13) 去重单元语义：TTL 前后边界（1 小时前抑制，24 小时后放行）。
    const issue = { fingerprint: "calendar-conflict:a+b", check: "calendar-conflict", text: "日程冲突" };
    const recent = filterFreshIssues([issue], [{ key: issue.fingerprint, firstSeenAt: t(9, 0), lastNotifiedAt: t(9, 0), lastCheck: "" }], t(10, 0));
    assert(recent.fresh.length === 0 && recent.suppressed === 1, "1 小时前提醒过应抑制");
    const expired = filterFreshIssues([issue], [{ key: issue.fingerprint, firstSeenAt: t(9, 0), lastNotifiedAt: t(9, 0), lastCheck: "" }], t(9, 0) + DAY_MS + 1);
    assert(expired.fresh.length === 1 && expired.suppressed === 0, "24 小时后应放行");

    console.log("[agent-heartbeat-smoke] PASSED");
    console.log(" - 结构：巡检器无通知/TTS/模型/对话依赖，只写 PRO-06 队列");
    console.log(" - 默认：关闭 + 清单缺失 no-op；开启生成模板且不覆盖用户清单");
    console.log(" - 判定：日程冲突/提醒未绑定可行动 → NOTIFIED → pending → claim → sent；无变化 NO_ISSUES 不写 run");
    console.log(" - 去重：同一 fingerprint 24h 内抑制；TTL 到期再次提醒");
    console.log(" - 安静：入队成功但 claim 为空，pending + QUIET_HOURS，08:00 后送达");
    console.log(" - 清单：未识别行可见不执行；缺失/无有效项/超行/超大均 no-op");
    console.log(" - 故障：状态损坏隔离并暂停一轮；队列满 ENQUEUE_FAILED/QUEUE_FULL；日上限；时钟回拨不补跑风暴");
    console.log(" - 无假成功：pending 不被 ack 成 sent；HTTP 读/写/400/404");
    console.log(" - 等级上限：克制档停止生成但不影响用户提醒；积极档 30min/48，平衡档 60min/24");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-heartbeat-smoke] FAILED", error);
  process.exitCode = 1;
});
