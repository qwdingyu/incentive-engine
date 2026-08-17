/**
 * @usethink/incentive-engine 核心模块单元测试
 *
 * 覆盖 5 个核心子模块：Model / Distribute / Allocate / Evaluate / Orchestrate
 * 以及 Adapters / Validation / Utils 扩展模块。
 */

const Decimal = require("../src/decimal");
const Engine = require("../src/engine");

// ====================== Model ======================

describe("Model", () => {
  test("EngineNode 构造", () => {
    const node = new Engine.Model.EngineNode({ id: "u1", rankId: "V1", attrs: { directCount: 5 } });
    expect(node.id).toBe("u1");
    expect(node.rankId).toBe("V1");
    expect(node.attrs.directCount).toBe(5);
    expect(node.parentId).toBeNull();
  });

  test("EngineNode 默认 rankId", () => {
    const node = new Engine.Model.EngineNode({ id: "u1" });
    expect(node.rankId).toBe("DEFAULT");
  });

  test("EngineEvent 构造", () => {
    const ev = new Engine.Model.EngineEvent({ sourceNodeId: "u1", eventType: "purchase", eventValue: "1000" });
    expect(ev.sourceNodeId).toBe("u1");
    expect(ev.eventValue).toBe("1000");
  });

  test("RewardDef 构造", () => {
    const def = new Engine.Model.RewardDef({ rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "10" });
    expect(def.rewardId).toBe("r1");
    expect(def.rate).toBe("10");
  });

  test("RankDef 构造 — 带 conditions", () => {
    const def = new Engine.Model.RankDef({
      rankId: "V2", levelIndex: 2,
      conditions: [{ field: "directCount", operator: "GTE", value: 5 }],
    });
    expect(def.conditions.length).toBe(1);
    expect(def.conditions[0].field).toBe("directCount");
  });

  test("Condition 构造 — COMPARE", () => {
    const c = new Engine.Model.Condition({ type: "COMPARE", field: "teamPerformance", operator: "GTE", value: "10000" });
    expect(c.type).toBe("COMPARE");
    expect(c.operator).toBe("GTE");
  });

  test("Condition 构造 — AND 复合", () => {
    const c = new Engine.Model.Condition({
      type: "AND",
      children: [
        { type: "COMPARE", field: "a", operator: "GTE", value: 1 },
        { type: "COMPARE", field: "b", operator: "GTE", value: 2 },
      ],
    });
    expect(c.children.length).toBe(2);
  });

  test("AllocationTarget 构造 — ratio 转字符串", () => {
    const t = new Engine.Model.AllocationTarget({ target: "rongbei", ratio: 70 });
    expect(t.ratio).toBe("70"); // AllocationTarget 构造时 ratio 转为字符串
  });

  test("Condition 带 subKey", () => {
    const c = new Engine.Model.Condition({ type: "COMPARE", field: "higherTierCounts", operator: "GTE", value: 3, subKey: "V3" });
    expect(c.subKey).toBe("V3");
  });
});

// ====================== Distribute ======================

