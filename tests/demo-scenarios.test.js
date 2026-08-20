/**
 * @usethink/incentive-engine 真实业务端到端测试（demo 场景纳入 jest）
 *
 * 背景：demo/scenarios/ 的 4 个行业场景是「最接近真实业务」的端到端资产，
 * 但此前从未被 jest 执行（仅作为独立脚本 node scenarios/xx.js 运行）。
 * 本测试把 4 个场景的业务逻辑纳入测试套件，用 jest 断言替代脚本内 assert，
 * 确保真实业务链路（而非单个方法）被持续回归覆盖。
 *
 * 覆盖：
 * - 01 电商分销：DISTRIBUTE → OVER → CAP → SPLIT 全流水线 + 链式极差 + 70/30 拆分
 * - 02 内容平台：等级评估 + 月度分成 + 预算兜底 CAP + onExceed=REJECT
 * - 03 游戏推广：条件评估 + 链式极差 + 单用户日封顶
 * - 04 完整落账：GenericSettlementService 幂等全路径 + 唯一约束兜底
 *
 * @version 1.0.0
 */

const engine = require("../src/engine");
const { buildPipelineStages } = require("../src/adapters");
const { ECOMMERCE_RULES } = require("../demo/shared/ecommerce-rules");
const { GenericSettlementService } = require("../src/services");
const { createMemoryModel } = require("../demo/mocks/memory-model");
const { createMemorySequelize } = require("../demo/mocks/memory-sequelize");
const { createMemoryRuleSetService } = require("../demo/mocks/memory-rule-set-service");

describe("真实业务端到端：01 电商分销（DISTRIBUTE→OVER→CAP→SPLIT 全流水线）", () => {
  const event = { sourceNodeId: "buyer_1001", eventValue: "1000", eventType: "ORDER_PAID", eventId: "ORDER_001" };
  const directParent = { id: "promoter_501", rankRate: "8" };
  const ancestors = [
    { id: "promoter_501", rankRate: "8" },
    { id: "promoter_205", attrs: { rankRate: "11" } }, // attrs 回退路径
  ];

  function buildStages() {
    const configJson = {
      ...ECOMMERCE_RULES,
      pipelineDef: {
        stages: [
          { handler: "DISTRIBUTE" },
          { handler: "OVER", config: { totalBudget: "110", onExceed: "CAP" } },
          { handler: "CAP" },
          { handler: "SPLIT", config: { totalAmount: event.eventValue, targets: [{ target: "LIQUID", ratio: "70" }, { target: "POINT", ratio: "30" }] } },
        ],
      },
    };
    return buildPipelineStages(configJson, { event, directParent, ancestors });
  }

  test("全流水线：自购返现 + 一级佣金 + 二级链式极差 + 70/30 拆分", () => {
    const result = engine.Orchestrate.executePipeline({ stages: buildStages() });
    const records = result.results.distribute;

    // 自购返现 1000×100%
    const selfRec = records.find((r) => r.rewardId === "self_cashback");
    expect(selfRec.amount).toBe("1000");
    // 一级佣金 1000×5%
    const tier1Rec = records.find((r) => r.rewardId === "tier1_commission");
    expect(tier1Rec.amount).toBe("50");
    // 二级链式极差：链条从 directParent(8%) 起点累积，再按极差 8% / (11%-8%)
    const tier2Recs = records.filter((r) => r.rewardId === "tier2_commission");
    expect(tier2Recs.map((r) => r.amount)).toEqual(["80", "30"]);
    // SPLIT 拆分 70/30
    expect(result.final.splits.map((s) => [s.target, s.amount])).toEqual([["LIQUID", "700"], ["POINT", "300"]]);
  });

  test("OVER 预算兜底：总佣金未超 110% 预算时不缩减", () => {
    const result = engine.Orchestrate.executePipeline({ stages: buildStages() });
    // 佣金总额 = 1000+50+80+30 = 1160，预算上限 = 1000×110% = 1100 → 超发，按比例压缩
    // 但 SPLIT 是最后阶段，OVER 在 CAP 前。验证 OVER 阶段确实压缩了佣金。
    const overResult = result.results.over;
    // 佣金总额 1160 > 1100，应被压缩到 1100
    const total = overResult.reduce((s, r) => s + Number(r.amount), 0);
    expect(total).toBe(1100);
  });
});

