/**
 * Demo 2: 内容平台创作者激励 — 纯计算路径 + 等级评估
 *
 * 场景：某短视频平台按月给创作者发流量分成
 * - 按视频播放量发收益（eventValue = 播放量折算金额）
 * - 创作者等级（白银/黄金/钻石）决定分成比例
 * - 钻石创作者享受全站加码（OVER 预算兜底 CAP）
 * - 追加演示 onExceed=REJECT（超预算直接拒绝，fail-fast）
 *
 * 运行：node scenarios/02-content-platform.js
 */
const assert = require("node:assert");
const engine = require("@usethink/incentive-engine");
const { printHeader, printRecords } = require("../utils/print");

// ========== 1. 创作者等级定义 ==========
const rankDefs = [
  {
    id: "silver", levelIndex: 1, rankId: "SILVER",
    conditions: [{ type: "COMPARE", field: "followers", operator: "GTE", value: 1000 }],
    metadata: { rate: "10" },
  },
  {
    id: "gold", levelIndex: 2, rankId: "GOLD",
    conditions: [{ type: "COMPARE", field: "followers", operator: "GTE", value: 10000 }],
    metadata: { rate: "15" },
  },
  {
    id: "diamond", levelIndex: 3, rankId: "DIAMOND",
    conditions: [{ type: "AND", children: [
      { type: "COMPARE", field: "followers", operator: "GTE", value: 100000 },
      { type: "COMPARE", field: "avgViews", operator: "GTE", value: 50000 },
    ] }],
    metadata: { rate: "20" },
  },
];

// ========== 2. 评估创作者等级 ==========
const creator = { followers: 120000, avgViews: 80000 };
const qualifiedTier = engine.Evaluate.getHighestQualifiedTier(creator, rankDefs);
printHeader("内容平台创作者激励 Demo");
console.log("创作者粉丝数:", creator.followers, "| 日均播放:", creator.avgViews);
console.log("达标等级:", qualifiedTier ? qualifiedTier.rankId : "无");
console.log("分成比例:", qualifiedTier ? qualifiedTier.metadata.rate + "%" : "0%");
assert.strictEqual(qualifiedTier.rankId, "DIAMOND");

// ========== 3. 月度收益计算 ==========
const event = {
  sourceNodeId: "creator_777",
  eventValue: "50000",   // 当月播放量折算金额（元）
  eventType: "MONTHLY_YIELD",
};

const rewardDefs = [
  { rewardId: "content_yield", type: "DIRECT", target: "SOURCE", rate: qualifiedTier.metadata.rate },
];

const records = engine.Distribute.distributeByDefs({ event, rewardDefs });
console.log(`\n-- 当月收益（${qualifiedTier.metadata.rate}% 分成）--`);
printRecords(records);
assert.strictEqual(records[0].amount, "10000");   // 50000 × 20%

// ========== 4. 钻石加码（预算兜底 + 平台日封顶） ==========
console.log("\n-- 钻石创作者全站加码（预算兜底 30%，平台日封顶 100000）--");
const pipelineResult = engine.Orchestrate.executePipeline({
  context: { capState: { platformPaid: "0", memberPaid: new Map() } },
  stages: [
    { id: "distribute", handler: "DISTRIBUTE", config: { event, rewardDefs } },
    { id: "over", handler: "OVER", config: { totalBudget: "130", eventValue: event.eventValue, onExceed: "CAP" } },
    { id: "cap", handler: "CAP", config: { capDefs: [{ scope: "PLATFORM_DAILY", limit: "100000" }] } },
  ],
});
printRecords(pipelineResult.final, { showSnapshot: true });
assert.strictEqual(pipelineResult.final[0].amount, "10000");   // 未超预算/封顶

// ========== 5. onExceed=REJECT（超预算直接拒绝） ==========
console.log("\n-- onExceed=REJECT 模式（预算 10% 远低于应发 20%，超发直接拒绝）--");
let rejected = null;
try {
  engine.Orchestrate.executePipeline({
    stages: [
      { id: "distribute", handler: "DISTRIBUTE", config: { event, rewardDefs } },
      { id: "over", handler: "OVER", config: { totalBudget: "10", eventValue: event.eventValue, onExceed: "REJECT" } },
    ],
  });
} catch (e) {
  rejected = e;
}
assert.ok(rejected, "REJECT 模式下超预算应抛错");
assert.match(rejected.message, /总预算超发/);
console.log(`  ✔ 超发被拒绝: ${rejected.message}`);
console.log("✅ 断言通过：等级评估 / 月度分成 / 预算兜底 / REJECT 拒绝");