describe("Distribute", () => {
  test("distributeByDefs — DIRECT SOURCE 本人收益", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }],
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("u1");
    expect(Decimal.gt(records[0].amount, "0")).toBe(true);
    expect(records[0].rewardType).toBe("DIRECT");
  });

  test("distributeByDefs — DIRECT PARENT 推荐人奖励", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "5" }],
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("u0");
    expect(Decimal.eq(records[0].amount, "50")).toBe(true);
  });

  test("distributeByDefs — DIRECT PARENT rate=0 不发", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "0" }],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — DIRECT PARENT 无 directParent 不发", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "5" }],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — LEVEL 链式差额", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      ancestors: [{ id: "a1", rankRate: "10" }, { id: "a2", rankRate: "3" }],
      rewardDefs: [{ rewardId: "level", type: "LEVEL", accumulateInChain: true }],
    });
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0].rewardType).toBe("LEVEL");
  });

  test("distributeByDefs — 空 rewardDefs 返回空数组", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
    });
    expect(records).toEqual([]);
  });

  test("distributeByDefs — 未知 DIRECT target 抛异常", () => {
    expect(() => {
      Engine.Distribute.distributeByDefs({
        event: { sourceNodeId: "u1", eventValue: "1000" },
        rewardDefs: [{ rewardId: "bad", type: "DIRECT", target: "GRANDPARENT", rate: "5" }],
      });
    }).toThrow("未知 target");
  });

  test("distributeByDefs — 未知奖励类型抛异常", () => {
    expect(() => {
      Engine.Distribute.distributeByDefs({
        event: { sourceNodeId: "u1", eventValue: "1000" },
        rewardDefs: [{ rewardId: "bad", type: "LEVELX", rate: "5" }],
      });
    }).toThrow("未知奖励类型");
  });

  test("distributeByDefs — 缺失 type 字段抛异常", () => {
    expect(() => {
      Engine.Distribute.distributeByDefs({
        event: { sourceNodeId: "u1", eventValue: "1000" },
        rewardDefs: [{ rewardId: "bad", rate: "5" }],
      });
    }).toThrow("必须包含 type 字段");
  });

  test("distributeByDefs — CUSTOM 类型静默跳过不抛错", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      rewardDefs: [{ rewardId: "custom", type: "CUSTOM" }],
    });
    expect(records).toEqual([]);
  });

  test("calculateLevelChain — attrs.rankRate 回退", () => {
    // 祖先节点未提供顶层 rankRate，比例放在 attrs.rankRate 中
    const records = Engine.Distribute.calculateLevelChain({
      rewardDef: { rewardId: "level", type: "LEVEL", accumulateInChain: true },
      eventValue: "1000",
      ancestors: [{ id: "a1", attrs: { rankRate: "15" } }],
    });
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "150")).toBe(true);
    expect(records[0].currentRate).toBe("15");
  });

  test("calculateLevelChain — 顶层 rankRate 优先于 attrs.rankRate", () => {
    const records = Engine.Distribute.calculateLevelChain({
      rewardDef: { rewardId: "level", type: "LEVEL", accumulateInChain: true },
      eventValue: "1000",
      ancestors: [{ id: "a1", rankRate: "20", attrs: { rankRate: "15" } }],
    });
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "200")).toBe(true);
  });

  test("calculateDirect — 普通计算", () => {
    const r = Engine.Distribute.calculateDirect({
      rewardDef: { rewardId: "test", type: "DIRECT", rate: "10" },
      eventValue: "500",
      targetNode: { id: "u0", rankRate: "5" },
    });
    expect(Decimal.eq(r.amount, "50")).toBe(true);
    expect(r.nodeId).toBe("u0");
  });

  test("calculateDirect — skipRankZero 跳过 rankRate<=0", () => {
    const r = Engine.Distribute.calculateDirect({
      rewardDef: { rewardId: "test", type: "DIRECT", rate: "10", skipRankZero: true },
      eventValue: "500",
      targetNode: { id: "u0", rankRate: "0" },
    });
    expect(r).toBeNull();
  });

  test("calculateDirect — skipRankZero=false 不跳过", () => {
    const r = Engine.Distribute.calculateDirect({
      rewardDef: { rewardId: "test", type: "DIRECT", rate: "10", skipRankZero: false },
      eventValue: "500",
      targetNode: { id: "u0", rankRate: "0" },
    });
    expect(r).not.toBeNull();
    expect(Decimal.eq(r.amount, "50")).toBe(true);
  });

  test("calculateLevelChain — 含祖先链", () => {
    const records = Engine.Distribute.calculateLevelChain({
      rewardDef: { rewardId: "level", type: "LEVEL", accumulateInChain: true },
      eventValue: "1000",
      ancestors: [{ id: "a1", rankRate: "10" }, { id: "a2", rankRate: "3" }],
    });
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(Decimal.eq(records[0].amount, "100")).toBe(true);
  });

  test("distributeByDefs — FIXED SOURCE 固定金额（与事件值无关）", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "0" },
      rewardDefs: [{ rewardId: "signup_bonus", type: "FIXED", target: "SOURCE", fixedAmount: "88" }],
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("u1");
    expect(records[0].rewardType).toBe("FIXED");
    expect(Decimal.eq(records[0].amount, "88")).toBe(true);
  });

  test("distributeByDefs — FIXED PARENT 固定金额（与事件值无关）", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1" },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [{ rewardId: "per_order", type: "FIXED", target: "PARENT", fixedAmount: "5" }],
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("u0");
    expect(Decimal.eq(records[0].amount, "5")).toBe(true);
  });

  test("distributeByDefs — FIXED PARENT skipRankZero 默认跳过最低等级", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "100" },
      directParent: { id: "u0", rankRate: "0" },
      rewardDefs: [{ rewardId: "ref", type: "FIXED", target: "PARENT", fixedAmount: "8" }],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — FIXED PARENT skipRankZero=false 最低等级也发", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "100" },
      directParent: { id: "u0", rankRate: "0" },
      rewardDefs: [{ rewardId: "ref", type: "FIXED", target: "PARENT", fixedAmount: "8", skipRankZero: false }],
    });
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "8")).toBe(true);
  });

  test("distributeByDefs — FIXED fixedAmount=0 不发", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "100" },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [{ rewardId: "ref", type: "FIXED", target: "PARENT", fixedAmount: "0" }],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — FIXED 未知 target 抛错", () => {
    expect(() => Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "100" },
      rewardDefs: [{ rewardId: "ref", type: "FIXED", target: "BOGUS", fixedAmount: "8" }],
    })).toThrow(/FIXED 奖励定义未知 target/);
  });
});

