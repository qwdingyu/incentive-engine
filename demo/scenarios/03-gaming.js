/**
 * Demo 3: 游戏平台推广激励 — 条件评估 + 多级推广奖励
 *
 * 场景：某游戏平台给推广员发放拉新奖励
 * - 新用户首充 100% 返积分
 * - 一级推广员拿首充金额 10%
 * - 二级及以上推广员按等级差拿（LEVEL 链式）
 * - 单用户单日推广收益上限 200 元（PER_USER_DAILY 封顶）
 *
 * 运行：node scenarios/03-gaming.js
 */
const assert = require("node:assert");
const engine = require("@usethink/incentive-engine");
const { printHeader, printRecords } = require("../utils/print");

// ========== 1. 条件评估（是否满足"高级推广员"资格） ==========
const condition = {
  type: "AND",
  children: [
    { type: "COMPARE", field: "totalReferrals", operator: "GTE", value: 10 },
    { type: "COMPARE", field: "active30Days", operator: "GTE", value: 5 },
  ],
};
const promoter = { totalReferrals: 12, active30Days: 7 };
const isElite = engine.Evaluate.evaluateCondition(condition, promoter);
printHeader("游戏平台推广激励 Demo");
console.log(`推广员资格评估（≥10 人且 ≥5 活跃）: ${isElite ? "✔ 高级推广员" : "✘ 普通推广员"}`);
assert.strictEqual(isElite, true);

// ========== 2. 拉新首充奖励 ==========
const event = {
  sourceNodeId: "player_9527",
  eventValue: "648",   // 首充金额（元）
  eventType: "FIRST_RECHARGE",
};

const rewardDefs = [
  { rewardId: "first_charge_points", type: "DIRECT", target: "SOURCE", rate: "100" },
  { rewardId: "promoter_bonus", type: "DIRECT", target: "PARENT", rate: "10" },
  { rewardId: "team_bonus", type: "LEVEL", accumulateInChain: true },
];

const directParent = { id: "promoter_001", rankRate: "15" };
const ancestors = [
  { id: "promoter_001", rankRate: "15" },
  { id: "promoter_002", rankRate: "25" },
  { id: "promoter_003", rankRate: "30" },
];

const records = engine.Distribute.distributeByDefs({ event, directParent, ancestors, rewardDefs });
console.log(`\n-- 首充 ${event.eventValue} 元的推广奖励分配 --`);
printRecords(records);

// ========== 3. 单用户日封顶 ==========
const capped = engine.Allocate.applyCaps(
  records,
  [{ capId: "PROMOTER_DAILY", scope: "PER_USER_DAILY", limit: "200" }],
  { platformPaid: "0", memberPaid: new Map() }
);
console.log("\n-- 单用户日封顶 200 元后 --");
printRecords(capped, { showSnapshot: true });

// ========== 4. 期望值断言 ==========
const sourceRec = records.find((r) => r.rewardId === "first_charge_points");
const p1Rec = records.find((r) => r.rewardId === "promoter_bonus");
const teamRecs = records.filter((r) => r.rewardId === "team_bonus");
assert.strictEqual(sourceRec.amount, "648");                        // 首充 100% 返积分
assert.strictEqual(p1Rec.amount, "64.8");                           // 648 × 10%
// LEVEL accumulateInChain：链条从 directParent(15%) 起点累积，再按极差 25-15 / 30-25
assert.deepStrictEqual(teamRecs.map((r) => r.amount), ["97.2", "64.8", "32.4"]);
// 单用户日封顶：promoter_001 总额 = 64.8(直推) + 97.2(团队) = 162 < 200，不裁剪
const cappedP1 = capped.filter((r) => r.nodeId === "promoter_001");
assert.strictEqual(cappedP1.reduce((s, r) => s + Number(r.amount), 0), 162);
console.log("✅ 断言通过：条件评估 / 链式极差分配 / 单用户日封顶");