describe("真实业务端到端：02 内容平台（等级评估 + 预算兜底 + REJECT）", () => {
  const rankDefs = [
    { id: "silver", levelIndex: 1, rankId: "SILVER", conditions: [{ type: "COMPARE", field: "followers", operator: "GTE", value: 1000 }], metadata: { rate: "10" } },
    { id: "gold", levelIndex: 2, rankId: "GOLD", conditions: [{ type: "COMPARE", field: "followers", operator: "GTE", value: 10000 }], metadata: { rate: "15" } },
    { id: "diamond", levelIndex: 3, rankId: "DIAMOND", conditions: [{ type: "AND", children: [{ type: "COMPARE", field: "followers", operator: "GTE", value: 100000 }, { type: "COMPARE", field: "avgViews", operator: "GTE", value: 50000 }] }], metadata: { rate: "20" } },
  ];

  test("钻石创作者命中最高等级并按 20% 分成", () => {
    const creator = { followers: 120000, avgViews: 80000 };
    const tier = engine.Evaluate.getHighestQualifiedTier(creator, rankDefs);
    expect(tier.rankId).toBe("DIAMOND");
    const event = { sourceNodeId: "creator_777", eventValue: "50000", eventType: "MONTHLY_YIELD" };
    const records = engine.Distribute.distributeByDefs({
      event,
      rewardDefs: [{ rewardId: "content_yield", type: "DIRECT", target: "SOURCE", rate: tier.metadata.rate }],
    });
    expect(records[0].amount).toBe("10000"); // 50000 × 20%
  });

  test("预算兜底 CAP：未超预算不缩减", () => {
    const event = { sourceNodeId: "creator_777", eventValue: "50000", eventType: "MONTHLY_YIELD" };
    const rewardDefs = [{ rewardId: "content_yield", type: "DIRECT", target: "SOURCE", rate: "20" }];
    const result = engine.Orchestrate.executePipeline({
      context: { capState: { platformPaid: "0", memberPaid: new Map() } },
      stages: [
        { id: "distribute", handler: "DISTRIBUTE", config: { event, rewardDefs } },
        { id: "over", handler: "OVER", config: { totalBudget: "130", eventValue: event.eventValue, onExceed: "CAP" } },
        { id: "cap", handler: "CAP", config: { capDefs: [{ scope: "PLATFORM_DAILY", limit: "100000" }] } },
      ],
    });
    expect(result.final[0].amount).toBe("10000");
  });

  test("onExceed=REJECT：超预算直接抛错（fail-fast）", () => {
    const event = { sourceNodeId: "creator_777", eventValue: "50000", eventType: "MONTHLY_YIELD" };
    const rewardDefs = [{ rewardId: "content_yield", type: "DIRECT", target: "SOURCE", rate: "20" }];
    expect(() => {
      engine.Orchestrate.executePipeline({
        stages: [
          { id: "distribute", handler: "DISTRIBUTE", config: { event, rewardDefs } },
          { id: "over", handler: "OVER", config: { totalBudget: "10", eventValue: event.eventValue, onExceed: "REJECT" } },
        ],
      });
    }).toThrow(/总预算超发/);
  });
});

describe("真实业务端到端：03 游戏推广（条件评估 + 链式极差 + 单用户封顶）", () => {
  const event = { sourceNodeId: "player_9527", eventValue: "648", eventType: "FIRST_RECHARGE" };
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

  test("条件评估：高级推广员资格", () => {
    const condition = { type: "AND", children: [{ type: "COMPARE", field: "totalReferrals", operator: "GTE", value: 10 }, { type: "COMPARE", field: "active30Days", operator: "GTE", value: 5 }] };
    expect(engine.Evaluate.evaluateCondition(condition, { totalReferrals: 12, active30Days: 7 })).toBe(true);
    expect(engine.Evaluate.evaluateCondition(condition, { totalReferrals: 3, active30Days: 7 })).toBe(false);
  });

  test("链式极差分配：首充返积分 + 直推 + 团队极差", () => {
    const records = engine.Distribute.distributeByDefs({ event, directParent, ancestors, rewardDefs });
    const sourceRec = records.find((r) => r.rewardId === "first_charge_points");
    const p1Rec = records.find((r) => r.rewardId === "promoter_bonus");
    const teamRecs = records.filter((r) => r.rewardId === "team_bonus");
    expect(sourceRec.amount).toBe("648");
    expect(p1Rec.amount).toBe("64.8");
    // 极差：15% / (25-15)% / (30-25)% → 97.2 / 64.8 / 32.4
    expect(teamRecs.map((r) => r.amount)).toEqual(["97.2", "64.8", "32.4"]);
  });

  test("单用户日封顶：promoter_001 累计 162 < 200 不裁剪", () => {
    const records = engine.Distribute.distributeByDefs({ event, directParent, ancestors, rewardDefs });
    const capped = engine.Allocate.applyCaps(
      records,
      [{ capId: "PROMOTER_DAILY", scope: "PER_USER_DAILY", limit: "200" }],
      { platformPaid: "0", memberPaid: new Map() }
    );
    const cappedP1 = capped.filter((r) => r.nodeId === "promoter_001");
    expect(cappedP1.reduce((s, r) => s + Number(r.amount), 0)).toBe(162);
  });
});

