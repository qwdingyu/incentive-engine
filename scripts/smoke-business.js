// 业务冒烟脚本：验证引擎在「真实业务链路」下能跑通（不依赖测试框架）。
// 与 smoke-require.js（只验顶层加载）互补：本脚本执行一条完整业务流水线 +
// GenericSettlementService 端到端 + 封顶水位跨事件累计，失败即 exit 非 0。
// 用法：node scripts/smoke-business.js
const engine = require("../src/index.js");
const { buildPipelineStages } = require("../src/adapters");
const { GenericSettlementService } = require("../src/services");
const { createMemoryModel } = require("../demo/mocks/memory-model");
const { createMemorySequelize } = require("../demo/mocks/memory-sequelize");
const { createMemoryRuleSetService } = require("../demo/mocks/memory-rule-set-service");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("[smoke-business] 业务链路冒烟开始");

  // ---- 1. 完整流水线：DISTRIBUTE → OVER → CAP → SPLIT ----
  console.log("1. 完整流水线（电商分销）");
  const event = { sourceNodeId: "buyer", eventValue: "1000" };
  const directParent = { id: "p1", rankRate: "8" };
  const ancestors = [{ id: "p1", rankRate: "8" }, { id: "p2", attrs: { rankRate: "11" } }];
  const stages = buildPipelineStages(
    {
      rewardDefs: [
        { rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" },
        { rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "5" },
        { rewardId: "team", type: "LEVEL", accumulateInChain: true },
      ],
      capDefs: [{ capId: "plat", scope: "PLATFORM_DAILY", limit: "2000" }],
      pipelineDef: {
        stages: [
          { handler: "DISTRIBUTE" },
          { handler: "OVER", config: { totalBudget: "110", onExceed: "CAP" } },
          { handler: "CAP" },
          { handler: "SPLIT", config: { totalAmount: "1000", targets: [{ target: "LIQUID", ratio: "70" }, { target: "POINT", ratio: "30" }] } },
        ],
      },
    },
    { event, directParent, ancestors }
  );
  const pipelineResult = engine.Orchestrate.executePipeline({ stages });
  check("分销记录非空", pipelineResult.results.distribute.length > 0);
  check("SPLIT 70/30", pipelineResult.final.splits[0].amount === "700" && pipelineResult.final.splits[1].amount === "300", JSON.stringify(pipelineResult.final.splits));

  // ---- 2. GenericSettlementService 端到端 + 封顶水位跨事件累计（P0-1 钩子） ----
  console.log("2. 结算服务端到端 + 平台日封顶跨事件累计");
  let storedCapState = null;
  const RULE = {
    rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }],
    capDefs: [{ capId: "plat", scope: "PLATFORM_DAILY", limit: "100" }],
    pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
  };
  const svc = new GenericSettlementService({
    name: "probe", ruleSetCode: "rs",
    model: createMemoryModel({ tableName: "t", uniqueKeys: [["orderNo"]] }),
    sequelize: createMemorySequelize(),
    ruleSetService: createMemoryRuleSetService({ rs: RULE }),
    logger: { info() {}, warn() {}, error() {} },
    buildEvent: (e) => ({ sourceNodeId: e.userId, eventType: "order", eventValue: e.amount }),
    buildRecord: (e, r) => ({ orderNo: e.orderNo, userId: r.nodeId, amount: r.amount }),
    idempotency: {
      buildPreReadWhere: (e) => ({ orderNo: e.orderNo }),
      buildFallbackWhere: (e) => ({ orderNo: e.orderNo }),
    },
    loadCapState: async () => storedCapState,
    saveCapState: async (capState) => { storedCapState = capState; },
  });
  let total = 0;
  for (const orderNo of ["A", "B", "C"]) {
    const r = await svc.settle({ orderNo, userId: "u1", amount: "100" });
    total += (r.data?.lines || []).reduce((s, l) => s + Number(l.amount), 0);
  }
  check("日封顶生效：三单累计 == 100", total === 100, `actual=${total}`);
  check("幂等重复提交", (await svc.settle({ orderNo: "A", userId: "u1", amount: "100" })).idempotent === true);

  // ---- 3. P0-2 fail-closed：无门槛高等级不顶格 ----
  console.log("3. 等级评估 fail-closed");
  const tier = engine.Evaluate.getHighestQualifiedTier(
    { id: "x", directCount: 0, teamPerformance: "0" },
    [{ rankId: "V0", levelIndex: 0, rankRate: "0" }, { rankId: "V9", levelIndex: 9, rankRate: "60" }]
  );
  check("零活跃节点回落 V0", tier?.rankId === "V0", `actual=${tier?.rankId}`);

  // ---- 4. P0-3 splitByTargets 比例校验 ----
  console.log("4. splitByTargets 比例校验");
  let threw = false;
  try {
    engine.Allocate.splitByTargets("1000", [{ target: "A", ratio: 30 }, { target: "B", ratio: 20 }]);
  } catch (e) {
    threw = /必须为 100/.test(e.message);
  }
  check("ratio 之和 50 抛错", threw);

  if (failures === 0) {
    console.log("[smoke-business] ✓ 业务链路冒烟全部通过");
    process.exit(0);
  } else {
    console.error(`[smoke-business] ✗ ${failures} 项失败`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-business] 冒烟失败:", err);
  process.exit(1);
});