// ====================== Allocate ======================

describe("Allocate", () => {
  test("applyCaps — 无封顶定义不裁剪", () => {
    const records = [{ nodeId: "u1", amount: "100" }];
    const capped = Engine.Allocate.applyCaps(records, []);
    expect(capped.length).toBe(1);
    expect(capped[0].amount).toBe("100");
  });

  test("applyCaps — 平台日封顶裁剪", () => {
    const records = [{ nodeId: "u1", amount: "200" }];
    const state = { platformPaid: "0", memberPaid: new Map() };
    const capped = Engine.Allocate.applyCaps(records, [
      { capId: "p1", scope: "PLATFORM_DAILY", limit: "150", onExceed: "REJECT" },
    ], state);
    expect(capped.length).toBe(1);
    expect(Decimal.gt(capped[0].amount, "0")).toBe(true);
    expect(Decimal.lte(capped[0].amount, "150")).toBe(true);
    expect(Decimal.gt(state.platformPaid, "0")).toBe(true);
  });

  test("applyCaps — 单用户日封顶裁剪", () => {
    const records = [{ nodeId: "u1", amount: "200" }];
    const state = { platformPaid: "0", memberPaid: new Map() };
    const capped = Engine.Allocate.applyCaps(records, [
      { capId: "u1", scope: "PER_USER_DAILY", limit: "100", onExceed: "REJECT" },
    ], state);
    expect(capped.length).toBe(1);
    expect(Decimal.gt(capped[0].amount, "0")).toBe(true);
    expect(Decimal.lte(capped[0].amount, "100")).toBe(true);
  });

  test("applyCaps — 超出额度丢弃", () => {
    const records = [{ nodeId: "u1", amount: "200" }];
    const state = { platformPaid: "190", memberPaid: new Map() };
    const capped = Engine.Allocate.applyCaps(records, [
      { capId: "p1", scope: "PLATFORM_DAILY", limit: "200", onExceed: "REJECT" },
    ], state);
    expect(capped.length).toBe(1);
    expect(Decimal.eq(capped[0].amount, "10")).toBe(true);
  });

  test("applyCaps — 多个记录推进水位", () => {
    const records = [
      { nodeId: "u1", amount: "100" },
      { nodeId: "u2", amount: "100" },
    ];
    const state = { platformPaid: "0", memberPaid: new Map() };
    const capped = Engine.Allocate.applyCaps(records, [
      { capId: "p1", scope: "PLATFORM_DAILY", limit: "150", onExceed: "REJECT" },
    ], state);
    expect(capped.length).toBe(2);
    expect(Decimal.eq(capped[0].amount, "100")).toBe(true);
    expect(Decimal.lte(capped[1].amount, "50")).toBe(true);
    expect(Decimal.gt(state.platformPaid, "0")).toBe(true);
  });

  test("applyBudgetGuard — 未超发不缩减", () => {
    const records = [{ nodeId: "u1", amount: "80" }];
    const result = Engine.Allocate.applyBudgetGuard(records, {
      totalBudget: "10", eventValue: "1000", onExceed: "CAP",
    });
    expect(result.length).toBe(1);
    expect(result[0].amount).toBe("80");
  });

  test("applyBudgetGuard — CAP 按比例缩减", () => {
    const records = [{ nodeId: "u1", amount: "200" }, { nodeId: "u2", amount: "100" }];
    const result = Engine.Allocate.applyBudgetGuard(records, {
      totalBudget: "10", eventValue: "1000", onExceed: "CAP",
    });
    expect(result.length).toBe(2);
    // 总金额 300, 预算上限 100, 比例 = 100/300 → 0.3333 (4位)
    // u1: 200 * 0.3333 = 66.6600, u2: 100 * 0.3333 = 33.3300
    expect(Decimal.lt(result[0].amount, "200")).toBe(true); // 被缩减
    expect(Decimal.gt(result[0].amount, "0")).toBe(true);
    expect(Decimal.lt(result[1].amount, "100")).toBe(true);
  });

  test("applyBudgetGuard — WARN 不修改金额", () => {
    const records = [{ nodeId: "u1", amount: "200" }];
    const context = {};
    const result = Engine.Allocate.applyBudgetGuard(records, {
      totalBudget: "10", eventValue: "1000", onExceed: "WARN",
    }, context);
    expect(result.length).toBe(1);
    expect(result[0].amount).toBe("200");
    expect(context.overBudgetWarnings.length).toBe(1);
  });

  test("applyBudgetGuard — REJECT 抛异常", () => {
    const records = [{ nodeId: "u1", amount: "200" }];
    expect(() => {
      Engine.Allocate.applyBudgetGuard(records, {
        totalBudget: "10", eventValue: "1000", onExceed: "REJECT",
      });
    }).toThrow("总预算超发");
  });

  test("applyBudgetGuard — 未知 onExceed 抛异常", () => {
    const records = [{ nodeId: "u1", amount: "200" }];
    expect(() => {
      Engine.Allocate.applyBudgetGuard(records, {
        totalBudget: "10", eventValue: "1000", onExceed: "NOPE",
      });
    }).toThrow("未知 onExceed");
  });

  test("splitByTargets — 正常拆分", () => {
    const { splits } = Engine.Allocate.splitByTargets("1000", [
      { target: "A", ratio: 70 },
      { target: "B", ratio: 30 },
    ]);
    expect(splits.length).toBe(2);
    expect(Decimal.eq(splits[0].amount, "700")).toBe(true);
    expect(Decimal.eq(splits[1].amount, "300")).toBe(true);
  });

  test("splitByTargets — 最后一项补差", () => {
    const { splits } = Engine.Allocate.splitByTargets("1000", [
      { target: "A", ratio: 33 },
      { target: "B", ratio: 33 },
      { target: "C", ratio: 33 },
    ]);
    expect(Decimal.eq(splits[0].amount, "330")).toBe(true);
    // 最后一项补差：1000 - 330 - 330 = 340
    expect(Decimal.eq(splits[2].amount, "340")).toBe(true);
  });

  test("compareAmounts — MAX", () => {
    const r = Engine.Allocate.compareAmounts("MAX", ["100", "200", "50"]);
    expect(r).toBe("200");
  });

  test("compareAmounts — MIN", () => {
    const r = Engine.Allocate.compareAmounts("MIN", ["100", "200", "50"]);
    expect(r).toBe("50");
  });

  test("compareAmounts — FIRST", () => {
    const r = Engine.Allocate.compareAmounts("FIRST", ["0", "200", "50"]);
    expect(r).toBe("200");
  });

  test("compareAmounts — 空数组返回默认值", () => {
    const r = Engine.Allocate.compareAmounts("MAX", []);
    expect(r).toBe("0");
  });
});

