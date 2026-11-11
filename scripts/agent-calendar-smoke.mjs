// CAL 日程一期冒烟：事件 CRUD + 区间查询 + 冲突 + 提醒解绑/绑定 + 边界 + 脏文件容错。
// 用法：npx tsx scripts/agent-calendar-smoke.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-calendar-root-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let httpServer = null;

  try {
    const { handleCalendarHttpRequest } = await import(
      pathToFileURL(path.join(projectRoot, "server/calendar/calendarHttpHandlers.ts")).href
    );
    const { calendarStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/calendar/calendarStore.ts")).href
    );
    const { schedulerStore } = await import(
      pathToFileURL(path.join(projectRoot, "server/scheduler/schedulerStore.ts")).href
    );
    const { MAX_EVENTS } = await import(
      pathToFileURL(path.join(projectRoot, "server/calendar/calendarTypes.ts")).href
    );

    const httpServerLocal = createServer((request, response) => {
      const pathname = (request.url ?? "/").split("?")[0];
      void handleCalendarHttpRequest(request, response, pathname);
    });
    httpServer = httpServerLocal;
    await new Promise((resolve, reject) => {
      httpServerLocal.once("error", reject);
      httpServerLocal.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${httpServerLocal.address().port}`;
    const postJson = async (pathName, body) => (await fetch(`${origin}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })).json();
    const getJson = async (pathName) => (await fetch(`${origin}${pathName}`)).json();

    const base = new Date("2026-11-13T15:00:00+08:00").getTime();

    // A3 创建：默认 1 小时时长 + 默认提前 10 分钟提醒
    const created = await postJson("/void-calendar/events/create", {
      title: "和张三开会",
      startAt: base,
      location: "3 楼会议室",
      participants: ["张三"]
    });
    assert(created.ok === true, `创建应成功：${JSON.stringify(created)}`);
    assert(created.data.endAt === base + 60 * MINUTE, "缺省结束时间应为开始后 1 小时");
    assert(created.data.remindMinutesBefore === 10, "缺省提醒应为 10 分钟");

    // A6 提醒绑定：job 存在且时间 = start - 10min
    assert(typeof created.data.reminderJobId === "string", "应返回 reminderJobId");
    const boundJob = schedulerStore.getJob(created.data.reminderJobId);
    assert(boundJob !== null, "提醒 job 应落盘");
    assert(boundJob.atMs === base - 10 * MINUTE, `提醒时间应为开始前 10 分钟，实际 ${boundJob.atMs}`);
    assert(boundJob.prompt.includes("和张三开会"), "提醒提示词应含事件标题");

    // A3 查询 + A4 区间边界（半开区间）
    const inside = await getJson(`/void-calendar/events?from=${base - DAY}&to=${base + DAY}`);
    assert(inside.ok === true && inside.data.some((event) => event.id === created.data.id), "区间内应查到事件");
    const beforeEnd = await getJson(`/void-calendar/events?from=${base - 2 * DAY}&to=${base - DAY}`);
    assert(!beforeEnd.data.some((event) => event.id === created.data.id), "区间外不应查到");

    // A5 冲突：重叠检出，首尾相接不算
    const overlap = await postJson("/void-calendar/events/conflicts", { startAt: base + 30 * MINUTE, endAt: base + 90 * MINUTE });
    assert(overlap.ok === true && overlap.data.some((event) => event.id === created.data.id), "重叠应检出冲突");
    const adjacent = await postJson("/void-calendar/events/conflicts", { startAt: base + 60 * MINUTE, endAt: base + 120 * MINUTE });
    assert(adjacent.data.length === 0, "首尾相接不算冲突");
    const excluded = await postJson("/void-calendar/events/conflicts", {
      startAt: base, endAt: base + 60 * MINUTE, excludeId: created.data.id
    });
    assert(excluded.data.length === 0, "excludeId 应排除自身");

    // A3 更新：改时间会重绑提醒（旧 job 删除，新 job 时间更新）
    const oldJobId = created.data.reminderJobId;
    const movedBase = base + 2 * 60 * MINUTE;
    const updated = await postJson("/void-calendar/events/update", {
      id: created.data.id, startAt: movedBase, endAt: movedBase + 30 * MINUTE
    });
    assert(updated.ok === true && updated.data.startAt === movedBase, "更新应生效");
    assert(schedulerStore.getJob(oldJobId) === null, "旧提醒 job 应被删除");
    const rebound = schedulerStore.getJob(updated.data.reminderJobId);
    assert(rebound !== null && rebound.atMs === movedBase - 10 * MINUTE, "提醒应重绑到新时间");
    assert(updated.data.reminderJobId !== oldJobId, "重绑应生成新 job id");

    // A3 完成态：done 解绑提醒
    const done = await postJson("/void-calendar/events/update", { id: created.data.id, status: "done" });
    assert(done.ok === true && done.data.status === "done", "应可标记完成");
    assert(done.data.reminderJobId === undefined, "完成后不应再有提醒");
    assert(schedulerStore.getJob(updated.data.reminderJobId) === null, "完成后提醒 job 应删除");

    // A7 取消：状态保留 + 解绑 + 幂等
    const cancelled = await postJson("/void-calendar/events/cancel", { id: created.data.id });
    assert(cancelled.ok === true && cancelled.data.cancelled === true, "取消应成功");
    const cancelledAgain = await postJson("/void-calendar/events/cancel", { id: created.data.id });
    assert(cancelledAgain.data.cancelled === false, "重复取消应返回 false");
    const afterCancel = await getJson(`/void-calendar/events?from=${base - DAY}&to=${base + DAY}`);
    const kept = afterCancel.data.find((event) => event.id === created.data.id);
    assert(kept !== undefined && kept.status === "cancelled", "取消后事件应保留且状态为 cancelled");

    // A8 边界与非法输入
    const badEnd = await postJson("/void-calendar/events/create", { title: "x", startAt: base, endAt: base });
    assert(badEnd.ok === false, "endAt 不大于 startAt 应拒绝");
    const badTitle = await postJson("/void-calendar/events/create", { title: "   ", startAt: base });
    assert(badTitle.ok === false, "空标题应拒绝");
    const badRemind = await postJson("/void-calendar/events/create", { title: "x", startAt: base, remindMinutesBefore: 5000 });
    assert(badRemind.ok === false, "提醒提前量越界应拒绝");
    const badSpan = await getJson(`/void-calendar/events?from=${base}&to=${base + 63 * DAY}`);
    assert(badSpan.ok === false, "查询跨度超过 62 天应拒绝");
    const missing = await postJson("/void-calendar/events/update", { id: "evt_missing", title: "x" });
    assert(missing.ok === false, "更新不存在事件应失败");

    // 不提醒：remindMinutesBefore = -1 时不应建 job
    const noRemind = await postJson("/void-calendar/events/create", {
      title: "不提醒的事", startAt: base + 3 * DAY, remindMinutesBefore: -1
    });
    assert(noRemind.ok === true && noRemind.data.reminderJobId === undefined, "-1 应表示不提醒");
    await postJson("/void-calendar/events/cancel", { id: noRemind.data.id });

    await new Promise((resolve) => httpServerLocal.close(resolve));
    httpServer = null;

    // A9 脏文件容错
    writeFileSync(path.join(runtimeRoot, "calendar", "events.json"), "{broken", "utf8");
    calendarStore.resetMemory();
    assert(calendarStore.listEvents(0, Date.now() + DAY).length === 0, "脏文件应回退空态不崩");

    // A10 上界：预置满量数据后创建被拒
    const fullEvents = Array.from({ length: MAX_EVENTS }, (_, index) => ({
      id: `evt_fill_${index}`,
      title: `fill${index}`,
      startAt: base + index * MINUTE,
      endAt: base + index * MINUTE + MINUTE,
      allDay: false,
      participants: [],
      status: "planned",
      remindMinutesBefore: -1,
      source: "agent",
      createdAt: base,
      updatedAt: base
    }));
    writeFileSync(
      path.join(runtimeRoot, "calendar", "events.json"),
      JSON.stringify({ version: 1, events: fullEvents }),
      "utf8"
    );
    calendarStore.resetMemory();
    let limitRejected = false;
    try {
      calendarStore.insertEvent({
        title: "overflow",
        startAt: base + 999 * DAY,
        endAt: base + 999 * DAY + MINUTE,
        allDay: false,
        participants: [],
        status: "planned",
        remindMinutesBefore: -1,
        source: "agent"
      });
    } catch (error) {
      limitRejected = error?.calendarCode === "EVENT_LIMIT";
    }
    assert(limitRejected, "超过事件上界应抛 EVENT_LIMIT");

    console.log("[agent-calendar-smoke] PASSED");
    console.log(" - CRUD：创建/查询/更新/取消全链路，取消后事件保留且幂等");
    console.log(" - 提醒绑定：创建即绑 job（start-10min），改时间重绑、完成/取消解绑，-1 不提醒");
    console.log(" - 区间与冲突：半开区间查询正确，重叠检出、首尾相接不算冲突、excludeId 生效");
    console.log(" - 边界：空标题/endAt<=startAt/提醒越界/超 62 天查询/不存在 id 均拒绝");
    console.log(" - 容错与上界：脏文件回退空态，满量后创建抛 EVENT_LIMIT");
  } finally {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-calendar-smoke] FAILED", error);
  process.exitCode = 1;
});
