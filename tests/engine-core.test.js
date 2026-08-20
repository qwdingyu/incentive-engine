/**
 * @usethink/incentive-engine 核心模块单元测试
 *
 * 覆盖 6 个核心子模块：Model / Distribute / Allocate / Evaluate / Orchestrate / Reverse
 * 以及 Adapters / Validation / Utils 扩展模块。
 */

const Decimal = require("../src/decimal");
const Engine = require("../src/engine");
const { buildPipelineStages, customerAdapterTemplate } = require("../src/adapters");
const Joi = require("joi");
const { createRuleSetValidation } = require("../src/validation");
const { ruleSetConfigSchema } = createRuleSetValidation(Joi);
const { selectVersionByRoutingKey, validateGrayscaleWeights, isWithinWindow } = require("../src/utils");

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

  test("distributeByDefs — conditions 满足时发放（event.attrs 字段）", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000", attrs: { orderAmount: "2000" } },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [
        {
          rewardId: "ref",
          type: "DIRECT",
          target: "PARENT",
          rate: "5",
          conditions: [{ field: "orderAmount", operator: "GTE", value: 1000 }],
        },
      ],
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("u0");
    expect(Decimal.eq(records[0].amount, "50")).toBe(true);
  });

  test("distributeByDefs — conditions 不满足时跳过该奖励（防静默超发）", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000", attrs: { orderAmount: "500" } },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [
        {
          rewardId: "ref",
          type: "DIRECT",
          target: "PARENT",
          rate: "5",
          conditions: [{ field: "orderAmount", operator: "GTE", value: 1000 }],
        },
      ],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — conditions 复合 AND 全部满足才发放", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000", attrs: { orderAmount: "2000", vip: "V3" } },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [
        {
          rewardId: "ref",
          type: "DIRECT",
          target: "PARENT",
          rate: "5",
          conditions: [
            { field: "orderAmount", operator: "GTE", value: 1000 },
            { field: "vip", operator: "EQ", value: "V3" },
          ],
        },
      ],
    });
    expect(records.length).toBe(1);
  });

  test("distributeByDefs — conditions 复合 AND 任一不满足则跳过", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000", attrs: { orderAmount: "2000", vip: "V1" } },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [
        {
          rewardId: "ref",
          type: "DIRECT",
          target: "PARENT",
          rate: "5",
          conditions: [
            { field: "orderAmount", operator: "GTE", value: 1000 },
            { field: "vip", operator: "EQ", value: "V3" },
          ],
        },
      ],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — conditions 为空数组时正常发放（向后兼容）", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [
        { rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "5", conditions: [] },
      ],
    });
    expect(records.length).toBe(1);
  });

  test("distributeByDefs — conditions 非数值字段 GTE/GT/LTE/LT 不崩溃返回 false", () => {
    // 运营配置了 { field: "vip", operator: "GTE", value: "V3" }（非数值字段大小比较）
    // 引擎不应崩溃，应安全返回 false（条件不满足，跳过奖励）
    const event = { sourceNodeId: "u1", eventValue: "1000", attrs: { vip: "V3" } };
    const ops = ["GTE", "GT", "LTE", "LT"];
    for (const op of ops) {
      const records = Engine.Distribute.distributeByDefs({
        event,
        directParent: { id: "u0", rankRate: "10" },
        rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "5", conditions: [{ field: "vip", operator: op, value: "V2" }] }],
      });
      expect(records.length).toBe(0); // 非数值大小比较 → 安全返回 false → 跳过
    }
  });

  test("distributeByDefs — conditions 带空格数字不崩溃（trim 规范化）", () => {
    // 业务事件字段值可能带空格（如 " 2000 "），decimal.js 不接受带空格数字
    // 引擎应 trim 后比较，不崩溃
    const event = { sourceNodeId: "u1", eventValue: "1000", attrs: { orderAmount: " 2000 " } };
    const records = Engine.Distribute.distributeByDefs({
      event,
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "5", conditions: [{ field: "orderAmount", operator: "GTE", value: 1000 }] }],
    });
    expect(records.length).toBe(1); // 2000 >= 1000 → 发放
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

  test("distributeByDefs — CUSTOM 无金额来源静默跳过不抛错", () => {
    // CUSTOM 已实现（v3.3.0）：amount/amountFrom 均未配置 → 金额解析失败静默跳过，
    // 保持"配置中存在但未配金额的 CUSTOM 规则"不抛错兼容（规则集校验层会提前拦截）。
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      rewardDefs: [{ rewardId: "custom", type: "CUSTOM", target: "SOURCE" }],
    });
    expect(records).toEqual([]);
  });

  test("distributeByDefs — CUSTOM 未知 target 抛错", () => {
    expect(() => Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "100" },
      rewardDefs: [{ rewardId: "custom", type: "CUSTOM", target: "BOGUS", amount: "8" }],
    })).toThrow(/CUSTOM 奖励定义未知 target/);
  });

  test("distributeByDefs — CUSTOM SOURCE 固定金额常量", () => {
    // "注册送 100 积分"：事件来源节点自身拿固定金额，与事件值无关。
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "0" },
      rewardDefs: [{ rewardId: "signup_bonus", type: "CUSTOM", target: "SOURCE", amount: "100" }],
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("u1");
    expect(records[0].rewardType).toBe("CUSTOM");
    expect(Decimal.eq(records[0].amount, "100")).toBe(true);
    expect(records[0].snapshot.amountFrom).toBeNull();
  });

  test("distributeByDefs — CUSTOM SOURCE 动态取数 eventValue", () => {
    // 金额 = 事件值本身（如"按实付金额发放"）。
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "88" },
      rewardDefs: [{ rewardId: "cashback", type: "CUSTOM", target: "SOURCE", amountFrom: "eventValue" }],
    });
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "88")).toBe(true);
  });

  test("distributeByDefs — CUSTOM SOURCE 动态取数 event.attrs 路径", () => {
    // 从事件扩展属性按点分路径取数（如"V1 等级拿 10 元"由上层把等级金额写入 attrs）。
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "0", attrs: { level: { bonus: "10" } } },
      rewardDefs: [{ rewardId: "level_bonus", type: "CUSTOM", target: "SOURCE", amountFrom: "event.attrs.level.bonus" }],
    });
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "10")).toBe(true);
  });

  test("distributeByDefs — CUSTOM 取数失败回退 amount 常量", () => {
    // attrs 中无该路径 → 回退固定金额 5。
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "0", attrs: { level: "V1" } },
      rewardDefs: [{
        rewardId: "level_bonus", type: "CUSTOM", target: "SOURCE",
        amount: "5", amountFrom: "event.attrs.level.bonus",
      }],
    });
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "5")).toBe(true);
  });

  test("distributeByDefs — CUSTOM SOURCE 金额<=0 不发", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "0" },
      rewardDefs: [{ rewardId: "zero", type: "CUSTOM", target: "SOURCE", amount: "0" }],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — CUSTOM PARENT 固定金额（与事件值无关）", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1" },
      directParent: { id: "u0", rankRate: "10" },
      rewardDefs: [{ rewardId: "inviter_bonus", type: "CUSTOM", target: "PARENT", amount: "50" }],
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("u0");
    expect(Decimal.eq(records[0].amount, "50")).toBe(true);
  });

  test("distributeByDefs — CUSTOM PARENT skipRankZero 默认跳过最低等级", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "100" },
      directParent: { id: "u0", rankRate: "0" },
      rewardDefs: [{ rewardId: "inviter_bonus", type: "CUSTOM", target: "PARENT", amount: "50" }],
    });
    expect(records.length).toBe(0);
  });

  test("distributeByDefs — CUSTOM PARENT skipRankZero=false 最低等级也发", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "100" },
      directParent: { id: "u0", rankRate: "0" },
      rewardDefs: [{
        rewardId: "inviter_bonus", type: "CUSTOM", target: "PARENT",
        amount: "50", skipRankZero: false,
      }],
    });
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "50")).toBe(true);
  });

  test("calculateCustom — 动态取数 eventValue 覆盖固定金额", () => {
    const r = Engine.Distribute.calculateCustom({
      rewardDef: { rewardId: "c", type: "CUSTOM", amount: "1", amountFrom: "eventValue" },
      event: { eventValue: "999" },
      targetNode: { id: "u0", rankRate: "10" },
    });
    expect(r).not.toBeNull();
    expect(Decimal.eq(r.amount, "999")).toBe(true);
    expect(r.rewardType).toBe("CUSTOM");
  });

  test("calculateCustom — 无目标节点返回 null", () => {
    const r = Engine.Distribute.calculateCustom({
      rewardDef: { rewardId: "c", type: "CUSTOM", amount: "10" },
      event: { eventValue: "100" },
      targetNode: null,
    });
    expect(r).toBeNull();
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

  // --- 4.0.0 新增：LEVEL maxDepth 链式层数上限 ---

  // 递增 rankRate 保证每一层都有正差额，从而可观察 maxDepth 是否真正截断
  const eightAncestors = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, rankRate: String((i + 1) * 2) }));
  const levelChain = (maxDepth) => Engine.Distribute.distributeByDefs({
    event: { sourceNodeId: "u1", eventValue: "1000" },
    ancestors: eightAncestors,
    rewardDefs: [{ rewardId: "lv", type: "LEVEL", accumulateInChain: true, ...(maxDepth === undefined ? {} : { maxDepth }) }],
  });

  test("calculateLevelChain — 未配置 maxDepth 时不限层数（8 层全发）", () => {
    expect(levelChain(undefined).length).toBe(8);
  });

  test("calculateLevelChain — maxDepth 截断到前 N 层，且超出层不发放", () => {
    const records = levelChain(2);
    expect(records.length).toBe(2);
    expect(records.map((r) => r.nodeId)).toEqual(["a0", "a1"]);
    // 层号写入 snapshot.depth，便于对账回溯（1 = 最近的祖先）
    expect(records.map((r) => r.snapshot.depth)).toEqual([1, 2]);
  });

  test("calculateLevelChain — maxDepth 大于实际链长时等同不限层数", () => {
    expect(levelChain(99).length).toBe(8);
  });

  test("calculateLevelChain — 非法 maxDepth 抛错（不静默忽略，否则深度风控失效）", () => {
    for (const bad of [0, -1, 1.5, "abc"]) {
      expect(() => levelChain(bad)).toThrow(/非法 maxDepth/);
    }
  });

  test("calculateLevelChain — maxDepth 截断的层不推进水位（第 N+1 层完全不参与计算）", () => {
    // maxDepth=1：只有 a0（rankRate 2%）参与，金额 1000×2%=20
    const records = levelChain(1);
    expect(records.length).toBe(1);
    expect(Decimal.eq(records[0].amount, "20")).toBe(true);
  });

  // --- 4.0.0 新增：LEVEL levelRates 按层固定比例（多级固定比例分销） ---

  const byLevelRates = (extra) => Engine.Distribute.distributeByDefs({
    event: { sourceNodeId: "u1", eventValue: "1000" },
    ancestors: eightAncestors,
    rewardDefs: [{ rewardId: "lv", type: "LEVEL", ...extra }],
  });

  test("calculateLevelChain — levelRates 按层固定比例发放（一级 10%/二级 5%/三级 3%）", () => {
    const records = byLevelRates({ levelRates: ["10", "5", "3"] });
    expect(records.map((r) => r.nodeId)).toEqual(["a0", "a1", "a2"]);
    ["100", "50", "30"].forEach((expected, i) => expect(Decimal.eq(records[i].amount, expected)).toBe(true));
    // 比例表长度即隐式深度上限：第 4 层及以后不发
    expect(records.length).toBe(3);
  });

  test("calculateLevelChain — levelRates 完全不看 rankRate（各层独立、不推进水位）", () => {
    // 祖先链 rankRate 递增（2%~16%），若走水位差每层只拿 2%；按层固定比例则各拿自己那一层
    const records = byLevelRates({ levelRates: ["10", "10"] });
    expect(records.length).toBe(2);
    records.forEach((r) => expect(Decimal.eq(r.amount, "100")).toBe(true));
    expect(records.map((r) => r.snapshot.mode)).toEqual(["LEVEL_RATES", "LEVEL_RATES"]);
    // 对账不变量：amount = eventValue × diffRate 在两套口径下一致成立
    records.forEach((r) => expect(Decimal.eq(r.amount, Decimal.pct("1000", r.diffRate))).toBe(true));
  });

  test("calculateLevelChain — levelRates 中为 0 的层不发放但仍占一层（层号不前移）", () => {
    const records = byLevelRates({ levelRates: ["10", "0", "3"] });
    expect(records.map((r) => r.nodeId)).toEqual(["a0", "a2"]);
    expect(records.map((r) => r.snapshot.depth)).toEqual([1, 3]);
  });

  test("calculateLevelChain — levelRates 与 maxDepth 并存时取更严的一方", () => {
    expect(byLevelRates({ levelRates: ["10", "5", "3"], maxDepth: 2 }).map((r) => r.nodeId)).toEqual(["a0", "a1"]);
    // 比例表比 maxDepth 更短时，由比例表兜住深度
    expect(byLevelRates({ levelRates: ["10"], maxDepth: 5 }).map((r) => r.nodeId)).toEqual(["a0"]);
  });

  test("calculateLevelChain — 祖先链短于比例表时只发实际存在的层", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      ancestors: [{ id: "a0" }],
      rewardDefs: [{ rewardId: "lv", type: "LEVEL", levelRates: ["10", "5"] }],
    });
    expect(records.map((r) => r.nodeId)).toEqual(["a0"]);
    expect(Decimal.eq(records[0].amount, "100")).toBe(true);
  });

  test("calculateLevelChain — 非法 levelRates 抛错（空数组/非数组/负数/非数字/全 0）", () => {
    for (const bad of [[], {}, "10", ["-1"], ["abc"], [null], ["0", "0"]]) {
      expect(() => byLevelRates({ levelRates: bad })).toThrow(/levelRates/);
    }
  });

  test("calculateLevelChain — levelRates 与 accumulateInChain=true 互斥（两套口径总额不同）", () => {
    expect(() => byLevelRates({ levelRates: ["10"], accumulateInChain: true }))
      .toThrow(/levelRates 与 accumulateInChain=true 互斥/);
  });

  test("calculateLevelChain — levelRates 为 null/undefined 时回落水位差口径（向后兼容）", () => {
    expect(byLevelRates({ accumulateInChain: true, levelRates: null }).length).toBe(8);
    expect(byLevelRates({ accumulateInChain: true }).length).toBe(8);
  });

  // --- 4.0.0 新增：target=ANCESTOR 定点单层发放 ---

  const byAncestorTarget = (def) => Engine.Distribute.distributeByDefs({
    event: { sourceNodeId: "u1", eventValue: "1000", attrs: { bonus: "88" } },
    directParent: { id: "p0", rankRate: "10" },
    ancestors: eightAncestors,
    rewardDefs: [{ skipRankZero: false, ...def }],
  });

  test("distributeByDefs — DIRECT + target=ANCESTOR 定点发给第 n 层这一个节点", () => {
    const records = byAncestorTarget({
      rewardId: "lv3", type: "DIRECT", target: "ANCESTOR", ancestorLevel: 3, rate: "3",
    });
    expect(records.length).toBe(1);
    expect(records[0].nodeId).toBe("a2");
    expect(Decimal.eq(records[0].amount, "30")).toBe(true);
    // 层级溯源：snapshot 同时带 target/ancestorLevel/depth（depth 与 LEVEL 记录同名同义）
    expect(records[0].snapshot.target).toBe("ANCESTOR");
    expect(records[0].snapshot.ancestorLevel).toBe(3);
    expect(records[0].snapshot.depth).toBe(3);
  });

  test("distributeByDefs — ancestorLevel=1 即最近的祖先（与 LEVEL 层号口径一致）", () => {
    const records = byAncestorTarget({
      rewardId: "lv1", type: "DIRECT", target: "ANCESTOR", ancestorLevel: 1, rate: "10",
    });
    expect(records.map((r) => r.nodeId)).toEqual(["a0"]);
  });

  test("distributeByDefs — FIXED/CUSTOM 同样支持 target=ANCESTOR", () => {
    const fixed = byAncestorTarget({
      rewardId: "f", type: "FIXED", target: "ANCESTOR", ancestorLevel: 2, fixedAmount: "50",
    });
    expect(fixed.map((r) => [r.nodeId, r.amount])).toEqual([["a1", "50"]]);
    expect(fixed[0].snapshot.ancestorLevel).toBe(2);

    const custom = byAncestorTarget({
      rewardId: "c", type: "CUSTOM", target: "ANCESTOR", ancestorLevel: 4, amountFrom: "event.attrs.bonus",
    });
    expect(custom.map((r) => [r.nodeId, r.amount])).toEqual([["a3", "88"]]);
    expect(custom[0].snapshot.depth).toBe(4);
  });

  test("distributeByDefs — 祖先链短于 ancestorLevel 时不发放（运行期数据，不抛错）", () => {
    const records = Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      ancestors: [{ id: "a0", rankRate: "10" }],
      rewardDefs: [{ rewardId: "lv5", type: "DIRECT", target: "ANCESTOR", ancestorLevel: 5, rate: "3", skipRankZero: false }],
    });
    expect(records).toEqual([]);
  });

  test("distributeByDefs — target=ANCESTOR 未声明 ancestorLevel 抛错（不兜底取第 1 层）", () => {
    for (const type of ["DIRECT", "FIXED", "CUSTOM"]) {
      expect(() => byAncestorTarget({
        rewardId: "x", type, target: "ANCESTOR", rate: "3", fixedAmount: "5", amount: "5",
      })).toThrow(/必须声明 ancestorLevel/);
    }
  });

  test("distributeByDefs — 非法 ancestorLevel 抛错（0/负数/小数/非数字）", () => {
    for (const bad of [0, -1, 2.5, "abc"]) {
      expect(() => byAncestorTarget({
        rewardId: "x", type: "DIRECT", target: "ANCESTOR", ancestorLevel: bad, rate: "3",
      })).toThrow(/非法 ancestorLevel/);
    }
  });

  test("distributeByDefs — target=ANCESTOR 同样受 skipRankZero 约束（缺省 true 时未评级节点跳过）", () => {
    const defs = { rewardId: "lv1", type: "DIRECT", target: "ANCESTOR", ancestorLevel: 1, rate: "10" };
    const call = (ancestors, extra) => Engine.Distribute.distributeByDefs({
      event: { sourceNodeId: "u1", eventValue: "1000" },
      ancestors,
      rewardDefs: [{ ...defs, ...extra }],
    });
    // 未评级（无 rankRate）+ 缺省 skipRankZero=true → 跳过（少发方向，与 PARENT 一致）
    expect(call([{ id: "a0" }])).toEqual([]);
    // 显式关闭后正常发放 —— 定点发放的比例挂在规则上，通常应写 skipRankZero: false
    expect(call([{ id: "a0" }], { skipRankZero: false }).map((r) => r.nodeId)).toEqual(["a0"]);
  });

  // ---------- 受益节点侧条件（conditions 的 source: "event" | "target"）----------

  describe("distributeByDefs — conditions 的 source 数据源", () => {
    const event = { sourceNodeId: "u1", eventValue: "1000", attrs: { orderAmount: "2000" } };

    test("事件侧条件（source 省略 / 显式 event）行为一致", () => {
      const run = (source) => Engine.Distribute.distributeByDefs({
        event,
        directParent: { id: "p1", rankRate: "10" },
        rewardDefs: [{
          rewardId: "c1", type: "DIRECT", target: "PARENT", rate: "10",
          conditions: [{ field: "orderAmount", operator: "GTE", value: 1000, ...(source ? { source } : {}) }],
        }],
      });
      expect(run().map((r) => [r.nodeId, r.amount])).toEqual([["p1", "100"]]);
      expect(run("event")).toEqual(run());
    });

    test("受益节点侧条件挡住 PARENT 发放（只给达标上级发）", () => {
      const run = (parent) => Engine.Distribute.distributeByDefs({
        event,
        directParent: parent,
        rewardDefs: [{
          rewardId: "c2", type: "DIRECT", target: "PARENT", rate: "10", skipRankZero: false,
          conditions: [{ field: "teamPerformance", operator: "GTE", value: "50000", source: "target" }],
        }],
      });
      // 上级团队业绩不足 → 不发
      expect(run({ id: "p1", teamPerformance: "10000" })).toEqual([]);
      // 达标 → 正常发
      expect(run({ id: "p1", teamPerformance: "50000" }).map((r) => [r.nodeId, r.amount])).toEqual([["p1", "100"]]);
      // 无上级 → 不发且不抛错（运行期网络结构）
      expect(run(null)).toEqual([]);
    });

    test("受益节点侧条件读 attrs（与 condition-evaluator 的 attrs 优先口径一致）", () => {
      const records = Engine.Distribute.distributeByDefs({
        event,
        directParent: { id: "p1", attrs: { vipLevel: "V3" } },
        rewardDefs: [{
          rewardId: "c3", type: "FIXED", target: "PARENT", fixedAmount: "8", skipRankZero: false,
          conditions: [{ field: "vipLevel", operator: "EQ", value: "V3", source: "target" }],
        }],
      });
      expect(records.map((r) => [r.nodeId, r.amount])).toEqual([["p1", "8"]]);
    });

    test("事件侧 + 受益节点侧混合在同一棵 AND 树里同时生效", () => {
      const defs = [{
        rewardId: "c4", type: "CUSTOM", target: "PARENT", amount: "20", skipRankZero: false,
        conditions: [{
          type: "AND",
          children: [
            { field: "orderAmount", operator: "GTE", value: 1000, source: "event" },
            { field: "rankRate", operator: "GTE", value: 15, source: "target" },
          ],
        }],
      }];
      const run = (parent, ev) => Engine.Distribute.distributeByDefs({ event: ev ?? event, directParent: parent, rewardDefs: defs });
      expect(run({ id: "p1", rankRate: "15" }).map((r) => r.amount)).toEqual(["20"]);
      // 节点侧不满足 → 不发
      expect(run({ id: "p1", rankRate: "10" })).toEqual([]);
      // 事件侧不满足 → 不发
      expect(run({ id: "p1", rankRate: "15" }, { sourceNodeId: "u1", eventValue: "1000", attrs: { orderAmount: "500" } })).toEqual([]);
    });

    test("target=ANCESTOR 受益节点侧条件按该层节点求值", () => {
      const run = (ancestors) => Engine.Distribute.distributeByDefs({
        event,
        ancestors,
        rewardDefs: [{
          rewardId: "c5", type: "DIRECT", target: "ANCESTOR", ancestorLevel: 2, rate: "5", skipRankZero: false,
          conditions: [{ field: "directCount", operator: "GTE", value: 5, source: "target" }],
        }],
      });
      // 第 2 层达标 → 发；第 1 层的属性不参与判断
      expect(run([{ id: "a1", directCount: 0 }, { id: "a2", directCount: 5 }]).map((r) => [r.nodeId, r.amount]))
        .toEqual([["a2", "50"]]);
      // 第 2 层不达标 → 不发
      expect(run([{ id: "a1", directCount: 9 }, { id: "a2", directCount: 1 }])).toEqual([]);
      // 链长不足 → 不发且不抛错
      expect(run([{ id: "a1", directCount: 9 }])).toEqual([]);
    });

    test("target=SOURCE 有受益节点侧条件时按 sourceNode 求值；未传 sourceNode 抛错", () => {
      const defs = [{
        rewardId: "c6", type: "DIRECT", target: "SOURCE", rate: "100",
        conditions: [{ field: "certified", operator: "EQ", value: 1, source: "target" }],
      }];
      expect(() => Engine.Distribute.distributeByDefs({ event, rewardDefs: defs }))
        .toThrow(/请给 distributeByDefs 传入 sourceNode/);
      expect(Engine.Distribute.distributeByDefs({
        event, sourceNode: { id: "u1", certified: 1 }, rewardDefs: defs,
      }).map((r) => [r.nodeId, r.amount])).toEqual([["u1", "1000"]]);
      expect(Engine.Distribute.distributeByDefs({
        event, sourceNode: { id: "u1", certified: 0 }, rewardDefs: defs,
      })).toEqual([]);
    });

    test("LEVEL 水位差：被节点侧条件挡掉的层不发放且不推进水位（不牵连上方层金额）", () => {
      const ancestors = [
        { id: "a1", rankRate: "15", teamPerformance: "0" },
        { id: "a2", rankRate: "30", teamPerformance: "99999" },
      ];
      const defs = (conditions) => [{
        rewardId: "lv", type: "LEVEL", accumulateInChain: true, ...(conditions ? { conditions } : {}),
      }];
      const run = (conditions) => Engine.Distribute.distributeByDefs({ event, ancestors, rewardDefs: defs(conditions) });
      // 无条件：15% + (30%-15%) = 150 + 150
      expect(run().map((r) => [r.nodeId, r.amount, r.snapshot.depth])).toEqual([["a1", "150", 1], ["a2", "150", 2]]);
      // a1 被条件挡掉：水位仍为 0，a2 拿满 30% = 300，且 depth 仍为 2（层号不前移）
      const filtered = run([{ field: "teamPerformance", operator: "GTE", value: "1000", source: "target" }]);
      expect(filtered.map((r) => [r.nodeId, r.amount, r.snapshot.depth])).toEqual([["a2", "300", 2]]);
      expect(filtered[0].previousRate).toBe("0");
    });

    test("LEVEL levelRates：被节点侧条件挡掉的层不发放，其余层比例不前移", () => {
      const records = Engine.Distribute.distributeByDefs({
        event,
        ancestors: [{ id: "a1", vip: 0 }, { id: "a2", vip: 1 }, { id: "a3", vip: 1 }],
        rewardDefs: [{
          rewardId: "lr", type: "LEVEL", levelRates: ["10", "5", "3"],
          conditions: [{ field: "vip", operator: "EQ", value: 1, source: "target" }],
        }],
      });
      // a1 被挡 → a2 仍按第 2 层的 5%、a3 仍按第 3 层的 3%
      expect(records.map((r) => [r.nodeId, r.amount, r.snapshot.depth])).toEqual([["a2", "50", 2], ["a3", "30", 3]]);
    });

    test("未知 source 抛错（拼写错误绝不静默按默认数据源求值）", () => {
      expect(() => Engine.Distribute.distributeByDefs({
        event,
        directParent: { id: "p1", rankRate: "10" },
        rewardDefs: [{
          rewardId: "bad", type: "DIRECT", target: "PARENT", rate: "10",
          conditions: [{ field: "x", operator: "GTE", value: 1, source: "node" }],
        }],
      })).toThrow(/条件未知 source/);
    });

    test("声明 source:\"event\" 但求值上下文缺事件 → evaluateCondition 抛错", () => {
      expect(() => Engine.Evaluate.evaluateCondition(
        { type: "COMPARE", field: "orderAmount", operator: "GTE", value: 1, source: "event" },
        { orderAmount: "5000" }
      )).toThrow(/未提供该数据源/);
    });
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

  test("applyCaps — ALERT_ONLY 超限不裁剪，保留原金额带告警标记", () => {
    const records = [{ nodeId: "u1", amount: "200" }];
    const state = { platformPaid: "190", memberPaid: new Map() };
    // REJECT 语义会裁剪到 10；ALERT_ONLY 应保留 200 并标记 alertOnly
    const capped = Engine.Allocate.applyCaps(records, [
      { capId: "p1", scope: "PLATFORM_DAILY", limit: "200", onExceed: "ALERT_ONLY" },
    ], state);
    expect(capped.length).toBe(1);
    expect(Decimal.eq(capped[0].amount, "200")).toBe(true); // 保留原金额
    expect(capped[0].snapshot.payoutCaps.alertOnly).toBe(true);
    expect(capped[0].snapshot.payoutCaps.onExceed).toBe("ALERT_ONLY");
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

  // ==================== 多周期封顶（v4.0.0 §14：WEEKLY / MONTHLY / TOTAL）====================
  // 引擎不认识日期：周期边界由宿主的水位行生命周期决定，引擎只负责分桶记账 + 逐维取最严裁剪。

  test("applyCaps — CAP_SCOPES 为 8 个合法 scope（平台各周期 → 单用户各周期）", () => {
    expect(Engine.Allocate.CAP_SCOPES).toEqual([
      "PLATFORM_DAILY", "PLATFORM_WEEKLY", "PLATFORM_MONTHLY", "PLATFORM_TOTAL",
      "PER_USER_DAILY", "PER_USER_WEEKLY", "PER_USER_MONTHLY", "PER_USER_TOTAL",
    ]);
  });

  test("applyCaps — PLATFORM_MONTHLY 裁剪，水位落在 state.periods.MONTHLY（DAILY 桶不重复存）", () => {
    const state = { platformPaid: "0", memberPaid: new Map() };
    const capped = Engine.Allocate.applyCaps(
      [{ nodeId: "u1", amount: "60" }, { nodeId: "u2", amount: "60" }],
      [{ capId: "m", scope: "PLATFORM_MONTHLY", limit: "100" }],
      state
    );
    expect(capped.length).toBe(2);
    expect(Decimal.eq(capped[0].amount, "60")).toBe(true);
    expect(Decimal.eq(capped[1].amount, "40")).toBe(true); // 裁剪到月剩余额度
    expect(capped[1].snapshot.payoutCaps.boundBy).toBe("PLATFORM_MONTHLY");
    expect(capped[1].snapshot.payoutCaps.limits).toEqual({ PLATFORM_MONTHLY: "100" });
    // MONTHLY 桶按需创建并推进
    expect(Decimal.eq(state.periods.MONTHLY.platformPaid, "100")).toBe(true);
    // DAILY 仍复用顶层字段，且不在 periods 里重复存放（同一个数存两处会静默半失效）
    expect(Decimal.eq(state.platformPaid, "100")).toBe(true);
    expect(state.periods.DAILY).toBeUndefined();
  });

  test("applyCaps — 多周期并存取最严的一维，boundBy 标记实际裁剪它的 scope", () => {
    const state = { platformPaid: "0", memberPaid: new Map() };
    const capped = Engine.Allocate.applyCaps(
      [{ nodeId: "u1", amount: "500" }],
      [
        { capId: "d", scope: "PLATFORM_DAILY", limit: "1000" },
        { capId: "m", scope: "PLATFORM_MONTHLY", limit: "50" },
        { capId: "t", scope: "PER_USER_TOTAL", limit: "800" },
      ],
      state
    );
    expect(Decimal.eq(capped[0].amount, "50")).toBe(true);
    expect(capped[0].snapshot.payoutCaps.boundBy).toBe("PLATFORM_MONTHLY");
    // 各周期水位都按实际发放额推进（不因它不是最严维度就漏记）
    expect(Decimal.eq(state.platformPaid, "50")).toBe(true);
    expect(Decimal.eq(state.periods.MONTHLY.platformPaid, "50")).toBe(true);
    expect(Decimal.eq(state.periods.TOTAL.memberPaid.get("u1"), "50")).toBe(true);
  });

  test("applyCaps — PER_USER_TOTAL（活动总量）跨调用累计：复用同一 state 连续三次", () => {
    const state = { platformPaid: "0", memberPaid: new Map() };
    const caps = [{ capId: "camp", scope: "PER_USER_TOTAL", limit: "100" }];
    const r1 = Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "60" }], caps, state);
    const r2 = Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "60" }], caps, state);
    const r3 = Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "60" }], caps, state);
    expect(Decimal.eq(r1[0].amount, "60")).toBe(true);
    expect(Decimal.eq(r2[0].amount, "40")).toBe(true); // 裁到活动总量剩余
    expect(r3.length).toBe(0);                          // 额度用尽，不写 0 元流水
    expect(Decimal.eq(state.periods.TOTAL.memberPaid.get("u1"), "100")).toBe(true);
  });

  test("applyCaps — 只配日封顶时不创建 periods 桶（不给 saveCapState 塞它没准备存的桶）", () => {
    const state = { platformPaid: "0", memberPaid: new Map() };
    Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "10" }], [
      { capId: "d", scope: "PLATFORM_DAILY", limit: "1000" },
    ], state);
    expect(state.periods).toBeUndefined();
    expect(Decimal.eq(state.platformPaid, "10")).toBe(true);
  });

  test("applyCaps — 消费宿主回传的 periods 水位（跨结算周期封顶的生效前提）", () => {
    const state = {
      platformPaid: "0",
      memberPaid: new Map(),
      periods: { MONTHLY: { platformPaid: "0", memberPaid: new Map([["u1", "90"]]) } },
    };
    const capped = Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "50" }], [
      { capId: "m", scope: "PER_USER_MONTHLY", limit: "100" },
    ], state);
    expect(Decimal.eq(capped[0].amount, "10")).toBe(true); // 100 − 已发 90
    expect(Decimal.eq(state.periods.MONTHLY.memberPaid.get("u1"), "100")).toBe(true);
  });

  test("applyCaps — 同一非日 scope 多条取最严（limit 最小）", () => {
    const state = { platformPaid: "0", memberPaid: new Map() };
    const capped = Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "500" }], [
      { capId: "m1", scope: "PLATFORM_MONTHLY", limit: "400" },
      { capId: "m2", scope: "PLATFORM_MONTHLY", limit: "120" },
    ], state);
    expect(Decimal.eq(capped[0].amount, "120")).toBe(true);
    expect(capped[0].snapshot.payoutCaps.limits.PLATFORM_MONTHLY).toBe("120");
  });

  test("applyCaps — 非日周期 ALERT_ONLY 只标记不裁剪，alertOnlyScopes 指明维度", () => {
    const state = {
      platformPaid: "0",
      memberPaid: new Map(),
      periods: { WEEKLY: { platformPaid: "95", memberPaid: new Map() } },
    };
    const capped = Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "50" }], [
      { capId: "w", scope: "PLATFORM_WEEKLY", limit: "100", onExceed: "ALERT_ONLY" },
    ], state);
    expect(Decimal.eq(capped[0].amount, "50")).toBe(true); // 不裁剪
    expect(capped[0].snapshot.payoutCaps.alertOnly).toBe(true);
    expect(capped[0].snapshot.payoutCaps.alertOnlyScopes).toEqual(["PLATFORM_WEEKLY"]);
    expect(capped[0].snapshot.payoutCaps.boundBy).toBeUndefined();
    expect(Decimal.eq(state.periods.WEEKLY.platformPaid, "145")).toBe(true); // 水位按实发推进
  });

  test("applyCaps — 未知 scope 抛错并列出 8 个合法值（配错 scope 不得静默放行）", () => {
    expect(() => Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "10" }], [
      { capId: "x", scope: "PLATFORM_YEARLY", limit: "100" },
    ])).toThrow(/未知封顶 scope "PLATFORM_YEARLY"/);
    expect(() => Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "10" }], [
      { capId: "x", scope: "CAMPAIGN_TOTAL", limit: "100" },
    ])).toThrow(/PER_USER_TOTAL/); // 错误信息含全部 8 个合法值，指向 PER_USER_TOTAL 表达活动总量
  });

  test("applyCaps — 配了 PER_USER 封顶但水位缺 memberPaid Map 时抛错（不按 0 起算）", () => {
    expect(() => Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "10" }], [
      { capId: "u", scope: "PER_USER_DAILY", limit: "100" },
    ], { platformPaid: "0" })).toThrow(/缺少可用的 memberPaid Map/);
    // 普通对象（loadCapState 忘了 new Map）同样抛错，而不是 .get 取不到值后按 0 开闸
    expect(() => Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "10" }], [
      { capId: "u", scope: "PER_USER_MONTHLY", limit: "100" },
    ], { platformPaid: "0", memberPaid: new Map(), periods: { MONTHLY: { platformPaid: "0", memberPaid: { u1: "99" } } } }))
      .toThrow(/缺少可用的 memberPaid Map/);
  });

  test("applyCaps — legacy 快照字段保持不变（老宿主对账口径不破）", () => {
    const capped = Engine.Allocate.applyCaps([{ nodeId: "u1", amount: "10" }], [], undefined);
    expect(capped[0].snapshot.payoutCaps).toEqual({
      dailyPlatformPayoutCap: "0",
      memberDailyYieldCap: "0",
      originalAmount: "10",
      cappedAmount: "10",
    });
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

  test("applyBudgetGuard — CAP 缩减后求和精确等于预算上限（最大剩余法防累积超发）", () => {
    // 3 条 100/100/100，预算 200（totalBudget=40%，eventValue=500）
    // 朴素四舍五入：66.67×3=200.01 超发 0.01；最大剩余法应精确 = 200
    const records = [{ nodeId: "a", amount: "100" }, { nodeId: "b", amount: "100" }, { nodeId: "c", amount: "100" }];
    const result = Engine.Allocate.applyBudgetGuard(records, {
      totalBudget: "40", eventValue: "500", onExceed: "CAP",
    });
    const sum = result.reduce((s, r) => Decimal.add(s, r.amount), "0");
    expect(Decimal.eq(sum, "200")).toBe(true); // 精确等于预算上限，无累积超发
    // 每条金额在 4 位小数内
    for (const r of result) {
      expect(Decimal.lte(r.amount, "66.6667")).toBe(true);
      expect(Decimal.gte(r.amount, "66.6666")).toBe(true);
    }
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

  test("splitByTargets — 最后一项补差保证各分项之和精确等于总额", () => {
    // 非整除金额：33% × 1000.05 有 4 位小数尾差，最后一项补差保证总和 == 总额。
    // （P0-3 后 ratio 之和必须为 100，故用 33/67 表达，弃用旧的 33/33/33=99 错误配置）
    const { splits, snapshot } = Engine.Allocate.splitByTargets("1000.05", [
      { target: "A", ratio: 33 },
      { target: "B", ratio: 67 },
    ]);
    // 资金不变量：各分项之和精确等于原金额
    const sum = splits.reduce((s, sp) => Decimal.add(s, sp.amount), "0");
    expect(Decimal.eq(sum, "1000.05")).toBe(true);
    expect(Decimal.eq(splits[1].amount, Decimal.sub("1000.05", splits[0].amount))).toBe(true);
    expect(snapshot).toEqual({ A: 33, B: 67 });
  });

  test("splitByTargets — ratio 之和不为 100 抛错（P0-3 资金安全）", () => {
    // 三种错误比例均应在拆分前被拒绝，而不是静默错分（B 声明 20% 实得 70%）
    expect(() => Engine.Allocate.splitByTargets("1000", [{ target: "A", ratio: 70 }])).toThrow(/必须为 100/);
    expect(() => Engine.Allocate.splitByTargets("1000", [
      { target: "A", ratio: 30 },
      { target: "B", ratio: 20 },
    ])).toThrow(/必须为 100/);
    expect(() => Engine.Allocate.splitByTargets("1000", [
      { target: "A", ratio: 60 },
      { target: "B", ratio: 60 },
    ])).toThrow(/必须为 100/);
    // 空 targets 也拒绝
    expect(() => Engine.Allocate.splitByTargets("1000", [])).toThrow(/不能为空/);
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

  test("evaluateTier — P0-2 fail-closed：levelIndex>0 且无任何条件来源返回 false", () => {
    // 等级既无 conditions 也无 metadata/遗留 min_* 门槛 → 必须判定不满足（fail-closed），
    // 而不是「全部门槛取 0 逐项跳过 → return true」导致全员顶格高等级。
    const noGateTier = { rankId: "V9", levelIndex: 9, rankRate: "60" };
    expect(Engine.Evaluate.evaluateTier({ directCount: 0, teamPerformance: "0" }, noGateTier)).toBe(false);
    // 零活跃节点也不应命中无门槛的高等级
    expect(Engine.Evaluate.evaluateTier({ directCount: 999, teamPerformance: "999999" }, noGateTier)).toBe(false);

    // 对照：带 conditions 的等级正常评估
    const withCondTier = { rankId: "V1", levelIndex: 1, conditions: [{ field: "directCount", operator: "GTE", value: 5 }] };
    expect(Engine.Evaluate.evaluateTier({ directCount: 10 }, withCondTier)).toBe(true);
    expect(Engine.Evaluate.evaluateTier({ directCount: 2 }, withCondTier)).toBe(false);

    // 对照：遗留字段模式（metadata.minDirectCount）仍正常
    const legacyTier = { rankId: "V2", levelIndex: 2, metadata: { minDirectCount: 3 } };
    expect(Engine.Evaluate.evaluateTier({ directCount: 5 }, legacyTier)).toBe(true);
    expect(Engine.Evaluate.evaluateTier({ directCount: 1 }, legacyTier)).toBe(false);
  });

  test("getHighestQualifiedTier — P0-2 fail-closed：无门槛高等级不再顶格命中", () => {
    // 修复前：V9 无 conditions → 零活跃节点直接命中 V9（顶格 60%）。
    // 修复后：V9 无任何条件来源 → 不满足，回落到 V0。
    const result = Engine.Evaluate.getHighestQualifiedTier(
      { id: "x", directCount: 0, teamPerformance: "0" },
      [
        { rankId: "V0", levelIndex: 0, rankRate: "0" },
        { rankId: "V9", levelIndex: 9, rankRate: "60" },
      ]
    );
    expect(result.rankId).toBe("V0");
    expect(result.rankRate).toBe("0");
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

  // --- 4.0.0 新增：条件的 source 数据源 ---

  test("evaluateTier — rankDefs 显式 source:\"target\" 等价于对被评估节点求值", () => {
    const tier = { rankId: "V1", levelIndex: 1, conditions: [{ field: "directCount", operator: "GTE", value: 5, source: "target" }] };
    expect(Engine.Evaluate.evaluateTier({ directCount: 5 }, tier)).toBe(true);
    expect(Engine.Evaluate.evaluateTier({ directCount: 4 }, tier)).toBe(false);
  });

  test("evaluateTier — rankDefs 声明 source:\"event\" 抛错（等级门槛不该依赖某次事件）", () => {
    const tier = { rankId: "V1", levelIndex: 1, conditions: [{ field: "orderAmount", operator: "GTE", value: 1, source: "event" }] };
    expect(() => Engine.Evaluate.evaluateTier({ directCount: 9 }, tier)).toThrow(/未提供该数据源/);
  });

  test("evaluateCondition — 未知 source 抛错；未声明 source 仍对第 2 参求值（向后兼容）", () => {
    expect(() => Engine.Evaluate.evaluateCondition(
      { type: "COMPARE", field: "a", operator: "GTE", value: 1, source: "unknown" },
      { a: 5 }
    )).toThrow(/条件未知 source/);
    expect(Engine.Evaluate.evaluateCondition({ type: "COMPARE", field: "a", operator: "GTE", value: 1 }, { a: 5 })).toBe(true);
  });

  test("evaluateCondition — 复合条件的 children 省略 type 时按 COMPARE 求值（不静默 false）", () => {
    expect(Engine.Evaluate.evaluateCondition(
      { type: "AND", children: [{ field: "a", operator: "GTE", value: 1 }, { field: "b", operator: "EQ", value: "x" }] },
      { a: 5, b: "x" }
    )).toBe(true);
    expect(Engine.Evaluate.evaluateCondition(
      { type: "AND", children: [{ field: "a", operator: "GTE", value: 10 }] },
      { a: 5 }
    )).toBe(false);
    // 既无 type 也无 field 的垃圾对象仍判不满足（不放行）
    expect(Engine.Evaluate.evaluateCondition({}, { a: 5 })).toBe(false);
  });

  test("evaluateCondition — 同一棵树可混用 event / target 两个数据源", () => {
    const tree = { type: "AND", children: [
      { field: "orderAmount", operator: "GTE", value: 1000, source: "event" },
      { field: "rankRate", operator: "GTE", value: 15, source: "target" },
    ] };
    const context = { event: { attrs: { orderAmount: "2000" } }, target: { rankRate: "15" } };
    expect(Engine.Evaluate.evaluateCondition(tree, null, context)).toBe(true);
    expect(Engine.Evaluate.evaluateCondition(tree, null, { ...context, target: { rankRate: "10" } })).toBe(false);
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

  test("executePipeline — SPLIT 后跟其他阶段报错（防输入格式不兼容崩溃）", () => {
    // SPLIT 输出 { splits, snapshot } 非记录数组，与 CAP 等后续阶段不兼容。
    // schema 允许任意阶段组合，引擎必须在 SPLIT 后跟阶段时提前报错而非静默崩溃。
    expect(() => Engine.Orchestrate.executePipeline({
      stages: [
        { id: "distribute", handler: "DISTRIBUTE", config: {
          event: { sourceNodeId: "u1", eventValue: "1000" },
          directParent: { id: "u0", rankRate: "10" },
          ancestors: [],
          rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "10" }],
        } },
        { id: "split", handler: "SPLIT", config: { totalAmount: "100", targets: [{ target: "A", ratio: "70" }] } },
        { id: "cap", handler: "CAP", config: { capDefs: [{ capId: "day", scope: "PER_USER_DAILY", limit: "50" }] } },
      ],
    })).toThrow("SPLIT 必须是最后一个阶段");
  });

  // ---------- RANK 等级评估阶段 ----------

  const rankDefs = [
    { rankId: "V0", levelIndex: 0, rankRate: "0", conditions: [] },
    { rankId: "V1", levelIndex: 1, rankRate: "15", conditions: [{ field: "directCount", operator: "GTE", value: 3 }] },
    { rankId: "V3", levelIndex: 3, rankRate: "30", conditions: [{ field: "directCount", operator: "GTE", value: 10 }] },
  ];

  test("executePipeline — RANK 命中最高等级并写入节点 rankRate（内部自动升序排序）", () => {
    // rankDefs 传入无序（V0,V3,V1）：RANK handler 应按 levelIndex 升序后评估。
    const directParent = { id: "u0", directCount: 5 };
    const weakAncestor = { id: "u1", directCount: 1 };
    Engine.Orchestrate.executePipeline({
      stages: [
        { id: "rank", handler: "RANK", config: { nodes: [directParent, weakAncestor], rankDefs } },
      ],
    });
    // directCount=5 → 满足 V1(≥3)、不满足 V3(≥10) → rankRate 15 / rankId V1
    expect(directParent.rankRate).toBe("15");
    expect(directParent.rankId).toBe("V1");
    // directCount=1 → 未满足 V1 门槛 → 落到 V0 rankRate 0
    expect(weakAncestor.rankRate).toBe("0");
  });

  test("executePipeline — RANK 默认不覆盖宿主已预计算的 rankRate", () => {
    const node = { id: "u0", directCount: 99, rankRate: "50" };
    Engine.Orchestrate.executePipeline({
      stages: [{ handler: "RANK", config: { nodes: [node], rankDefs } }],
    });
    expect(node.rankRate).toBe("50"); // 保持宿主预计算值
  });

  test("executePipeline — RANK overwrite=true 覆盖宿主 rankRate", () => {
    const node = { id: "u0", directCount: 99, rankRate: "50" };
    Engine.Orchestrate.executePipeline({
      stages: [{ handler: "RANK", config: { nodes: [node], rankDefs, overwrite: true } }],
    });
    // directCount=99 → 满足 V3(≥10) → rankRate 30
    expect(node.rankRate).toBe("30");
  });

  test("executePipeline — RANK → DISTRIBUTE 集成：LEVEL 链式消费动态 rankRate", () => {
    const a1 = { id: "a1", directCount: 5 }; // → V1 15%
    const a2 = { id: "a2", directCount: 20 }; // → V3 30%
    const ancestors = [a1, a2];
    const { final } = Engine.Orchestrate.executePipeline({
      stages: [
        { handler: "RANK", config: { nodes: ancestors, rankDefs } },
        {
          handler: "DISTRIBUTE",
          config: {
            event: { sourceNodeId: "buyer", eventValue: "1000" },
            ancestors,
            rewardDefs: [{ rewardId: "team", type: "LEVEL", accumulateInChain: true }],
          },
        },
      ],
    });
    // 链式差额：a1 1000×15%=150，水位 15%；a2 1000×(30-15)%=150
    expect(final.length).toBe(2);
    expect(Decimal.eq(final[0].amount, "150")).toBe(true);
    expect(Decimal.eq(final[1].amount, "150")).toBe(true);
  });

  // --- 4.0.0 fail-closed：多 DISTRIBUTE 合并语义必须显式声明 ---

  const twoDistributeStages = (mergeConfig) => [
    {
      id: "d1",
      handler: "DISTRIBUTE",
      config: {
        event: { sourceNodeId: "u1", eventValue: "1000" },
        directParent: { id: "p1", rankRate: "10" },
        rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "5" }],
      },
    },
    {
      id: "d2",
      handler: "DISTRIBUTE",
      config: {
        event: { sourceNodeId: "u1", eventValue: "1000" },
        directParent: { id: "p1", rankRate: "10" },
        rewardDefs: [{ rewardId: "r2", type: "DIRECT", target: "PARENT", rate: "3" }],
        ...mergeConfig,
      },
    },
  ];

  test("executePipeline — 第 2 个 DISTRIBUTE 未声明 merge 时抛错（防静默覆盖前序记录）", () => {
    expect(() =>
      Engine.Orchestrate.executePipeline({ stages: twoDistributeStages(undefined) })
    ).toThrow(/必须显式声明 config\.merge/);
  });

  test("executePipeline — merge:\"append\" 累加前后两个 DISTRIBUTE 的记录", () => {
    const { final } = Engine.Orchestrate.executePipeline({
      stages: twoDistributeStages({ merge: "append" }),
    });
    expect(final.map((r) => r.rewardId)).toEqual(["r1", "r2"]);
    expect(Decimal.eq(final[0].amount, "50")).toBe(true);
    expect(Decimal.eq(final[1].amount, "30")).toBe(true);
  });

  test("executePipeline — merge:\"replace\" 仅保留后一个 DISTRIBUTE 的记录", () => {
    const { final } = Engine.Orchestrate.executePipeline({
      stages: twoDistributeStages({ merge: "replace" }),
    });
    expect(final.map((r) => r.rewardId)).toEqual(["r2"]);
  });

  test("executePipeline — RANK 排在 DISTRIBUTE 之后时抛错（防记录被静默清空）", () => {
    expect(() =>
      Engine.Orchestrate.executePipeline({
        stages: [
          {
            id: "d",
            handler: "DISTRIBUTE",
            config: {
              event: { sourceNodeId: "u1", eventValue: "1000" },
              directParent: { id: "p1", rankRate: "10" },
              rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "5" }],
            },
          },
          { id: "rk", handler: "RANK", config: { nodes: [{ id: "p1" }], rankDefs: [] } },
        ],
      })
    ).toThrow(/RANK 必须排在 DISTRIBUTE 之前/);
  });

  test("executePipeline — RANK 在 DISTRIBUTE 之前（且前序无记录）仍正常工作", () => {
    const parent = { id: "p1", directCount: 5 };
    const { final } = Engine.Orchestrate.executePipeline({
      stages: [
        {
          id: "rk",
          handler: "RANK",
          config: {
            nodes: [parent],
            rankDefs: [
              { rankId: "V0", levelIndex: 0, rankRate: "0" },
              {
                rankId: "V1",
                levelIndex: 1,
                rankRate: "10",
                conditions: [{ type: "COMPARE", field: "directCount", operator: "GTE", value: 3 }],
              },
            ],
          },
        },
        {
          id: "d",
          handler: "DISTRIBUTE",
          config: {
            event: { sourceNodeId: "u1", eventValue: "1000" },
            directParent: parent,
            rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "5" }],
          },
        },
      ],
    });
    expect(parent.rankRate).toBe("10");
    expect(final.length).toBe(1);
    expect(Decimal.eq(final[0].amount, "50")).toBe(true);
  });
});