// ====================== Evaluate ======================

describe("Evaluate", () => {
  test("evaluateCondition — GTE 满足", () => {
    const r = Engine.Evaluate.evaluateCondition(
      { type: "COMPARE", field: "directCount", operator: "GTE", value: 5 },
      { directCount: 10 }
    );
    expect(r).toBe(true);
  });

  test("evaluateCondition — GTE 不满足", () => {
    const r = Engine.Evaluate.evaluateCondition(
      { type: "COMPARE", field: "directCount", operator: "GTE", value: 5 },
      { directCount: 3 }
    );
    expect(r).toBe(false);
  });

  test("evaluateCondition — AND 复合条件", () => {
    const r = Engine.Evaluate.evaluateCondition({
      type: "AND",
      children: [
        { type: "COMPARE", field: "a", operator: "GTE", value: 5 },
        { type: "COMPARE", field: "b", operator: "GTE", value: 10 },
      ],
    }, { a: 10, b: 20 });
    expect(r).toBe(true);
  });

  test("evaluateCondition — OR 复合条件（一个满足）", () => {
    const r = Engine.Evaluate.evaluateCondition({
      type: "OR",
      children: [
        { type: "COMPARE", field: "a", operator: "GTE", value: 100 },
        { type: "COMPARE", field: "b", operator: "GTE", value: 10 },
      ],
    }, { a: 5, b: 20 });
    expect(r).toBe(true);
  });

  test("evaluateCondition — NOT 反转", () => {
    const r = Engine.Evaluate.evaluateCondition({
      type: "NOT",
      children: [{ type: "COMPARE", field: "a", operator: "GTE", value: 5 }],
    }, { a: 3 });
    expect(r).toBe(true);
  });

  test("evaluateTier — 基本等级评估", () => {
    const rankDefs = [
      { rankId: "V0", levelIndex: 0, conditions: [] },
      { rankId: "V1", levelIndex: 1, conditions: [{ field: "directCount", operator: "GTE", value: 5 }] },
    ];
    // evaluateTier 是布尔函数：判断节点是否满足某个等级的条件
    expect(Engine.Evaluate.evaluateTier({ directCount: 10 }, rankDefs[0])).toBe(true);
    expect(Engine.Evaluate.evaluateTier({ directCount: 10 }, rankDefs[1])).toBe(true);
    expect(Engine.Evaluate.evaluateTier({ directCount: 2 }, rankDefs[1])).toBe(false);
  });

  test("evaluateTier — 最低等级兜底", () => {
    const rankDefs = [
      { rankId: "V0", levelIndex: 0, conditions: [] },
      { rankId: "V1", levelIndex: 1, conditions: [{ field: "directCount", operator: "GTE", value: 5 }] },
    ];
    // V0 无条件门槛，始终满足
    expect(Engine.Evaluate.evaluateTier({ directCount: 2 }, rankDefs[0])).toBe(true);
    // 最高等级用 getHighestQualifiedTier
    const result = Engine.Evaluate.getHighestQualifiedTier({ directCount: 2 }, rankDefs);
    expect(result.rankId).toBe("V0");
  });

  test("getHighestQualifiedTier — 找到最高等级", () => {
    const rankDefs = [
      { rankId: "V0", levelIndex: 0, conditions: [] },
      { rankId: "V1", levelIndex: 1, conditions: [{ field: "directCount", operator: "GTE", value: 5 }] },
      { rankId: "V2", levelIndex: 2, conditions: [{ field: "directCount", operator: "GTE", value: 10 }] },
    ];
    const result = Engine.Evaluate.getHighestQualifiedTier({ directCount: 10 }, rankDefs);
    expect(result.rankId).toBe("V2");
  });

  test("getHighestQualifiedTier — tiers 缺省返回 null", () => {
    expect(Engine.Evaluate.getHighestQualifiedTier({ directCount: 10 })).toBeNull();
    expect(Engine.Evaluate.getHighestQualifiedTier({ directCount: 10 }, undefined)).toBeNull();
  });
});

