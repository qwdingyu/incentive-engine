// 业务冒烟脚本：验证引擎在「真实业务链路」下能跑通（不依赖测试框架）。
// 与 smoke-require.js（只验顶层加载）互补：本脚本执行一条完整业务流水线 +
// GenericSettlementService 端到端 + 封顶水位跨事件累计 + 冲正（REVERSAL）+ 活动期加成/生效期端到端，失败即 exit 非 0。
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

  // ---- 5. 冲正端到端：发放 → 部分退款 → 二次退款不超额 → 重复回调幂等 ----
  console.log("5. 冲正端到端（REVERSAL）");
  const revModel = createMemoryModel({ tableName: "reward", uniqueKeys: [["orderNo", "refundNo"]] });
  const REV_RULE = {
    rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }],
    capDefs: [],
    pipelineDef: { stages: [{ handler: "DISTRIBUTE" }] },
  };
  const revSvc = new GenericSettlementService({
    name: "reverse-probe", ruleSetCode: "rs",
    model: revModel,
    sequelize: createMemorySequelize(),
    ruleSetService: createMemoryRuleSetService({ rs: REV_RULE }),
    logger: { info() {}, warn() {}, error() {} },
    buildEvent: (e) => ({ sourceNodeId: e.userId, eventType: "order", eventValue: e.amount }),
    buildRecord: (e, r) => ({ orderNo: e.orderNo, refundNo: null, userId: r.nodeId, amount: r.amount }),
    idempotency: {
      buildPreReadWhere: (e) => ({ orderNo: e.orderNo }),
      buildFallbackWhere: (e) => ({ orderNo: e.orderNo }),
    },
    reversal: {
      // 真实宿主应在此加行锁（FOR UPDATE），此处内存模型无并发
      loadOriginalRecords: async (e) => revModel.findAll({ where: { orderNo: e.orderNo, refundNo: null } }),
      buildOriginalRecord: (row) => ({ recordId: row.id, nodeId: row.userId, amount: row.amount, rewardId: "self" }),
      // 已冲正累计：按 originalRecordId 汇总本表已有冲正行（多次部分退款必配）
      loadReversedMap: async (e) => {
        const map = new Map();
        for (const row of revModel._rows) {
          if (row.originalRecordId == null) continue;
          if (row.orderNo !== e.orderNo) continue;
          const prev = map.get(row.originalRecordId) || "0";
          map.set(row.originalRecordId, engine.Decimal.add(prev, row.reversedAmount));
        }
        return map;
      },
      resolveReversal: (e) => ({ ratio: e.ratio, reasonCode: "REFUND" }),
      buildRecord: (e, r) => ({
        orderNo: e.orderNo, refundNo: e.refundNo, userId: r.nodeId,
        amount: r.amount, reversedAmount: r.reversedAmount, originalRecordId: r.originalRecordId,
      }),
      idempotency: {
        buildPreReadWhere: (e) => ({ refundNo: e.refundNo }),
        buildFallbackWhere: (e) => ({ refundNo: e.refundNo }),
      },
    },
  });
  await revSvc.settle({ orderNo: "R1", userId: "u9", amount: "100" });
  const netOf = () => revModel._rows
    .filter((r) => r.orderNo === "R1")
    .reduce((sum, r) => engine.Decimal.add(sum, r.amount), "0");
  check("发放落账 100", netOf() === "100", `actual=${netOf()}`);

  const r1 = await revSvc.reverse({ orderNo: "R1", refundNo: "RF1", ratio: "30" });
  check("部分退款 30% → 净发放 70", r1.success && netOf() === "70", `net=${netOf()}`);
  check("冲正记录为负金额", revModel._rows.some((r) => r.refundNo === "RF1" && r.amount === "-30"));

  const r1dup = await revSvc.reverse({ orderNo: "R1", refundNo: "RF1", ratio: "30" });
  check("同一退款单重复回调幂等（不二次扣款）", r1dup.idempotent === true && netOf() === "70", `net=${netOf()}`);

  // 剩余可冲正仅 70，再来一笔"全额"退款只能追回 70 —— 绝不超额扣款
  const r2 = await revSvc.reverse({ orderNo: "R1", refundNo: "RF2", ratio: "100" });
  check("二次退款按剩余额度裁剪 → 净发放 0", r2.success && netOf() === "0", `net=${netOf()}`);
  check("裁剪被标记 clampedCount=1", r2.data.summary.clampedCount === 1, JSON.stringify(r2.data.summary));

  const r3 = await revSvc.reverse({ orderNo: "R1", refundNo: "RF3", ratio: "50" });
  check("已全额冲正后不再产出扣款", r3.success && r3.data.skipped === true && netOf() === "0", `net=${netOf()}`);

  // ---- 6. 跨周期封顶端到端：月封顶跨事件累计 + 缺水位钩子直接拒绝 ----
  console.log("6. 跨周期封顶（PLATFORM_MONTHLY）");
  const MONTH_RULE = {
    rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }],
    capDefs: [{ capId: "mon", scope: "PLATFORM_MONTHLY", limit: "250" }],
    pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
  };
  /**
   * 造一个月封顶结算服务。宿主水位行按「业务月」存 —— 引擎不认识日期，
   * 周期语义完全由这一行的键决定（此处用单变量模拟同一个月）。
   * @param {boolean} withHooks - 是否成对配置 loadCapState / saveCapState
   * @returns {Object} { svc, netTotal }
   */
  function makeMonthlySvc(withHooks) {
    let monthState = null;
    const base = {
      name: "month", ruleSetCode: "rs",
      model: createMemoryModel({ tableName: "m", uniqueKeys: [["orderNo"]] }),
      sequelize: createMemorySequelize(),
      ruleSetService: createMemoryRuleSetService({ rs: MONTH_RULE }),
      logger: { info() {}, warn() {}, error() {} },
      buildEvent: (e) => ({ sourceNodeId: e.userId, eventType: "order", eventValue: e.amount }),
      buildRecord: (e, r) => ({ orderNo: e.orderNo, userId: r.nodeId, amount: r.amount }),
      idempotency: {
        buildPreReadWhere: (e) => ({ orderNo: e.orderNo }),
        buildFallbackWhere: (e) => ({ orderNo: e.orderNo }),
      },
    };
    if (withHooks) {
      base.loadCapState = async () => monthState;
      base.saveCapState = async (capState) => { monthState = capState; };
    }
    return {
      svc: new GenericSettlementService(base),
      getState: () => monthState,
    };
  }

  const withHooks = makeMonthlySvc(true);
  let monthTotal = 0;
  for (const orderNo of ["M1", "M2", "M3", "M4"]) {
    const r = await withHooks.svc.settle({ orderNo, userId: "u1", amount: "100" });
    monthTotal += (r.data?.lines || []).reduce((s, l) => s + Number(l.amount), 0);
  }
  check("月封顶跨事件累计：四单（每单 100）累计 == 250", monthTotal === 250, `actual=${monthTotal}`);
  check(
    "水位落在 periods.MONTHLY 桶（DAILY 桶不重复计）",
    withHooks.getState()?.periods?.MONTHLY?.platformPaid === "250" && withHooks.getState().periods.DAILY === undefined,
    JSON.stringify({ top: withHooks.getState()?.platformPaid, periods: Object.keys(withHooks.getState()?.periods || {}) })
  );

  const noHooks = makeMonthlySvc(false);
  const nh = await noHooks.svc.settle({ orderNo: "N1", userId: "u1", amount: "100" });
  check(
    "缺水位钩子时月封顶直接拒绝（不退化成单事件封顶）",
    nh.success === false && /必须成对配置 loadCapState \/ saveCapState/.test(nh.message || ""),
    JSON.stringify(nh)
  );

  // ---- 7. 活动期加成 + 规则集生效期端到端（CAMPAIGN 必须排在 CAP 之前）----
  console.log("7. 活动期加成（双十一翻倍）+ 规则集生效期");
  const CAMPAIGN_RULE = {
    rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "10" }],
    capDefs: [{ capId: "plat", scope: "PLATFORM_DAILY", limit: "150" }],
    campaignDefs: [{
      campaignId: "dbl11",
      startAt: "2026-11-11T00:00:00+08:00",
      endAt: "2026-11-12T00:00:00+08:00",
      multiplier: "2",
    }],
    effective: { startAt: "2026-11-01T00:00:00+08:00", endAt: "2026-12-01T00:00:00+08:00" },
    // 故意不写 pipelineDef：适配层应自动装配 DISTRIBUTE → CAMPAIGN → CAP
  };
  const campModel = createMemoryModel({ tableName: "camp", uniqueKeys: [["orderNo"]] });
  const campSvc = new GenericSettlementService({
    name: "campaign", ruleSetCode: "rs",
    model: campModel,
    sequelize: createMemorySequelize(),
    ruleSetService: createMemoryRuleSetService({ rs: CAMPAIGN_RULE }),
    logger: { info() {}, warn() {}, error() {} },
    buildEvent: (e) => ({ sourceNodeId: e.userId, eventType: "order", eventValue: e.amount }),
    buildRecord: (e, r) => ({
      orderNo: e.orderNo, userId: r.nodeId, amount: r.amount,
      campaignId: r.snapshot?.campaign?.campaignId || null,
    }),
    idempotency: {
      buildPreReadWhere: (e) => ({ orderNo: e.orderNo }),
      buildFallbackWhere: (e) => ({ orderNo: e.orderNo }),
    },
  });
  const rowOf = (orderNo) => campModel._rows.find((r) => r.orderNo === orderNo);

  // 1000 × 10% = 100 → 活动翻倍 200 → 平台日封顶 150 裁剪（加成在封顶之前，因此仍受额度约束）
  const c1 = await campSvc.settle({ orderNo: "C1", userId: "u1", amount: "1000", occurredAt: "2026-11-11T10:00:00+08:00" });
  check("活动期内翻倍后仍受日封顶约束（100 → 200 → 裁剪 150）",
    c1.success === true && rowOf("C1")?.amount === "150", JSON.stringify(c1.data?.lines));
  check("加成快照落库（campaignId=dbl11）", rowOf("C1")?.campaignId === "dbl11", JSON.stringify(rowOf("C1")));

  // 活动窗口外（右开区间之后）：按原比例发放
  const c2 = await campSvc.settle({ orderNo: "C2", userId: "u1", amount: "1000", occurredAt: "2026-11-13T10:00:00+08:00" });
  check("活动窗口外按原比例发放 100", c2.success === true && rowOf("C2")?.amount === "100", JSON.stringify(c2.data?.lines));
  check("窗口外记录不带加成快照", rowOf("C2")?.campaignId === null, JSON.stringify(rowOf("C2")));

  // 生效期之后：整条规则集失效 → 拒绝结算、零落账（过期规则不得继续发）
  const c3 = await campSvc.settle({ orderNo: "C3", userId: "u1", amount: "1000", occurredAt: "2026-12-05T10:00:00+08:00" });
  check("生效期之后拒绝结算且零落账",
    c3.success === false && /不在生效期内/.test(c3.message || "") && rowOf("C3") === undefined, JSON.stringify(c3));

  // 取不到事件发生时刻：拒绝结算（引擎绝不用当前时间兜底）
  const c4 = await campSvc.settle({ orderNo: "C4", userId: "u1", amount: "1000" });
  check("缺事件发生时刻时拒绝结算并指名 buildOccurredAt",
    c4.success === false && /buildOccurredAt/.test(c4.message || "") && rowOf("C4") === undefined, JSON.stringify(c4));

  // 没写时区偏移的时刻：拒绝（同一字符串在不同环境解析差数小时）
  const c5 = await campSvc.settle({ orderNo: "C5", userId: "u1", amount: "1000", occurredAt: "2026-11-11T10:00:00" });
  check("时刻缺时区偏移时拒绝结算",
    c5.success === false && /ISO-8601/.test(c5.message || "") && rowOf("C5") === undefined, JSON.stringify(c5));

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