// ====================== Reverse — 冲正（退款/撤单追回） ======================

describe("Reverse", () => {
  const origin = () => [
    { recordId: "rec1", nodeId: "u1", rewardId: "referral", rewardType: "DIRECT", amount: "100" },
    { recordId: "rec2", nodeId: "u2", rewardId: "team", rewardType: "LEVEL", amount: "33.3333" },
  ];

  test("reverseRecords — 全额冲正产出负金额，reversedAmount 为正绝对值", () => {
    const { records, summary } = Engine.Reverse.reverseRecords({
      originalRecords: origin(),
      ratio: "100",
    });
    expect(records.length).toBe(2);
    expect(records[0].amount).toBe("-100");
    expect(records[0].reversedAmount).toBe("100");
    expect(records[0].direction).toBe("REVERSAL");
    expect(records[0].originalRecordId).toBe("rec1");
    expect(records[0].nodeId).toBe("u1");
    expect(records[0].rewardId).toBe("referral");
    expect(records[0].rewardType).toBe("DIRECT");
    expect(summary.recordCount).toBe(2);
    expect(summary.basis).toBe("RATIO");
    expect(Decimal.eq(summary.totalReversed, "133.3333")).toBe(true);
  });

  test("reverseRecords — 负金额与 reversedAmount 相加为 0（净发放口径）", () => {
    const { records } = Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "100" });
    const net = records.reduce((acc, r) => Decimal.add(acc, Decimal.add(r.amount, r.reversedAmount)), "0");
    expect(Decimal.eq(net, "0")).toBe(true);
  });

  test("reverseRecords — 按 reversalValue/originalEventValue 推导比例（部分退款）", () => {
    const { records, summary } = Engine.Reverse.reverseRecords({
      originalRecords: origin(),
      reversalValue: "300",
      originalEventValue: "1000",
    });
    expect(summary.basis).toBe("EVENT_VALUE");
    expect(Decimal.eq(summary.ratio, "30")).toBe(true);
    expect(records[0].amount).toBe("-30");
    expect(records[0].snapshot.reversal.reversalValue).toBe("300");
    expect(records[0].snapshot.reversal.originalEventValue).toBe("1000");
  });

  test("reverseRecords — 金额按 4 位小数【截断】（宁可少追回，不可超额追回）", () => {
    const { records } = Engine.Reverse.reverseRecords({
      originalRecords: [{ recordId: "r", nodeId: "u", amount: "33.3333" }],
      ratio: "30",
    });
    // 33.3333 × 30% = 9.99999 → 截断为 9.9999（四舍五入会变成 10.0000，属超额追回）
    expect(records[0].reversedAmount).toBe("9.9999");
    expect(records[0].amount).toBe("-9.9999");
  });

  test("reverseRecords — reversedMap 扣减已冲正累计（多次部分退款不超额）", () => {
    const { records, summary } = Engine.Reverse.reverseRecords({
      originalRecords: [{ recordId: "rec1", nodeId: "u1", amount: "100" }],
      ratio: "50",
      reversedMap: new Map([["rec1", "60"]]),
    });
    // 想追 50，剩余仅 40 → CLAMP 到 40
    expect(records[0].reversedAmount).toBe("40");
    expect(records[0].snapshot.reversal.alreadyReversed).toBe("60");
    expect(records[0].snapshot.reversal.remainingBefore).toBe("40");
    expect(records[0].snapshot.reversal.clamped).toBe(true);
    expect(summary.clampedCount).toBe(1);
  });

  test("reverseRecords — reversedMap 支持普通对象", () => {
    const { records } = Engine.Reverse.reverseRecords({
      originalRecords: [{ recordId: "rec1", nodeId: "u1", amount: "100" }],
      ratio: "100",
      reversedMap: { rec1: "30" },
    });
    expect(records[0].reversedAmount).toBe("70");
  });

  test("reverseRecords — 已全额冲正不再产出第二条（计算侧幂等）", () => {
    const { records, summary } = Engine.Reverse.reverseRecords({
      originalRecords: [{ recordId: "rec1", nodeId: "u1", amount: "100" }],
      ratio: "100",
      reversedMap: new Map([["rec1", "100"]]),
    });
    expect(records.length).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(summary.totalReversed).toBe("0");
  });

  test("reverseRecords — onExceed:REJECT 超出剩余额度时抛错", () => {
    expect(() =>
      Engine.Reverse.reverseRecords({
        originalRecords: [{ recordId: "rec1", nodeId: "u1", amount: "100" }],
        ratio: "100",
        reversedMap: new Map([["rec1", "60"]]),
        onExceed: "REJECT",
      })
    ).toThrow(/超过剩余可冲正额度/);
  });

  test("reverseRecords — 未提供比例抛错（不默认全额冲正）", () => {
    expect(() => Engine.Reverse.reverseRecords({ originalRecords: origin() })).toThrow(/必须提供冲正比例/);
  });

  test("reverseRecords — ratio 与 reversalValue 互斥", () => {
    expect(() =>
      Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "50", reversalValue: "300", originalEventValue: "1000" })
    ).toThrow(/互斥/);
  });

  test("reverseRecords — ratio 越界抛错", () => {
    expect(() => Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "0" })).toThrow();
    expect(() => Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "101" })).toThrow();
    expect(() => Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "-10" })).toThrow();
  });

  test("reverseRecords — reversalValue 大于原始事件金额抛错", () => {
    expect(() =>
      Engine.Reverse.reverseRecords({ originalRecords: origin(), reversalValue: "1200", originalEventValue: "1000" })
    ).toThrow();
  });

  test("reverseRecords — originalRecords 非数组抛错（静默返回空 = 所有退款都不追回）", () => {
    expect(() => Engine.Reverse.reverseRecords({ originalRecords: null, ratio: "100" })).toThrow();
    expect(() => Engine.Reverse.reverseRecords({ ratio: "100" })).toThrow();
  });

  test("reverseRecords — 缺 recordId / nodeId 抛错", () => {
    expect(() =>
      Engine.Reverse.reverseRecords({ originalRecords: [{ nodeId: "u1", amount: "100" }], ratio: "100" })
    ).toThrow(/recordId/);
    expect(() =>
      Engine.Reverse.reverseRecords({ originalRecords: [{ recordId: "r", amount: "100" }], ratio: "100" })
    ).toThrow(/nodeId/);
  });

  test("reverseRecords — 冲正记录不可再冲正（会产出正金额=凭空发钱）", () => {
    expect(() =>
      Engine.Reverse.reverseRecords({
        originalRecords: [{ recordId: "r", nodeId: "u", amount: "-30", direction: "REVERSAL" }],
        ratio: "100",
      })
    ).toThrow(/REVERSAL/);
  });

  test("reverseRecords — 原始金额为负抛错", () => {
    expect(() =>
      Engine.Reverse.reverseRecords({ originalRecords: [{ recordId: "r", nodeId: "u", amount: "-1" }], ratio: "100" })
    ).toThrow();
  });

  test("reverseRecords — 原始金额为 0 跳过（不产出 -0 记录）", () => {
    const { records, summary } = Engine.Reverse.reverseRecords({
      originalRecords: [{ recordId: "r", nodeId: "u", amount: "0" }],
      ratio: "100",
    });
    expect(records.length).toBe(0);
    expect(summary.skippedCount).toBe(1);
  });

  test("reverseRecords — 未知 onExceed 抛错", () => {
    expect(() =>
      Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "100", onExceed: "IGNORE" })
    ).toThrow(/onExceed/);
  });

  test("reverseRecords — id / memberId 别名与 reasonCode 落入 snapshot", () => {
    const { records } = Engine.Reverse.reverseRecords({
      originalRecords: [{ id: 7, memberId: "u9", amount: "10" }],
      ratio: "100",
      reasonCode: "REFUND_FULL",
    });
    expect(records[0].nodeId).toBe("u9");
    expect(records[0].originalRecordId).toBe(7);
    expect(records[0].snapshot.reversal.reasonCode).toBe("REFUND_FULL");
  });

  test("applyCaps — 拒绝冲正/负金额记录（负金额会反向推进水位并释放额度）", () => {
    const { records } = Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "100" });
    expect(() => Engine.Allocate.applyCaps(records, [{ scope: "PLATFORM_DAILY", limit: "1000" }])).toThrow(
      /不接受冲正\/负金额记录/
    );
    expect(() =>
      Engine.Allocate.applyCaps([{ nodeId: "u1", rewardId: "r", amount: "-1" }], [{ scope: "PLATFORM_DAILY", limit: "1000" }])
    ).toThrow(/不接受冲正\/负金额记录/);
  });

  test("applyBudgetGuard — 拒绝冲正/负金额记录", () => {
    const { records } = Engine.Reverse.reverseRecords({ originalRecords: origin(), ratio: "100" });
    expect(() =>
      Engine.Allocate.applyBudgetGuard(records, { totalBudget: "10", eventValue: "1000" })
    ).toThrow(/不接受冲正\/负金额记录/);
  });

  test("executePipeline — REVERSE 阶段产出冲正记录并写入 context.reversalSummary", () => {
    const { final, context } = Engine.Orchestrate.executePipeline({
      stages: [
        {
          id: "rev",
          handler: "REVERSE",
          config: { originalRecords: origin(), reversalValue: "300", originalEventValue: "1000" },
        },
      ],
    });
    expect(final.length).toBe(2);
    expect(final[0].amount).toBe("-30");
    expect(context.reversalSummary.basis).toBe("EVENT_VALUE");
    expect(Decimal.eq(context.reversalSummary.ratio, "30")).toBe(true);
  });

  test("executePipeline — REVERSE 与 DISTRIBUTE 不能同现（两个方向）", () => {
    const distStage = {
      handler: "DISTRIBUTE",
      config: {
        event: { sourceNodeId: "u1", eventValue: "1000" },
        directParent: { id: "u0", rankRate: "10" },
        rewardDefs: [{ rewardId: "r", type: "DIRECT", target: "PARENT", rate: "5" }],
      },
    };
    const revStage = { handler: "REVERSE", config: { originalRecords: origin(), ratio: "100" } };
    expect(() => Engine.Orchestrate.executePipeline({ stages: [distStage, revStage] })).toThrow();
    expect(() => Engine.Orchestrate.executePipeline({ stages: [revStage, distStage] })).toThrow();
  });

  test("executePipeline — 一条流水线最多一个 REVERSE", () => {
    const revStage = () => ({ handler: "REVERSE", config: { originalRecords: origin(), ratio: "100" } });
    expect(() => Engine.Orchestrate.executePipeline({ stages: [revStage(), revStage()] })).toThrow(/REVERSE/);
  });

  test("ruleSetConfigSchema — 拒绝规则集里声明 REVERSE 阶段（需运行期原始记录）", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r", type: "DIRECT", target: "PARENT", rate: "5" }],
      rankDefs: [{ rankId: "V0", levelIndex: 0, rankRate: "0" }],
      capDefs: [],
      pipelineDef: { stages: [{ handler: "REVERSE" }] },
    });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/REVERSE（冲正）不能在规则集里声明/);
  });
});