// ====================== Orchestrate ======================

describe("Orchestrate", () => {
  test("executePipeline — DISTRIBUTE + CAP", () => {
    const { final } = Engine.Orchestrate.executePipeline({
      stages: [
        {
          id: "distribute",
          handler: "DISTRIBUTE",
          config: {
            event: { sourceNodeId: "u1", eventValue: "1000" },
            directParent: { id: "u0", rankRate: "10" },
            rewardDefs: [
              { rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" },
              { rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "5" },
            ],
          },
        },
        {
          id: "cap",
          handler: "CAP",
          config: {
            capDefs: [{ capId: "user_day", scope: "PER_USER_DAILY", limit: "800", onExceed: "REJECT" }],
          },
        },
      ],
    });
    // 裁剪后 self 被限制到 800, ref 水位不足被丢弃
    expect(final.length).toBeGreaterThanOrEqual(1);
    expect(final[0].nodeId).toBe("u1");
    expect(Decimal.lte(final[0].amount, "800")).toBe(true);
  });

  test("executePipeline — DISTRIBUTE + OVER + CAP", () => {
    const { final } = Engine.Orchestrate.executePipeline({
      stages: [
        {
          id: "distribute",
          handler: "DISTRIBUTE",
          config: {
            event: { sourceNodeId: "u1", eventValue: "1000" },
            directParent: { id: "u0", rankRate: "10" },
            rewardDefs: [
              { rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" },
              { rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "10" },
            ],
          },
        },
        {
          id: "budget",
          handler: "OVER",
          config: { totalBudget: "105", eventValue: "1000", onExceed: "CAP" },
        },
        {
          id: "cap",
          handler: "CAP",
          config: { capDefs: [] },
        },
      ],
    });
    // 总金额 1100, 预算上限 1050, 比例 = 1050/1100
    expect(final.length).toBe(2);
    // 验证 self 被缩减
    expect(Decimal.lt(final[0].amount, "1000")).toBe(true);
    expect(Decimal.gt(final[0].amount, "0")).toBe(true);
  });

  test("executePipeline — 未知 handler 抛异常", () => {
    expect(() => {
      Engine.Orchestrate.executePipeline({
        stages: [{ id: "x", handler: "UNKNOWN", config: {} }],
      });
    }).toThrow("未知流水线阶段 handler");
  });

  test("executePipeline — CAP 在 DISTRIBUTE 之前抛异常", () => {
    expect(() => {
      Engine.Orchestrate.executePipeline({
        stages: [
          { id: "cap", handler: "CAP", config: { capDefs: [{ scope: "PLATFORM_DAILY", limit: "100" }] } },
          { id: "distribute", handler: "DISTRIBUTE", config: {
            event: { sourceNodeId: "u1", eventValue: "1000" },
            rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }],
          } },
        ],
      });
    }).toThrow("CAP 阶段前无输入数据");
  });

  test("executePipeline — OVER 在 DISTRIBUTE 之前抛异常", () => {
    expect(() => {
      Engine.Orchestrate.executePipeline({
        stages: [
          { id: "over", handler: "OVER", config: { totalBudget: "100", eventValue: "1000" } },
        ],
      });
    }).toThrow("OVER 阶段前无输入数据");
  });

  test("executePipeline — SPLIT 缺少 totalAmount 抛异常", () => {
    expect(() => {
      Engine.Orchestrate.executePipeline({
        stages: [
          { id: "split", handler: "SPLIT", config: { targets: [{ target: "A", ratio: "100" }] } },
        ],
      });
    }).toThrow("SPLIT 阶段缺少 totalAmount");
  });

  test("executePipeline — SPLIT 独立拆分", () => {
    const { final } = Engine.Orchestrate.executePipeline({
      stages: [
        { id: "split", handler: "SPLIT", config: {
          totalAmount: "1000",
          targets: [{ target: "LIQUID", ratio: "70" }, { target: "POINT", ratio: "30" }],
        } },
      ],
    });
    expect(final.splits.length).toBe(2);
    expect(Decimal.eq(final.splits[0].amount, "700")).toBe(true);
    expect(Decimal.eq(final.splits[1].amount, "300")).toBe(true);
  });
});

