/**
 * Demo 1: 电商分销佣金 — 纯计算路径 + 规则集适配器
 *
 * 场景：某电商平台为推广员设计两级佣金
 * - 本人下单返 100%（自购返现）
 * - 一级推广员拿 5%
 * - 二级推广员拿 3%（通过 LEVEL 链式水位差实现）
 * - 平台每日总预算上限 = eventValue 的 110%（超发按比例压缩）
 * - 订单金额拆分：70% 现金 / 30% 积分
 *
 * 本 demo 演示「规则集配置 → buildPipelineStages → executePipeline」的标准接入路径：
 * 规则声明与代码分离（见 demo/shared/ecommerce-rules.js），
 * 适配器负责把 config_json 组装成流水线阶段。
 *
 * 运行：node scenarios/01-ecommerce.js
 */
const assert = require("node:assert");
const engine = require("@usethink/incentive-engine");
const { ECOMMERCE_RULES } = require("../shared/ecommerce-rules");
const { printHeader, printRecords, printSplits } = require("../utils/print");

// ========== 1. 业务事件 ==========
const event = {
  sourceNodeId: "buyer_1001",   // 下单人
  eventValue: "1000",           // 订单金额
  eventType: "ORDER_PAID",
  eventId: "ORDER_20250101_001",
};

// ========== 2. 网络结构 ==========
// 说明：ancestors 里二级只传 attrs.rankRate（v3.0 兼容路径），
//       引擎在顶层 rankRate 缺失时回退读取 attrs.rankRate。
const directParent = { id: "promoter_501", rankRate: "8" };   // 一级推广员，8%
const ancestors = [
  { id: "promoter_501", rankRate: "8" },                      // 一级 8%（顶层字段优先）
  { id: "promoter_205", attrs: { rankRate: "11" } },          // 二级 11%（attrs 回退）
];

// ========== 3. 组装流水线（规则集适配器） ==========
const configJson = {
  ...ECOMMERCE_RULES,
  pipelineDef: {
    stages: [
      { handler: "DISTRIBUTE" },
      { handler: "OVER", config: { totalBudget: "110", onExceed: "CAP" } },
      { handler: "CAP" },
      // SPLIT 的 totalAmount 是运行时数据（订单金额），在声明处注入
      {
        handler: "SPLIT",
        config: {
          totalAmount: event.eventValue,
          targets: [
            { target: "LIQUID", ratio: "70" },
            { target: "POINT", ratio: "30" },
          ],
        },
      },
    ],
  },
};

const stages = engine.Adapters.buildPipelineStages(configJson, { event, directParent, ancestors });
const pipelineResult = engine.Orchestrate.executePipeline({ stages });

// ========== 4. 输出 ==========
printHeader("电商分销佣金 Demo");
console.log("订单金额:", event.eventValue, "元");
console.log("\n-- 佣金分配（拆分前）--");
printRecords(pipelineResult.results.distribute);
console.log("\n-- 订单金额拆分（70% 现金 / 30% 积分）--");
printSplits(pipelineResult.final.splits);

// ========== 5. 期望值断言（demo 兼做集成冒烟测试） ==========
const records = pipelineResult.results.distribute;
const selfRec = records.find((r) => r.rewardId === "self_cashback");
const tier1Rec = records.find((r) => r.rewardId === "tier1_commission");
const tier2Recs = records.filter((r) => r.rewardId === "tier2_commission");
assert.strictEqual(selfRec.amount, "1000");                        // 自购返现 1000×100%
assert.strictEqual(tier1Rec.amount, "50");                         // 一级佣金 1000×5%
// LEVEL accumulateInChain：链条从 directParent(8%) 起点累积，再按极差
assert.deepStrictEqual(tier2Recs.map((r) => r.amount), ["80", "30"]);  // 1000×8% / 1000×(11%-8%)
assert.deepStrictEqual(
  pipelineResult.final.splits.map((s) => [s.target, s.amount]),
  [["LIQUID", "700"], ["POINT", "300"]]
);
console.log("\n✅ 断言通过：自购返现 / 一级佣金 / 二级链式极差（attrs.rankRate 回退）/ 70-30 拆分");