// ====================== Campaign（活动期加成 + 生效期）======================

describe("Campaign", () => {
  const IN = "2026-11-11T10:00:00+08:00";
  const dbl11 = (o = {}) => ({
    campaignId: "dbl11",
    startAt: "2026-11-11T00:00:00+08:00",
    endAt: "2026-11-12T00:00:00+08:00",
    multiplier: "2",
    ...o,
  });
  const recs = () => [
    { rewardId: "referral", nodeId: "u1", amount: "33.3333", snapshot: { rate: "10" } },
    { rewardId: "team", nodeId: "u2", amount: "10" },
  ];

  test("applyCampaign — 窗口内命中：金额乘系数并 ROUND_DOWN 截断，snapshot.campaign 完整", () => {
    const { records, summary } = Engine.Allocate.applyCampaign(recs(), [dbl11({ multiplier: "1.5" })], {
      occurredAt: IN,
    });
    // 33.3333 × 1.5 = 49.99995 → 截断（不是四舍五入的 50.0000）
    expect(records[0].amount).toBe("49.9999");
    expect(records[1].amount).toBe("15");
    expect(records[0].snapshot.rate).toBe("10"); // 原 snapshot 字段保留
    expect(records[0].snapshot.campaign).toMatchObject({
      campaignId: "dbl11",
      multiplier: "1.5",
      originalAmount: "33.3333",
      boostedAmount: "49.9999",
    });
    expect(records[0].snapshot.campaign.window).toEqual({
      startAt: "2026-11-11T00:00:00+08:00",
      endAt: "2026-11-12T00:00:00+08:00",
    });
    expect(summary.boostedCount).toBe(2);
    expect(summary.activeCampaignIds).toEqual(["dbl11"]);
    expect(summary.totalBefore).toBe("43.3333");
    expect(summary.totalAfter).toBe("64.9999");
    expect(summary.byCampaign.dbl11).toEqual({ count: 2, totalBefore: "43.3333", totalAfter: "64.9999" });
  });

  test("applyCampaign — 不修改入参记录（返回新对象）", () => {
    const input = recs();
    const { records } = Engine.Allocate.applyCampaign(input, [dbl11()], { occurredAt: IN });
    expect(input[0].amount).toBe("33.3333");
    expect(input[0].snapshot.campaign).toBeUndefined();
    expect(records[0]).not.toBe(input[0]);
  });

  test("applyCampaign — 窗口外：记录原样透传（同一对象引用），不加成", () => {
    const input = recs();
    const { records, summary } = Engine.Allocate.applyCampaign(input, [dbl11()], {
      occurredAt: "2026-11-13T10:00:00+08:00",
    });
    expect(records[0]).toBe(input[0]);
    expect(summary.boostedCount).toBe(0);
    expect(summary.untouchedCount).toBe(2);
    expect(summary.totalAfter).toBe(summary.totalBefore);
  });

  test("applyCampaign — 窗口左闭右开：startAt 命中、endAt 不命中", () => {
    const at = (t) => Engine.Allocate.applyCampaign(recs(), [dbl11()], { occurredAt: t }).summary.boostedCount;
    expect(at("2026-11-11T00:00:00+08:00")).toBe(2);
    expect(at("2026-11-12T00:00:00+08:00")).toBe(0);
    expect(at("2026-11-11T23:59:59+08:00")).toBe(2);
  });

  test("applyCampaign — 空 campaignDefs：原样返回且无需 occurredAt（活动结束后保留阶段是正常运维状态）", () => {
    const input = recs();
    const { records, summary } = Engine.Allocate.applyCampaign(input, []);
    expect(records).toEqual(input);
    expect(summary.boostedCount).toBe(0);
    expect(summary.occurredAt).toBeNull();
  });

  test("applyCampaign — campaignDefs 非空但缺 occurredAt：抛错（绝不用当前时间兜底）", () => {
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11()], {})).toThrow(/occurredAt.*缺失/s);
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11()])).toThrow(/occurredAt.*缺失/s);
  });

  test("applyCampaign — 漏传 campaignDefs 抛错（静默失效会让活动不加成）", () => {
    expect(() => Engine.Allocate.applyCampaign(recs(), undefined, { occurredAt: IN })).toThrow(
      /campaignDefs 必须是数组/
    );
  });

  test("applyCampaign — 时刻不带时区偏移 / 纯日期 / 数字时间戳一律抛错", () => {
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11()], { occurredAt: "2026-11-11T10:00:00" })).toThrow(
      /带偏移量的 ISO-8601/
    );
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11()], { occurredAt: "2026-11-11" })).toThrow(
      /带偏移量的 ISO-8601/
    );
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11()], { occurredAt: 1794326400000 })).toThrow(
      /不接受数字时间戳/
    );
    expect(() =>
      Engine.Allocate.applyCampaign(recs(), [dbl11({ startAt: "2026-11-11 00:00:00" })], { occurredAt: IN })
    ).toThrow(/带偏移量的 ISO-8601/);
  });

  test("applyCampaign — Date 实例可用（等价于带偏移量字符串）", () => {
    const { summary } = Engine.Allocate.applyCampaign(recs(), [dbl11()], {
      occurredAt: new Date("2026-11-11T02:00:00Z"), // = 2026-11-11T10:00+08:00
    });
    expect(summary.boostedCount).toBe(2);
  });

  test("applyCampaign — multiplier 写成百分比（100）抛错：它是倍数不是百分比", () => {
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11({ multiplier: "100" })], { occurredAt: IN })).toThrow(
      /multiplier 必须是 0 < multiplier <= 10 的\*\*倍数\*\*/
    );
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11({ multiplier: "0" })], { occurredAt: IN })).toThrow(
      /multiplier/
    );
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11({ multiplier: "-1" })], { occurredAt: IN })).toThrow(
      /multiplier/
    );
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11({ multiplier: undefined })], { occurredAt: IN })).toThrow(
      /multiplier/
    );
  });

  test("applyCampaign — 活动定义即使当前不在窗口内也会被校验（不留到活动开始那一刻才抛错）", () => {
    expect(() =>
      Engine.Allocate.applyCampaign(recs(), [dbl11({ multiplier: "100" })], {
        occurredAt: "2026-12-01T10:00:00+08:00",
      })
    ).toThrow(/multiplier/);
  });

  test("applyCampaign — 缺 campaignId 抛错", () => {
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11({ campaignId: "" })], { occurredAt: IN })).toThrow(
      /缺少 campaignId/
    );
  });

  test("applyCampaign — 同一记录被多个活动同时命中：抛错（相乘 = 数倍超发）", () => {
    expect(() =>
      Engine.Allocate.applyCampaign(
        recs(),
        [dbl11(), dbl11({ campaignId: "week", startAt: "2026-11-10T00:00:00+08:00", endAt: "2026-11-20T00:00:00+08:00", multiplier: "1.5" })],
        { occurredAt: IN }
      )
    ).toThrow(/同时命中 2 个活动/);
  });

  test("applyCampaign — rewardIds 限定加成范围：只放大指定奖励，其余原样", () => {
    const { records, summary } = Engine.Allocate.applyCampaign(recs(), [dbl11({ rewardIds: ["referral"] })], {
      occurredAt: IN,
    });
    expect(records[0].amount).toBe("66.6666");
    expect(records[1].amount).toBe("10");
    expect(summary.boostedCount).toBe(1);
    expect(summary.untouchedCount).toBe(1);
    expect(records[0].snapshot.campaign.rewardIds).toEqual(["referral"]);
  });

  test("applyCampaign — 窗口重叠但 rewardIds 不相交：各自加成，不算冲突", () => {
    const { records } = Engine.Allocate.applyCampaign(
      recs(),
      [dbl11({ rewardIds: ["referral"] }), dbl11({ campaignId: "team-boost", rewardIds: ["team"], multiplier: "3" })],
      { occurredAt: IN }
    );
    expect(records[0].amount).toBe("66.6666");
    expect(records[1].amount).toBe("30");
  });

  test("applyCampaign — rewardIds 空数组抛错（语义与省略相反）", () => {
    expect(() => Engine.Allocate.applyCampaign(recs(), [dbl11({ rewardIds: [] })], { occurredAt: IN })).toThrow(
      /rewardIds 必须是非空数组/
    );
  });

  test("applyCampaign — 冲正记录 / 负金额抛错（加成会放大追回金额）", () => {
    expect(() =>
      Engine.Allocate.applyCampaign(
        [{ rewardId: "referral", nodeId: "u1", amount: "-100", direction: "REVERSAL" }],
        [dbl11()],
        { occurredAt: IN }
      )
    ).toThrow(/是冲正记录/);
    expect(() =>
      Engine.Allocate.applyCampaign([{ rewardId: "referral", nodeId: "u1", amount: "-1" }], [dbl11()], {
        occurredAt: IN,
      })
    ).toThrow(/金额为负/);
  });

  test("resolveActiveCampaigns — 命中判定与 rewardId 过滤", () => {
    const defs = [dbl11({ rewardIds: ["referral"] }), dbl11({ campaignId: "past", startAt: "2026-01-01T00:00:00+08:00", endAt: "2026-02-01T00:00:00+08:00" })];
    expect(Engine.Allocate.resolveActiveCampaigns(defs, IN).map((d) => d.campaignId)).toEqual(["dbl11"]);
    expect(Engine.Allocate.resolveActiveCampaigns(defs, IN, { rewardId: "team" })).toEqual([]);
    expect(Engine.Allocate.resolveActiveCampaigns(defs, IN, { rewardId: "referral" }).length).toBe(1);
    expect(Engine.Allocate.resolveActiveCampaigns([], IN)).toEqual([]);
    expect(() => Engine.Allocate.resolveActiveCampaigns(defs, "2026-11-11")).toThrow(/带偏移量的 ISO-8601/);
  });

  test("CAMPAIGN_MULTIPLIER_MAX — 常量对外暴露且与校验层同源", () => {
    expect(Engine.Allocate.CAMPAIGN_MULTIPLIER_MAX).toBe(10);
  });

  // ---------- 流水线顺序约束（资金安全）----------

  const pipeBase = {
    event: { sourceNodeId: "u1", eventValue: "1000" },
    directParent: { id: "u0", rankRate: "10" },
    rewardDefs: [{ rewardId: "referral", type: "DIRECT", target: "PARENT", rate: "10" }],
  };

  test("CAMPAIGN 阶段 — 排在 CAP 之前：加成后的金额仍受封顶约束", () => {
    const { final, context } = Engine.Orchestrate.executePipeline({
      stages: [
        { handler: "DISTRIBUTE", config: pipeBase },
        { handler: "CAMPAIGN", config: { campaignDefs: [dbl11()], occurredAt: IN } },
        { handler: "CAP", config: { capDefs: [{ capId: "c", scope: "PLATFORM_DAILY", limit: "150" }] } },
      ],
    });
    // 1000 × 10% = 100 → 活动翻倍 200 → 日封顶 150 裁剪
    expect(final.map((r) => r.amount)).toEqual(["150"]);
    expect(context.campaignSummary.byCampaign.dbl11).toEqual({ count: 1, totalBefore: "100", totalAfter: "200" });
    expect(final[0].snapshot.campaign.multiplier).toBe("2");
  });

  test("CAMPAIGN 阶段 — 排在 CAP/OVER 之后抛错（加成会绕过封顶）", () => {
    const campaignStage = { handler: "CAMPAIGN", config: { campaignDefs: [dbl11()], occurredAt: IN } };
    expect(() =>
      Engine.Orchestrate.executePipeline({
        stages: [{ handler: "DISTRIBUTE", config: pipeBase }, { handler: "CAP", config: { capDefs: [] } }, campaignStage],
      })
    ).toThrow(/排在 CAP\/OVER 之后/);
    expect(() =>
      Engine.Orchestrate.executePipeline({
        stages: [
          { handler: "DISTRIBUTE", config: pipeBase },
          { handler: "OVER", config: { totalBudget: "50", eventValue: "1000" } },
          campaignStage,
        ],
      })
    ).toThrow(/排在 CAP\/OVER 之后/);
  });

  test("CAMPAIGN 阶段 — 排在 DISTRIBUTE 之前抛错（无记录可加成，会静默失效）", () => {
    expect(() =>
      Engine.Orchestrate.executePipeline({
        stages: [{ handler: "CAMPAIGN", config: { campaignDefs: [dbl11()], occurredAt: IN } }],
      })
    ).toThrow(/之前无输入数据/);
  });

  test("CAMPAIGN 阶段 — 一条流水线最多一个（多个系数会相乘）", () => {
    const campaignStage = { handler: "CAMPAIGN", config: { campaignDefs: [dbl11()], occurredAt: IN } };
    expect(() =>
      Engine.Orchestrate.executePipeline({
        stages: [{ handler: "DISTRIBUTE", config: pipeBase }, campaignStage, { ...campaignStage, id: "c2" }],
      })
    ).toThrow(/第 2 个 CAMPAIGN/);
  });

  test("CAMPAIGN 阶段 — 接在 REVERSE 之后抛错（不能放大追回金额）", () => {
    expect(() =>
      Engine.Orchestrate.executePipeline({
        stages: [
          {
            handler: "REVERSE",
            config: { originalRecords: [{ recordId: "r1", nodeId: "u1", amount: "100" }], ratio: "100" },
          },
          { handler: "CAMPAIGN", config: { campaignDefs: [dbl11()], occurredAt: IN } },
        ],
      })
    ).toThrow(/是冲正记录/);
  });

  test("CAMPAIGN 阶段 — 未知 handler 错误信息包含 CAMPAIGN", () => {
    expect(() => Engine.Orchestrate.executePipeline({ stages: [{ handler: "BOOST" }] })).toThrow(
      /支持: DISTRIBUTE, RANK, CAMPAIGN, CAP, OVER, SPLIT, REVERSE/
    );
  });

  // ---------- 适配层装配 ----------

  test("buildPipelineStages — 有 campaignDefs 时缺省流水线自动插入 CAMPAIGN（DISTRIBUTE → CAMPAIGN → CAP）", () => {
    const stages = buildPipelineStages(
      { rewardDefs: pipeBase.rewardDefs, capDefs: [], campaignDefs: [dbl11()] },
      { event: pipeBase.event, directParent: pipeBase.directParent, occurredAt: IN }
    );
    expect(stages.map((s) => s.handler)).toEqual(["DISTRIBUTE", "CAMPAIGN", "CAP"]);
    expect(stages[1].config.campaignDefs[0].campaignId).toBe("dbl11");
    expect(stages[1].config.occurredAt).toBe(IN);
  });

  test("buildPipelineStages — 无 campaignDefs 时缺省流水线不变（向后兼容）", () => {
    const stages = buildPipelineStages({ rewardDefs: pipeBase.rewardDefs, capDefs: [] }, { event: pipeBase.event });
    expect(stages.map((s) => s.handler)).toEqual(["DISTRIBUTE", "CAP"]);
  });

  // ---------- 配置期校验 ----------

  const validBase = {
    rewardDefs: [{ rewardId: "referral", type: "DIRECT", target: "PARENT", rate: "10" }],
    rankDefs: [{ rankId: "r0", levelIndex: 0, rankRate: "0" }],
  };

  test("Validation — 合法 campaignDefs / effective 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      ...validBase,
      campaignDefs: [dbl11()],
      effective: { startAt: "2026-11-01T00:00:00+08:00", endAt: "2026-12-01T00:00:00+08:00" },
      pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAMPAIGN" }, { handler: "CAP" }] },
    });
    expect(error).toBeUndefined();
  });

  test("Validation — 时刻不带时区偏移在配置期即被拒（joi date 强转陷阱已规避）", () => {
    for (const bad of ["2026-11-11T00:00:00", "2026-11-11", 1794326400000]) {
      const { error } = ruleSetConfigSchema.validate({ ...validBase, campaignDefs: [dbl11({ startAt: bad })] });
      expect(error).toBeDefined();
      expect(error.details[0].path.join(".")).toBe("campaignDefs.0.startAt");
    }
    const { error } = ruleSetConfigSchema.validate({
      ...validBase,
      effective: { startAt: "2026-11-01", endAt: "2026-12-01T00:00:00+08:00" },
    });
    expect(error).toBeDefined();
  });

  test("Validation — multiplier 超上限 / 反向窗口 / campaignId 重复被拒", () => {
    expect(ruleSetConfigSchema.validate({ ...validBase, campaignDefs: [dbl11({ multiplier: "100" })] }).error).toBeDefined();
    expect(
      ruleSetConfigSchema.validate({ ...validBase, campaignDefs: [dbl11({ endAt: "2026-11-10T00:00:00+08:00" })] }).error
    ).toBeDefined();
    expect(ruleSetConfigSchema.validate({ ...validBase, campaignDefs: [dbl11(), dbl11()] }).error.message).toMatch(
      /campaignId dbl11 重复|窗口重叠/
    );
  });

  test("Validation — 窗口重叠且范围相交被拒；相邻窗口与范围不交则通过", () => {
    const overlap = ruleSetConfigSchema.validate({
      ...validBase,
      campaignDefs: [dbl11(), dbl11({ campaignId: "week", startAt: "2026-11-11T12:00:00+08:00", endAt: "2026-11-20T00:00:00+08:00" })],
      pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAMPAIGN" }, { handler: "CAP" }] },
    });
    expect(overlap.error.message).toMatch(/时间窗口重叠且加成范围相交/);
    // 左闭右开：前一个活动的 endAt 与后一个的 startAt 相同不算重叠
    const adjacent = ruleSetConfigSchema.validate({
      ...validBase,
      campaignDefs: [dbl11(), dbl11({ campaignId: "d2", startAt: "2026-11-12T00:00:00+08:00", endAt: "2026-11-13T00:00:00+08:00" })],
      pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAMPAIGN" }, { handler: "CAP" }] },
    });
    expect(adjacent.error).toBeUndefined();
    const disjointScope = ruleSetConfigSchema.validate({
      ...validBase,
      campaignDefs: [dbl11({ rewardIds: ["referral"] }), dbl11({ campaignId: "d2", rewardIds: ["team"] })],
      pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAMPAIGN" }, { handler: "CAP" }] },
    });
    expect(disjointScope.error).toBeUndefined();
  });

  test("Validation — 配了 campaignDefs 却没有 CAMPAIGN 阶段被拒（活动静默不生效）", () => {
    const { error } = ruleSetConfigSchema.validate({
      ...validBase,
      campaignDefs: [dbl11()],
      pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
    });
    expect(error.message).toMatch(/没有 CAMPAIGN 阶段/);
  });

  test("Validation — CAMPAIGN 阶段顺序错误被拒（CAP 之后 / DISTRIBUTE 之前 / 出现多次）", () => {
    const v = (stages) => ruleSetConfigSchema.validate({ ...validBase, campaignDefs: [dbl11()], pipelineDef: { stages } });
    expect(v([{ handler: "DISTRIBUTE" }, { handler: "CAP" }, { handler: "CAMPAIGN" }]).error.message).toMatch(
      /排在 CAP 之后/
    );
    expect(v([{ handler: "CAMPAIGN" }, { handler: "DISTRIBUTE" }, { handler: "CAP" }]).error.message).toMatch(
      /必须排在 DISTRIBUTE 之后/
    );
    expect(
      v([{ handler: "DISTRIBUTE" }, { handler: "CAMPAIGN" }, { handler: "CAMPAIGN" }, { handler: "CAP" }]).error.message
    ).toMatch(/多个 CAMPAIGN 阶段/);
  });

  test("Validation — CAMPAIGN 进入 handler 白名单，且既有配置（无新字段）不受影响", () => {
    expect(ruleSetConfigSchema.validate(validBase).error).toBeUndefined();
    expect(
      ruleSetConfigSchema.validate({ ...validBase, pipelineDef: { stages: [{ handler: "CAMPAIGN" }] } }).error.message
    ).not.toMatch(/handler 必须是/);
  });

  test("Utils.isWithinWindow — 左闭右开且 endAt <= startAt 抛错", () => {
    const w = { startAt: "2026-11-11T00:00:00+08:00", endAt: "2026-11-12T00:00:00+08:00" };
    expect(isWithinWindow(w, "2026-11-11T00:00:00+08:00")).toBe(true);
    expect(isWithinWindow(w, "2026-11-12T00:00:00+08:00")).toBe(false);
    expect(() => isWithinWindow({ startAt: w.endAt, endAt: w.startAt }, IN)).toThrow(/必须晚于 startAt/);
    expect(() => isWithinWindow({ startAt: w.startAt }, IN)).toThrow(/endAt 缺失/);
  });
});