// ====================== Adapters ======================

describe("Adapters", () => {
  test("buildPipelineStages — 默认 DISTRIBUTE + CAP", () => {
    const stages = require("../src/adapters").buildPipelineStages(
      {
        rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
        capDefs: [],
      },
      { event: { sourceNodeId: "u1", eventValue: "1000" }, directParent: null, ancestors: [] }
    );
    expect(stages.length).toBe(2);
    expect(stages[0].handler).toBe("DISTRIBUTE");
    expect(stages[1].handler).toBe("CAP");
  });

  test("buildPipelineStages — 自定义 pipelineDef", () => {
    const stages = require("../src/adapters").buildPipelineStages(
      {
        rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
        capDefs: [],
        pipelineDef: { stages: [{ id: "d", handler: "DISTRIBUTE" }, { id: "o", handler: "OVER" }, { id: "c", handler: "CAP" }] },
      },
      { event: { sourceNodeId: "u1", eventValue: "1000" }, directParent: null, ancestors: [] }
    );
    expect(stages.length).toBe(3);
    expect(stages[1].handler).toBe("OVER");
  });

  test("customerAdapterTemplate 存在且有结构", () => {
    const template = require("../src/adapters").customerAdapterTemplate;
    expect(template).toBeDefined();
    expect(typeof template).toBe("object");
  });
});

