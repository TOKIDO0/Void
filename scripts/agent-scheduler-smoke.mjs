// P4a 调度器核心冒烟：纯引擎 + 存储隔离 E2E（零触碰真实运行时根）。
// 用法：npx tsx scripts/agent-scheduler-smoke.mjs
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectScheduleError(work, expectedCode) {
  try {
    work();
  } catch (error) {
    assert(error?.scheduleCode === expectedCode, `期望 ${expectedCode}，实际 ${error?.scheduleCode}`);
    return;
  }
  throw new Error(`预期失败 ${expectedCode}，实际成功`);
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-scheduler-root-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const { validateCreateInput, computeNextRunAtMs, applyStartupSweep, settleRun } = await import(
      pathToFileURL(path.join(projectRoot, "server/scheduler/schedulerEngine.ts")).href
    );
    const { schedulerStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/scheduler/schedulerStore.ts")).href
    );
    const now = Date.now();

    // at 归一化 + 非法拒绝
    const atDraft = validateCreateInput({ prompt: "到点提醒我喝水", kind: "at", at: new Date(now + 3600_000).toISOString() }, now);
    assert(atDraft.kind === "at" && atDraft.atMs > now, "at 应归一化出未来 atMs");
    expectScheduleError(() => validateCreateInput({ prompt: "x", kind: "at", at: now - 1000 }, now), "INVALID_REQUEST");
    expectScheduleError(() => validateCreateInput({ prompt: "x", kind: "at" }, now), "INVALID_REQUEST");
    expectScheduleError(() => validateCreateInput({ prompt: "", kind: "at", at: now + 1000 }, now), "INVALID_REQUEST");
    // every 归一化 + 简写 + 边界
    const everyDraft = validateCreateInput({ prompt: "每小时看一次", kind: "every", every: "1h" }, now);
    assert(everyDraft.everyMs === 3600_000, "1h 简写应为 3600000");
    expectScheduleError(() => validateCreateInput({ prompt: "x", kind: "every", every: "30s" }, now), "INVALID_REQUEST");
    expectScheduleError(() => validateCreateInput({ prompt: "x", kind: "every", every: "31d" }, now), "INVALID_REQUEST");
    expectScheduleError(() => validateCreateInput({ prompt: "x", kind: "every" }, now), "INVALID_REQUEST");
    expectScheduleError(() => validateCreateInput({ prompt: "x", kind: "weird" }, now), "INVALID_REQUEST");
    expectScheduleError(() => validateCreateInput({ prompt: "x", kind: "every", every: "1h", allowedToolNames: [] }, now), "INVALID_REQUEST");
    assert(Array.isArray(everyDraft.allowedToolNames) && everyDraft.allowedToolNames.includes("web.search"), "缺省 scope 应含只读工具");

    // next 计算：严格递增（防忙循环）
    const anchor = now - 5 * 3600_000;
    const n1 = computeNextRunAtMs({ kind: "every", everyMs: 3600_000, anchorMs: anchor, createdAt: anchor }, anchor, now);
    assert(n1 !== undefined && n1 > now && (n1 - anchor) % 3600_000 === 0, "every 下次应为锚点整数倍且严格未来");
    const past = computeNextRunAtMs({ kind: "at", atMs: now - 1, createdAt: now - 10 }, now - 10, now);
    assert(past === undefined, "过期 at 不再触发");

    // 启动扫尾：宽限内补跑一次，超限 missed 停用，every 重算
    const jobAtGrace = { id: "j1", name: "g", prompt: "p", kind: "at", atMs: now - 60_000, allowedToolNames: ["web.search"], timeoutMs: 60000, enabled: true, createdAt: now - 3600_000, missedCount: 0, failStreak: 0 };
    const jobAtMissed = { id: "j2", name: "m", prompt: "p", kind: "at", atMs: now - 3600_000, allowedToolNames: ["web.search"], timeoutMs: 60000, enabled: true, createdAt: now - 7200_000, missedCount: 0, failStreak: 0 };
    const jobEvery = { id: "j3", name: "e", prompt: "p", kind: "every", everyMs: 3600_000, anchorMs: now - 7200_000, allowedToolNames: ["web.search"], timeoutMs: 60000, enabled: true, createdAt: now - 7200_000, missedCount: 0, failStreak: 0 };
    const sweep = applyStartupSweep([jobAtGrace, jobAtMissed, jobEvery], now);
    assert(sweep.dueNow.includes("j1"), "宽限内 at 应补跑");
    assert(sweep.missed.includes("j2") && jobAtMissed.enabled === false && jobAtMissed.missedCount === 1, "超限 at 记 missed 并停用");
    assert(jobEvery.nextRunAtMs !== undefined && jobEvery.nextRunAtMs > now, "every 重算下次");

    // 落账：at 成功即删标记，失败停用；every 续算
    assert(settleRun(jobAtGrace, jobAtGrace.createdAt, "succeeded", now).deleteJob === true, "at 成功应删");
    assert(settleRun(jobAtMissed, jobAtMissed.createdAt, "failed", now).deleteJob === false && jobAtMissed.enabled === false, "at 失败停用留查");
    const before = jobEvery.nextRunAtMs;
    settleRun(jobEvery, jobEvery.createdAt, "failed", now);
    assert(jobEvery.failStreak === 1 && jobEvery.nextRunAtMs !== undefined && jobEvery.nextRunAtMs >= (before ?? 0), "every 失败累计并续算");

    // 存储隔离 E2E：落盘→重读→删
    const inserted = schedulerStore.insertJob({ ...everyDraft, name: "smoke-every" });
    assert(inserted.id.startsWith("job_") && existsSync(path.join(runtimeRoot, "scheduler", "jobs.json")), "insert 应落盘 jobs.json");
    schedulerStore.resetMemory();
    const reloaded = schedulerStore.getJob(inserted.id);
    assert(reloaded !== null && reloaded.name === "smoke-every" && reloaded.everyMs === 3600_000, "重启后应恢复任务");
    schedulerStore.updateJob({ ...reloaded, enabled: false });
    assert(schedulerStore.getJob(inserted.id)?.enabled === false, "update 应持久");
    const run = schedulerStore.appendRun({ jobId: inserted.id, jobName: "smoke-every", startedAt: now, status: "running", delivered: false });
    schedulerStore.updateRun({ ...run, status: "succeeded", finishedAt: now + 1, summary: "ok", delivered: false });
    assert(schedulerStore.listRuns(10).some((item) => item.id === run.id && item.status === "succeeded"), "run 记录应落账");
    assert(schedulerStore.removeJob(inserted.id) === true && schedulerStore.getJob(inserted.id) === null, "remove 应删");
    expectScheduleError(() => schedulerStore.updateJob({ ...reloaded, id: "job_missing" }), "NOT_FOUND");
    // 脏文件容错
    writeFileSync(path.join(runtimeRoot, "scheduler", "jobs.json"), "{broken", "utf8");
    schedulerStore.resetMemory();
    assert(schedulerStore.listJobs().length === 0, "脏文件应回退空态不崩");

    // P4b 端点 E2E：裸 HTTP 裹 scheduler handler（免 browser 笙歌）+ stub provider 真跑隔离 turn
    const { handleSchedulerHttpRequest } = await import(
      pathToFileURL(path.join(projectRoot, "server/scheduler/schedulerHttpHandlers.ts")).href
    );
    const runner = await import(
      pathToFileURL(path.join(projectRoot, "server/scheduler/schedulerRunner.ts")).href
    );
    const { getModelProvider, installModelProviderOverride } = await import(
      pathToFileURL(path.join(projectRoot, "src/lib/model-providers/providerRegistry.ts")).href
    );

    const httpServer = createServer((request, response) => {
      const pathname = (request.url ?? "").split("?")[0];
      void handleSchedulerHttpRequest(request, response, pathname);
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const schedOrigin = `http://127.0.0.1:${httpServer.address().port}`;
    const postJson = async (pathName, body) => {
      const response = await fetch(`${schedOrigin}${pathName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return response.json();
    };
    const getJson = async (pathName) => (await fetch(`${schedOrigin}${pathName}`)).json();

    runner.startScheduler();
    try {
      const status0 = await getJson("/void-scheduler/status");
      assert(status0.ok === true && status0.data.unlocked === false, "初始未解锁");

      const badUnlock = await postJson("/void-scheduler/unlock", { modelConfig: { provider: "openai-compatible", modelName: "x" } });
      assert(badUnlock.ok === false, "缺 key 的解锁应拒绝");

      const SECRET = "sk-smoke-unlock-key-12345";
      const unlockText = JSON.stringify(await postJson("/void-scheduler/unlock", {
        modelConfig: { provider: "openai-compatible", presetId: "smoke", apiKey: SECRET, baseUrl: "http://127.0.0.1:9", modelName: "smoke-model", modelStrength: "middle", thinkingModeEnabled: false, temperature: 0, maxOutputTokens: 256, streamEnabled: false }
      }));
      assert(unlockText.includes('"unlocked":true') && !unlockText.includes(SECRET), "解锁成功且响应不回显 Key");

      const badCreate = await postJson("/void-scheduler/jobs/create", { prompt: "x", kind: "every", every: "30s" });
      assert(badCreate.ok === false, "非法间隔应拒绝");

      const created = await postJson("/void-scheduler/jobs/create", {
        name: "smoke-at",
        prompt: "请直接回复：后台任务完成。",
        kind: "at",
        at: Date.now() + 3600_000
      });
      assert(created.ok === true && created.data.id.startsWith("job_") && created.data.nextRunAtMs > Date.now(), "远期 at 应创建并算出下次");

      const listed = await getJson("/void-scheduler/jobs");
      assert(listed.ok === true && listed.data.some((job) => job.id === created.data.id), "列表应含新任务");

      // stub provider 真跑隔离 turn：纯文本即回，无需工具
      const baseProvider = getModelProvider("openai-compatible");
      const uninstall = installModelProviderOverride("openai-compatible", {
        ...baseProvider,
        supportsTools: true,
        async sendMessage() { return { content: "后台任务完成。" }; },
        mapError(error) { return error instanceof Error ? error : new Error(String(error)); }
      });
      try {
        const runResp = await postJson("/void-scheduler/jobs/run", { id: created.data.id });
        assert(runResp.ok === true && typeof runResp.data.runId === "string", "手动触发应回 runId");
        let terminal = null;
        let lastRuns = [];
        for (let i = 0; i < 40; i++) {
          const runsResp = await getJson("/void-scheduler/runs?limit=10");
          lastRuns = runsResp.data;
          terminal = runsResp.data.find((run) => run.id === runResp.data.runId && run.status !== "running");
          if (terminal) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        assert(terminal !== null && terminal !== undefined && terminal.status === "succeeded", "隔离 turn 应成功落账：" + JSON.stringify(lastRuns));
        const afterJobs = await getJson("/void-scheduler/jobs");
        assert(!afterJobs.data.some((job) => job.id === created.data.id), "成功 at 应自动删除");
      } finally {
        uninstall();
      }

      // 未解锁 run → paused_needs_user（无模型调用）
      runner.setSchedulerModelKey(null);
      const created2 = await postJson("/void-scheduler/jobs/create", {
        name: "smoke-locked", prompt: "hi", kind: "at", at: Date.now() + 3600_000
      });
      const runResp2 = await postJson("/void-scheduler/jobs/run", { id: created2.data.id });
      let paused = null;
      for (let i = 0; i < 20; i++) {
        const runsResp = await getJson("/void-scheduler/runs?limit=10");
        paused = runsResp.data.find((run) => run.id === runResp2.data.runId && run.status !== "running");
        if (paused) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert(paused !== null && paused !== undefined && paused.status === "paused_needs_user", "未解锁应 pause 留查");

      const removed = await postJson("/void-scheduler/jobs/remove", { id: created2.data.id });
      assert(removed.ok === true && removed.data.removed === true, "删除应成功");
      const removedAgain = await postJson("/void-scheduler/jobs/remove", { id: created2.data.id });
      assert(removedAgain.ok === true && removedAgain.data.removed === false, "重复删除应回 false");
      const missing = await postJson("/void-scheduler/jobs/run", { id: "job_missing" });
      assert(missing.ok === false, "触发不存在任务应失败");
    } finally {
      runner.stopScheduler();
      await new Promise((resolve) => httpServer.close(resolve));
    }

    console.log("[agent-scheduler-smoke] PASSED");
    console.log(" - 端点E2E：unlock不回显Key→创建/列表→手动触发隔离turn成功→at自删→未解锁pause→删幂等");
    console.log(" - at/every 归一化与非法拒绝；下次触发严格递增；宽限补跑/超限missed/不补跑风暴");
    console.log(" - 落账：at成功删/失败停用，every累计续算；存储落盘重读删全闭环，脏文件回退");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-scheduler-smoke] FAILED", error);
  process.exitCode = 1;
});