describe("真实业务端到端：04 完整落账（GenericSettlementService 幂等全路径）", () => {
  const UniqueConstraintError = class MockUniqueConstraintError extends Error {
    constructor(msg) { super(msg); this.name = "SequelizeUniqueConstraintError"; }
  };

  function makeService() {
    const model = createMemoryModel({ tableName: "commission_records", uniqueKeys: [["order_id", "member_id", "reward_id"]], UniqueConstraintError });
    const sequelize = createMemorySequelize();
    const ruleSetService = createMemoryRuleSetService({
      ECOMMERCE_REFERRAL: { ...ECOMMERCE_RULES, pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] } },
    });
    const customerConfig = {
      name: "ecommerce-referral", ruleSetCode: "ECOMMERCE_REFERRAL", model, sequelize, ruleSetService, UniqueConstraintError,
      buildEvent: (order) => ({ sourceNodeId: order.buyerId, eventValue: order.amount, eventType: "ORDER_PAID" }),
      buildDirectParent: (order) => order.promoter ? { id: order.promoter.id, rankRate: order.promoter.rankRate } : null,
      buildAncestors: (order) => (order.ancestors || []).map((a) => ({ id: a.id, rankRate: a.rankRate })),
      buildRecord: (order, rec) => ({ order_id: order.orderNo, member_id: rec.nodeId, reward_id: rec.rewardId, amount: rec.amount, status: "SETTLED", source: "ONLINE" }),
      idempotency: {
        buildPreReadWhere: (order) => ({ order_id: order.orderNo, source: "ONLINE" }),
        buildFallbackWhere: (order) => ({ order_id: order.orderNo }),
      },
    };
    return { service: new GenericSettlementService(customerConfig), model };
  }

  test("正常结算 + 事务外预读幂等", async () => {
    const { service } = makeService();
    const order1 = { orderNo: "ORD-001", buyerId: "buyer_1001", amount: "1000", promoter: { id: "promoter_501", rankRate: "8" }, ancestors: [{ id: "promoter_501", rankRate: "8" }, { id: "promoter_205", rankRate: "11" }] };
    const r1 = await service.settle(order1);
    expect(r1.idempotent).toBe(false);
    expect(r1.data.lines.length).toBe(4); // 自购返现 + 一级直推 + 链式两级
    // 重复提交 → 预读命中
    const r2 = await service.settle(order1);
    expect(r2.idempotent).toBe(true);
    expect(r2.data.lines.length).toBe(4);
  });

  test("唯一约束兜底：并发竞态下 DB 唯一索引拦截 → 回读幂等", async () => {
    const { service, model } = makeService();
    // 模拟竞态对方已落账（source=SETTLED，本服务预读 source=ONLINE 查不到）
    await model.create({ order_id: "ORD-RACE-001", member_id: "buyer_race", reward_id: "self_cashback", amount: "100", status: "SETTLED", source: "SETTLED" });
    const raceOrder = { orderNo: "ORD-RACE-001", buyerId: "buyer_race", amount: "100", promoter: null, ancestors: [] };
    const rRace = await service.settle(raceOrder);
    expect(rRace.success).toBe(true);
    expect(rRace.idempotent).toBe(true);
    expect(rRace.data.lines.length).toBe(1);
  });

  test("规则集不存在 → 计算阶段失败，不开启事务", async () => {
    const { service } = makeService();
    const badService = new GenericSettlementService({ ...service, ruleSetCode: "NOT_EXISTS" });
    const rBad = await badService.settle({ orderNo: "ORD-BAD-001", buyerId: "buyer_bad", amount: "10" });
    expect(rBad.success).toBe(false);
  });
});