// ====================== Validation ======================

describe("Validation", () => {
  const Joi = require("joi");
  const { createRuleSetValidation } = require("../src/validation");
  const { ruleSetConfigSchema } = createRuleSetValidation(Joi);

  test("ruleSetConfigSchema - 有效配置通过", () => {
    const validConfig = {
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
      capDefs: [{ capId: "c1", scope: "PER_USER_DAILY", limit: "5000" }],
      allocators: [{ allocatorId: "a1", type: "PERCENTAGE_SPLIT", targets: [{ target: "LIQUID", ratio: 100 }] }],
      pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
    };
    const { error } = ruleSetConfigSchema.validate(validConfig);
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - 缺少 rewardDefs 失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
  });

  test("ruleSetConfigSchema - rewardId 重复失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [
        { rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" },
        { rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "5" },
      ],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
  });

  test("ruleSetConfigSchema - rate 超过 1000 失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "1500" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
  });

  test("ruleSetConfigSchema - FIXED 类型带 fixedAmount 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "FIXED", target: "PARENT", fixedAmount: "8" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - FIXED 类型缺 fixedAmount 失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "FIXED", target: "PARENT", rate: "5" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
    expect(error.details[0].context.message).toMatch(/fixedAmount/);
  });

  test("ruleSetConfigSchema - FIXED fixedAmount=0 失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "FIXED", target: "PARENT", fixedAmount: "0" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
    expect(error.details[0].context.message).toMatch(/fixedAmount/);
  });
});