// ====================== Adapters ======================

describe("Adapters", () => {
  test("buildPipelineStages — 默认 DISTRIBUTE + CAP", () => {
    const stages = buildPipelineStages(
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
    const stages = buildPipelineStages(
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

  test("buildPipelineStages — sourceNode 透传至 DISTRIBUTE 阶段", () => {
    const sourceNode = { id: "u1", attrs: { vip: 1 } };
    const stages = buildPipelineStages(
      {
        rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
        capDefs: [],
      },
      { event: { sourceNodeId: "u1", eventValue: "1000" }, sourceNode, directParent: null, ancestors: [] }
    );
    expect(stages[0].config.sourceNode).toBe(sourceNode);
  });

  test("buildPipelineStages + executePipeline — target:SOURCE 的受益节点侧条件端到端生效", () => {
    const config = {
      rewardDefs: [{
        rewardId: "r1",
        type: "DIRECT",
        target: "SOURCE",
        rate: "100",
        // field 用扁平字段名：_resolveField 对受益节点 attrs 优先（不支持点分路径）
        conditions: [{ source: "target", field: "vip", operator: "EQ", value: 1 }],
      }],
      capDefs: [],
    };
    const event = { sourceNodeId: "u1", eventValue: "1000" };
    const run = (sourceNode) => Engine.Orchestrate.executePipeline({
      stages: buildPipelineStages(config, { event, sourceNode, directParent: null, ancestors: [] }),
    }).final;
    // attrs.vip=1 → 命中门槛，发放 100% = 1000
    const hit = run({ id: "u1", attrs: { vip: 1 } });
    expect(hit.map((r) => [r.nodeId, r.amount])).toEqual([["u1", "1000"]]);
    // attrs.vip=0 → 未命中，不发放（fail-closed）
    expect(run({ id: "u1", attrs: { vip: 0 } })).toEqual([]);
    // 缺 sourceNode → 抛错（集成缺失，绝不静默放行）
    expect(() => run(null)).toThrow(/请给 distributeByDefs 传入 sourceNode/);
  });

  test("customerAdapterTemplate 存在且有结构", () => {
    expect(customerAdapterTemplate).toBeDefined();
    expect(typeof customerAdapterTemplate).toBe("object");
  });
});

// ====================== Validation ======================

describe("Validation", () => {
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

  test("ruleSetConfigSchema - capDefs 接受 8 个封顶 scope 全组合（周/月/活动总量）", () => {
    for (const scope of Engine.Allocate.CAP_SCOPES) {
      const { error } = ruleSetConfigSchema.validate({
        rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
        rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
        capDefs: [{ capId: "c1", scope, limit: "5000" }],
      });
      expect(error).toBeUndefined();
    }
  });

  test("ruleSetConfigSchema - 未知封顶 scope 在配置期拒绝（校验枚举与引擎 CAP_SCOPES 同源）", () => {
    // CAMPAIGN_TOTAL / PLATFORM_YEARLY 都不是合法 scope：活动总量用 PLATFORM_TOTAL / PER_USER_TOTAL 表达
    for (const scope of ["CAMPAIGN_TOTAL", "PLATFORM_YEARLY", "PER_USER_MONTHLI"]) {
      const { error } = ruleSetConfigSchema.validate({
        rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
        rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
        capDefs: [{ capId: "c1", scope, limit: "5000" }],
      });
      expect(error).toBeDefined();
      expect(error.message).toMatch(/capDefs\[0\]\.scope/);
    }
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

  test("ruleSetConfigSchema - LEVEL 的合法 maxDepth 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "lv", type: "LEVEL", accumulateInChain: true, maxDepth: 5 }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - maxDepth < 1 或非整数失败", () => {
    for (const bad of [0, -1, 2.5]) {
      const { error } = ruleSetConfigSchema.validate({
        rewardDefs: [{ rewardId: "lv", type: "LEVEL", accumulateInChain: true, maxDepth: bad }],
        rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
      });
      expect(error).toBeDefined();
    }
  });

  test("ruleSetConfigSchema - maxDepth 挂在非 LEVEL 类型上失败（防误以为深度受限）", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "5", maxDepth: 3 }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
  });

  test("ruleSetConfigSchema - LEVEL 的合法 levelRates 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "lv", type: "LEVEL", levelRates: ["10", "5", 3] }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - 非法 levelRates 失败（空数组/负数/超上限/空洞/全 0）", () => {
    for (const bad of [[], ["-1"], [1001], [null], ["", "5"], ["0", "0"]]) {
      const { error } = ruleSetConfigSchema.validate({
        rewardDefs: [{ rewardId: "lv", type: "LEVEL", levelRates: bad }],
        rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
      });
      expect(error).toBeDefined();
    }
  });

  test("ruleSetConfigSchema - levelRates 与 accumulateInChain=true 并存失败（口径冲突）", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "lv", type: "LEVEL", accumulateInChain: true, levelRates: ["10"] }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
  });

  test("ruleSetConfigSchema - levelRates 挂在非 LEVEL 类型上失败（挂了不会生效）", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "5", levelRates: ["10"] }],
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
    expect(error.message).toMatch(/fixedAmount/);
  });

  test("ruleSetConfigSchema - FIXED fixedAmount=0 失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "FIXED", target: "PARENT", fixedAmount: "0" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/fixedAmount/);
  });

  test("ruleSetConfigSchema - CUSTOM 类型带 amount 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "CUSTOM", target: "SOURCE", amount: "100" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - CUSTOM 类型带 amountFrom(eventValue) 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "CUSTOM", target: "PARENT", amountFrom: "eventValue" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - CUSTOM 类型带 amountFrom(event.attrs 路径) 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "CUSTOM", target: "SOURCE", amountFrom: "event.attrs.level.bonus" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - CUSTOM 类型缺金额（无 amount/amountFrom）失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "CUSTOM", target: "SOURCE", rate: "5" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/CUSTOM/);
  });

  test("ruleSetConfigSchema - CUSTOM amountFrom 非法路径失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "CUSTOM", target: "SOURCE", amountFrom: "node.attrs.x" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
    });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/amountFrom/);
  });

  test("ruleSetConfigSchema - rankDef 携带 rankRate 通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
      rankDefs: [
        { rankId: "V0", levelIndex: 0, rankRate: "0", conditions: [] },
        { rankId: "V1", levelIndex: 1, rankRate: "15", conditions: [{ field: "directCount", operator: "GTE", value: 3 }] },
      ],
    });
    expect(error).toBeUndefined();
  });

  test("ruleSetConfigSchema - rankRate 超过 1000 失败", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
      rankDefs: [{ rankId: "V1", levelIndex: 1, rankRate: "1500", conditions: [] }],
    });
    expect(error).toBeDefined();
  });

  test("ruleSetConfigSchema - pipelineDef 声明 RANK 阶段通过", () => {
    const { error } = ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
      rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
      pipelineDef: { stages: [{ handler: "RANK" }, { handler: "DISTRIBUTE" }, { handler: "CAP" }] },
    });
    expect(error).toBeUndefined();
  });

  // --- 4.0.0 新增：target=ANCESTOR 定点单层发放的配置校验 ---

  const validateReward = (rewardDef) => ruleSetConfigSchema.validate({
    rewardDefs: [rewardDef],
    rankDefs: [{ rankId: "MEMBER", levelIndex: 0, conditions: [] }],
  });

  test("ruleSetConfigSchema - target=ANCESTOR + ancestorLevel 通过（DIRECT/FIXED/CUSTOM）", () => {
    expect(validateReward({ rewardId: "r1", type: "DIRECT", target: "ANCESTOR", ancestorLevel: 3, rate: "3" }).error).toBeUndefined();
    expect(validateReward({ rewardId: "r1", type: "FIXED", target: "ANCESTOR", ancestorLevel: 1, fixedAmount: "50" }).error).toBeUndefined();
    expect(validateReward({ rewardId: "r1", type: "CUSTOM", target: "ANCESTOR", ancestorLevel: 2, amount: "10" }).error).toBeUndefined();
  });

  test("ruleSetConfigSchema - target=ANCESTOR 缺 ancestorLevel 失败（fail-closed）", () => {
    const { error } = validateReward({ rewardId: "r1", type: "DIRECT", target: "ANCESTOR", rate: "3" });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/必须声明 ancestorLevel/);
  });

  test("ruleSetConfigSchema - 非法 ancestorLevel（0/负数/小数）失败", () => {
    for (const bad of [0, -1, 2.5]) {
      expect(validateReward({
        rewardId: "r1", type: "DIRECT", target: "ANCESTOR", ancestorLevel: bad, rate: "3",
      }).error).toBeDefined();
    }
  });

  test("ruleSetConfigSchema - ancestorLevel 挂在 SOURCE/PARENT 上失败（防误以为按层发放）", () => {
    for (const target of ["SOURCE", "PARENT"]) {
      const { error } = validateReward({ rewardId: "r1", type: "DIRECT", target, ancestorLevel: 2, rate: "3" });
      expect(error).toBeDefined();
      expect(error.message).toMatch(/ancestorLevel 仅适用于 target=ANCESTOR/);
    }
  });

  test("ruleSetConfigSchema - type=LEVEL 不允许 target=ANCESTOR（应改用 DIRECT/FIXED/CUSTOM）", () => {
    const { error } = validateReward({ rewardId: "r1", type: "LEVEL", target: "ANCESTOR", ancestorLevel: 2 });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/type=LEVEL 不支持 target=ANCESTOR/);
  });

  // --- 4.0.0 新增：conditions 条件树校验（含 source 数据源）---

  const withConditions = (conditions) => validateReward({
    rewardId: "r1", type: "DIRECT", target: "PARENT", rate: "10", conditions,
  });

  test("ruleSetConfigSchema - conditions 扁平 COMPARE / 显式 source 通过", () => {
    expect(withConditions([{ field: "orderAmount", operator: "GTE", value: 1000 }]).error).toBeUndefined();
    expect(withConditions([
      { type: "COMPARE", field: "orderAmount", operator: "GTE", value: 1000, source: "event" },
      { field: "teamPerformance", operator: "GTE", value: "50000", source: "target" },
    ]).error).toBeUndefined();
  });

  test("ruleSetConfigSchema - conditions 复合条件递归校验（任意深度）", () => {
    expect(withConditions([{
      type: "AND",
      children: [
        { type: "OR", children: [
          { field: "a", operator: "GTE", value: 1, source: "event" },
          { type: "NOT", children: [{ field: "b", operator: "LT", value: 2, source: "target" }] },
        ] },
        { field: "c", operator: "EQ", value: "V3", source: "target" },
      ],
    }]).error).toBeUndefined();
    // 嵌套深处的 operator 笔误必须被定位到具体路径（旧 schema 完全不校验 conditions）
    const { error } = withConditions([{ type: "AND", children: [{ field: "a", operator: "GGE", value: 1 }] }]);
    expect(error).toBeDefined();
    expect(error.message).toMatch(/conditions\[0\]\.children\[0\]\.operator/);
  });

  test("ruleSetConfigSchema - conditions 非法 source / 拼错字段名失败（防运行期才暴露）", () => {
    expect(withConditions([{ field: "a", operator: "GTE", value: 1, source: "node" }]).error.message)
      .toMatch(/source" must be one of \[event, target\]/);
    expect(withConditions([{ field: "a", operator: "GTE", value: 1, sources: "target" }]).error.message)
      .toMatch(/sources" is not allowed/);
  });

  test("ruleSetConfigSchema - conditions 复合条件 children 为空失败（语义模糊 = 静默改门槛）", () => {
    expect(withConditions([{ type: "AND", children: [] }]).error).toBeDefined();
    expect(withConditions([{ type: "AND" }]).error).toBeDefined();
  });

  test("ruleSetConfigSchema - rankDefs.conditions 只允许 source=target（等级评估无事件上下文）", () => {
    const validateRank = (conditions) => ruleSetConfigSchema.validate({
      rewardDefs: [{ rewardId: "r1", type: "DIRECT", target: "SOURCE", rate: "100" }],
      rankDefs: [{ rankId: "V1", levelIndex: 1, conditions }],
    });
    expect(validateRank([{ field: "directCount", operator: "GTE", value: 3, source: "target" }]).error).toBeUndefined();
    // 复合条件同样支持（旧扁平 conditionSchema 会拒绝，属能力扩展）
    expect(validateRank([{ type: "OR", children: [
      { field: "directCount", operator: "GTE", value: 3 },
      { field: "teamPerformance", operator: "GTE", value: "50000" },
    ] }]).error).toBeUndefined();
    expect(validateRank([{ field: "directCount", operator: "GTE", value: 3, source: "event" }]).error.message)
      .toMatch(/source" must be \[target\]/);
  });
});

// ====================== Utils ======================

describe("Utils", () => {
  test("selectVersionByRoutingKey - 单版本直接返回", () => {
    const result = selectVersionByRoutingKey(
      { enabled: true, versions: [{ version: 1, weight: 100, config_json: { test: true } }] },
      "user123"
    );
    expect(result.version).toBe(1);
  });

  test("selectVersionByRoutingKey - 禁用的灰度返回 null", () => {
    const result = selectVersionByRoutingKey(
      { enabled: false, versions: [{ version: 1, weight: 100, config_json: { test: true } }] },
      "user123"
    );
    expect(result).toBeNull();
  });

  test("selectVersionByRoutingKey - 多版本按权重分配", () => {
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
    expect(validateGrayscaleWeights({
      enabled: true,
      versions: [{ version: 1, weight: 70 }, { version: 2, weight: 30 }],
    })).toBe(true);
  });

  test("validateGrayscaleWeights - 权重总和不为 100 返回 false", () => {
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
  test("div 除零抛错（P2 资金安全）", () => {
    expect(() => Decimal.div("100", "0")).toThrow(/除数不能为 0/);
    expect(() => Decimal.div("0", "0")).toThrow(/除数不能为 0/);
  });
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