// ====================== Utils ======================

describe("Utils", () => {
  test("selectVersionByRoutingKey - 单版本直接返回", () => {
    const { selectVersionByRoutingKey } = require("../src/utils");
    const result = selectVersionByRoutingKey(
      { enabled: true, versions: [{ version: 1, weight: 100, config_json: { test: true } }] },
      "user123"
    );
    expect(result.version).toBe(1);
  });

  test("selectVersionByRoutingKey - 禁用的灰度返回 null", () => {
    const { selectVersionByRoutingKey } = require("../src/utils");
    const result = selectVersionByRoutingKey(
      { enabled: false, versions: [{ version: 1, weight: 100, config_json: { test: true } }] },
      "user123"
    );
    expect(result).toBeNull();
  });

  test("selectVersionByRoutingKey - 多版本按权重分配", () => {
    const { selectVersionByRoutingKey } = require("../src/utils");
    const config = {
      enabled: true,
      versions: [
        { version: 1, weight: 50, config_json: { v: 1 } },
        { version: 2, weight: 50, config_json: { v: 2 } },
      ],
    };
    const results = new Set();
    for (let i = 0; i < 100; i++) {
      const r = selectVersionByRoutingKey(config, `user${i}`);
      results.add(r.version);
    }
    expect(results.size).toBe(2);
  });

  test("validateGrayscaleWeights - 权重总和 100 返回 true", () => {
    const { validateGrayscaleWeights } = require("../src/utils");
    expect(validateGrayscaleWeights({
      enabled: true,
      versions: [{ version: 1, weight: 70 }, { version: 2, weight: 30 }],
    })).toBe(true);
  });

  test("validateGrayscaleWeights - 权重总和不为 100 返回 false", () => {
    const { validateGrayscaleWeights } = require("../src/utils");
    expect(validateGrayscaleWeights({
      enabled: true,
      versions: [{ version: 1, weight: 60 }, { version: 2, weight: 30 }],
    })).toBe(false);
  });
});

// ====================== Decimal ======================

describe("Decimal", () => {
  test("mul", () => expect(Decimal.eq(Decimal.mul("10", "20"), "200")).toBe(true));
  test("add", () => expect(Decimal.eq(Decimal.add("10", "20"), "30")).toBe(true));
  test("sub", () => expect(Decimal.eq(Decimal.sub("20", "10"), "10")).toBe(true));
  test("div", () => expect(Decimal.eq(Decimal.div("100", "3"), "33.3333")).toBe(true));
  test("round", () => expect(Decimal.round("33.3333", 2)).toBe("33.33"));
  test("pct", () => expect(Decimal.eq(Decimal.pct("1000", "5"), "50")).toBe(true));
  test("gte (true)", () => expect(Decimal.gte("10", "5")).toBe(true));
  test("gte (false)", () => expect(Decimal.gte("5", "10")).toBe(false));
  test("lt", () => expect(Decimal.lt("5", "10")).toBe(true));
  test("gt", () => expect(Decimal.gt("10", "5")).toBe(true));
  test("lte", () => expect(Decimal.lte("5", "10")).toBe(true));
  test("eq", () => expect(Decimal.eq("5", "5")).toBe(true));
  test("min", () => expect(Decimal.min("10", "5")).toBe("5"));
  test("max", () => expect(Decimal.max("10", "5")).toBe("10"));
  test("neg", () => expect(Decimal.neg("10")).toBe("-10"));
  test("toDisplay", () => expect(Decimal.toDisplay("33.3333", 2)).toBe(33.33));
  test("toFixed", () => expect(Decimal.toFixed("33.3", 4)).toBe("33.3000"));
});
