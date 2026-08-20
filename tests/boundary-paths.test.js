/**
 * @usethink/incentive-engine 边界与兼容路径测试（报告 §六 第 17 项：分支覆盖率 80%）
 *
 * 覆盖对象是「审查报告点名的低分支覆盖文件」里那些**方向敏感**的分叉 ——
 * 不是为了把百分比刷上去，而是把下列每条路径的行为钉死，避免后续重构时
 * 静默改变发放/拦截方向：
 *
 * 1. `Decimal` 的空值兜底（`null`/`undefined`/`""` 按 0 处理）—— 少发方向，不可改成抛错前的静默 NaN。
 * 2. `evaluateTier` 的**遗留 `min_*` 字段模式**（宿主等级表直接映射，不经 conditions 翻译）——
 *    审查前该分支几乎无断言，而它决定「谁够等级拿钱」。
 * 3. `evaluateCondition` 的不满足/容错分叉（未知 operator、非数值、空 children、attrs 回退）——
 *    门槛判定翻转即超发或静默少发。
 * 4. `DIRECT`/`FIXED`/`CUSTOM` 三种奖励的**不发放**出口（null 返回），以及 CUSTOM 动态取数的回退链。
 * 5. 模型层归一化（`levelRates` 逐项 String、`Condition` 空 source 不落字段等）。
 * 6. 灰度版本路由的边界（无版本、缺 weight）。
 * 7. `compareAmounts` 未知策略、`applyCaps` / `applyBudgetGuard` 的缺省与兜底分叉 ——
 *    未知策略静默取最大值、缺配置静默放行都是超发方向。
 * 8. `executePipeline` 各阶段的缺省参数与守卫（缺 rewardDefs/capDefs、RANK 空转、两个 REVERSE）。
 */

const Decimal = require("../src/decimal");
const { Evaluate, Distribute, Model, Allocate, Orchestrate } = require("../src/engine");
const { selectVersionByRoutingKey, validateGrayscaleWeights } = require("../src/utils");
const adapterTemplate = require("../src/adapters/customer-adapter-template");
const { validateCustomerConfig } = require("../src/validation");

const C = (o) => ({ type: "COMPARE", ...o });

// ====================== 1. Decimal 空值与缺省参数 ======================

describe("Decimal 空值兜底", () => {
  test("算术：null / undefined / \"\" 一律按 0 参与运算，不产出 NaN", () => {
    expect(Decimal.mul(null, 5)).toBe("0");
    expect(Decimal.add(undefined, "1.5")).toBe("1.5");
    expect(Decimal.sub("", 2)).toBe("-2");
    expect(Decimal.div(null, "4")).toBe("0");
    expect(Decimal.round(null)).toBe("0");
    expect(Decimal.pct(null, 10)).toBe("0");
    expect(Decimal.neg(null)).toBe("0");
    expect(Decimal.toFixed(null)).toBe("0.0000");
    expect(Decimal.toDisplay(null)).toBe(0);
  });

  test("比较与极值：空值按 0 比较（min/max 取到 0 而非 NaN）", () => {
    expect(Decimal.gte(null, 0)).toBe(true);
    expect(Decimal.gt(null, "-1")).toBe(true);
    expect(Decimal.lt(null, "1")).toBe(true);
    expect(Decimal.lte(null, "0")).toBe(true);
    expect(Decimal.eq(null, 0)).toBe(true);
    expect(Decimal.min(null, "5")).toBe("0");
    expect(Decimal.max(null, "-5")).toBe("0");
  });

  test("缺省小数位：算术 4 位、round 2 位、toDisplay 2 位", () => {
    expect(Decimal.mul("1.00005", "1")).toBe("1.0001"); // dp=4 四舍五入
    expect(Decimal.round("1.005")).toBe("1.01");        // dp=2
    expect(Decimal.toDisplay("1.005")).toBe(1.01);
    expect(Decimal.toFixed("30")).toBe("30.0000");
  });
});

// ====================== 2. evaluateTier 遗留 min_* 字段模式 ======================

describe("Evaluate.evaluateTier 遗留字段模式（宿主等级表直接映射）", () => {
  test("原始对象（无 metadata）读 tier_level：0 级无条件满足", () => {
    expect(Evaluate.evaluateTier({}, { tier_level: 0, min_direct_count: 99 })).toBe(true);
  });

  test("min_direct_count：不足判不满足，达标判满足", () => {
    const tier = { tier_level: 2, min_direct_count: 3, rank_rate: "15" };
    expect(Evaluate.evaluateTier({ directCount: 2 }, tier)).toBe(false);
    expect(Evaluate.evaluateTier({ directCount: 3 }, tier)).toBe(true);
    // directCount 缺失按 0，不因字段缺失静默放行
    expect(Evaluate.evaluateTier({}, tier)).toBe(false);
  });

  test("min_team_performance：走 Decimal 比较，差 0.0001 也判不满足", () => {
    const tier = { tier_level: 1, min_team_performance: "10000" };
    expect(Evaluate.evaluateTier({ teamPerformance: "9999.9999" }, tier)).toBe(false);
    expect(Evaluate.evaluateTier({ teamPerformance: "10000" }, tier)).toBe(true);
    expect(Evaluate.evaluateTier({}, tier)).toBe(false);
  });

  test("required_higher_tier 显式为 null：跳过高级别下属检查（视为满足）", () => {
    const tier = { tier_level: 1, min_higher_tier_count: 2, required_higher_tier: null };
    expect(Evaluate.evaluateTier({}, tier)).toBe(true);
  });

  test("required_higher_tier 指定等级：读 higherTierCounts[该等级]", () => {
    const tier = { tier_level: 1, min_higher_tier_count: 2, required_higher_tier: 3 };
    expect(Evaluate.evaluateTier({ higherTierCounts: { 3: 1 } }, tier)).toBe(false);
    expect(Evaluate.evaluateTier({ higherTierCounts: { 3: 2 } }, tier)).toBe(true);
    // 映射缺失按 0，不降级到单值字段（避免拿错口径的人数放行）
    expect(Evaluate.evaluateTier({ higherTierCount: 9 }, tier)).toBe(false);
  });

  test("required_higher_tier 字段缺失（undefined）：降级读单值 higherTierCount", () => {
    const tier = { tier_level: 1, min_higher_tier_count: 2 };
    expect(Evaluate.evaluateTier({ higherTierCount: 2 }, tier)).toBe(true);
    expect(Evaluate.evaluateTier({ higherTierCount: 1 }, tier)).toBe(false);
  });

  test("fail-closed：无任何遗留门槛且 rank_rate > 0 → 判不满足（漏配 conditions 不得顶格分成）", () => {
    expect(Evaluate.evaluateTier({}, { tier_level: 1, rank_rate: "5" })).toBe(false);
    // rank_rate = 0 的无门槛等级只是等级提升、不发钱，非单调设计合法
    expect(Evaluate.evaluateTier({}, { tier_level: 1, rank_rate: "0" })).toBe(true);
  });

  test("metadata 模式：min_* 从 metadata 读，rankRate 优先 metadata", () => {
    const tier = new Model.RankDef({
      id: 7, rankId: "V2", levelIndex: 2, rankRate: "0",
      metadata: { minDirectCount: 2, minTeamPerformance: "100", rankRate: "15" },
    });
    expect(Evaluate.evaluateTier({ directCount: 2, teamPerformance: "100" }, tier)).toBe(true);
    expect(Evaluate.evaluateTier({ directCount: 1, teamPerformance: "100" }, tier)).toBe(false);
    // metadata 无门槛 + metadata.rankRate > 0 → fail-closed
    const noGate = new Model.RankDef({ id: 8, levelIndex: 1, metadata: { rankRate: "9" } });
    expect(Evaluate.evaluateTier({}, noGate)).toBe(false);
  });

  test("顶层 rankRate 与遗留 rank_rate 都参与 fail-closed 判定", () => {
    expect(Evaluate.evaluateTier({}, { tier_level: 1, rankRate: "3" })).toBe(false);
    expect(Evaluate.evaluateTier({}, { tier_level: 1 })).toBe(true); // 三处都没有 → 视为 "0"
  });
});

// ====================== 3. evaluateCondition 边界与容错 ======================

describe("Evaluate.evaluateCondition 边界", () => {
  test("NE：数值走 Decimal（\"1.0\" 等于 1），非数值走字符串不等", () => {
    expect(Evaluate.evaluateCondition(C({ field: "a", operator: "NE", value: 1 }), { a: 2 })).toBe(true);
    expect(Evaluate.evaluateCondition(C({ field: "a", operator: "NE", value: 1 }), { a: "1.0" })).toBe(false);
    expect(Evaluate.evaluateCondition(C({ field: "r", operator: "NE", value: "V3" }), { r: "V2" })).toBe(true);
    expect(Evaluate.evaluateCondition(C({ field: "r", operator: "NE", value: "V3" }), { r: "V3" })).toBe(false);
  });

  test("大小比较遇非数值一律判不满足（不静默按 0 比较）", () => {
    for (const op of ["GTE", "GT", "LTE", "LT"]) {
      expect(Evaluate.evaluateCondition(C({ field: "r", operator: op, value: 1 }), { r: "abc" })).toBe(false);
      expect(Evaluate.evaluateCondition(C({ field: "r", operator: op, value: "abc" }), { r: 1 })).toBe(false);
    }
  });

  test("未知 operator / 未知 type / 非对象条件 → 一律不满足（不静默放行）", () => {
    expect(Evaluate.evaluateCondition(C({ field: "a", operator: ">=", value: 1 }), { a: 5 })).toBe(false);
    expect(Evaluate.evaluateCondition({ type: "XOR", children: [] }, {})).toBe(false);
    expect(Evaluate.evaluateCondition("COMPARE", {})).toBe(false);
    expect(Evaluate.evaluateCondition(null, {})).toBe(false);
    expect(Evaluate.evaluateCondition({}, {})).toBe(false); // 既无 type 也无 field
  });

  test("复合条件 children 为空数组：AND=true / OR=false / NOT=true（配置期已由 Validation 拒绝）", () => {
    expect(Evaluate.evaluateCondition({ type: "AND", children: [] }, {})).toBe(true);
    expect(Evaluate.evaluateCondition({ type: "OR", children: [] }, {})).toBe(false);
    expect(Evaluate.evaluateCondition({ type: "NOT", children: [] }, {})).toBe(true);
    // children 非数组同上（Condition 模型会归一为 []，普通对象直接走该分支）
    expect(Evaluate.evaluateCondition({ type: "AND", children: "x" }, {})).toBe(true);
    expect(Evaluate.evaluateCondition({ type: "OR", children: null }, {})).toBe(false);
    expect(Evaluate.evaluateCondition({ type: "NOT" }, {})).toBe(true);
  });

  test("NOT 多个子条件：等价于 AND 后取反", () => {
    const cond = {
      type: "NOT",
      children: [C({ field: "a", operator: "GTE", value: 1 }), C({ field: "b", operator: "GTE", value: 99 })],
    };
    expect(Evaluate.evaluateCondition(cond, { a: 5, b: 1 })).toBe(true);   // AND=false → 取反 true
    expect(Evaluate.evaluateCondition(cond, { a: 5, b: 100 })).toBe(false); // AND=true  → 取反 false
  });

  test("字段解析：attrs 优先于顶层（三个硬编码字段与通用字段同一优先级）", () => {
    expect(Evaluate.evaluateCondition(
      C({ field: "directCount", operator: "EQ", value: 9 }), { directCount: 1, attrs: { directCount: 9 } }
    )).toBe(true);
    expect(Evaluate.evaluateCondition(
      C({ field: "teamPerformance", operator: "EQ", value: "500" }), { teamPerformance: "1", attrs: { teamPerformance: "500" } }
    )).toBe(true);
    expect(Evaluate.evaluateCondition(
      C({ field: "higherTierCounts", operator: "EQ", value: 4 }), { higherTierCount: 1, attrs: { higherTierCount: 4 } }
    )).toBe(true);
    expect(Evaluate.evaluateCondition(
      C({ field: "custom", operator: "EQ", value: 7 }), { custom: 1, attrs: { custom: 7 } }
    )).toBe(true);
  });

  test("字段解析：higherTierCounts 无 subKey 时回退单值字段；数据源缺失按 0/\"0\"", () => {
    expect(Evaluate.evaluateCondition(
      C({ field: "higherTierCounts", operator: "EQ", value: 3 }), { higherTierCount: 3 }
    )).toBe(true);
    expect(Evaluate.evaluateCondition(C({ field: "missing", operator: "EQ", value: 0 }), {})).toBe(true);
    expect(Evaluate.evaluateCondition(C({ field: "a", operator: "EQ", value: 0 }), null)).toBe(true);
    // 期望值为 null → 规范化为 ""，与数值 "0" 不相等（不静默当 0 匹配）
    expect(Evaluate.evaluateCondition(C({ field: "a", operator: "EQ", value: null }), { a: null })).toBe(false);
  });
});

// ====================== 4. 三种奖励的不发放出口与 CUSTOM 取数回退 ======================

describe("Distribute 不发放出口（fail-closed，返回 null 而非 0 元记录）", () => {
  test("calculateDirect：无目标节点 / 比例<=0 / 未评级被跳过 / 金额算成 0", () => {
    expect(Distribute.calculateDirect({ rewardDef: { rewardId: "r", rate: "10" } })).toBeNull();
    expect(Distribute.calculateDirect({
      rewardDef: { rewardId: "r", rate: "0" }, targetNode: { id: "n", rankRate: "5" },
    })).toBeNull();
    // skipRankZero 缺省 true：rankRate 缺失（未评级）→ 不发
    expect(Distribute.calculateDirect({
      rewardDef: { rewardId: "r", rate: "10" }, targetNode: { id: "n" }, eventValue: "100",
    })).toBeNull();
    // eventValue 缺省 "0" → 金额 0 → 不写 0 元流水
    expect(Distribute.calculateDirect({
      rewardDef: { rewardId: "r", rate: "10", skipRankZero: false }, targetNode: { id: "n" },
    })).toBeNull();
  });

  test("calculateFixed：无目标节点 / fixedAmount 缺失或<=0 / 未评级；快照 targetRankRate 缺省 \"0\"", () => {
    expect(Distribute.calculateFixed({ rewardDef: { rewardId: "r", fixedAmount: "5" } })).toBeNull();
    expect(Distribute.calculateFixed({
      rewardDef: { rewardId: "r" }, targetNode: { id: "n", rankRate: "5" },
    })).toBeNull();
    expect(Distribute.calculateFixed({
      rewardDef: { rewardId: "r", fixedAmount: "0" }, targetNode: { id: "n", rankRate: "5" },
    })).toBeNull();
    expect(Distribute.calculateFixed({
      rewardDef: { rewardId: "r", fixedAmount: "5" }, targetNode: { id: "n" },
    })).toBeNull();
    const rec = Distribute.calculateFixed({
      rewardDef: { rewardId: "r", fixedAmount: "5", skipRankZero: false }, targetNode: { id: "n" },
    });
    expect(rec.amount).toBe("5");
    expect(rec.snapshot.targetRankRate).toBe("0");
    expect(rec.snapshot.skipRankZero).toBe(false);
  });

  test("calculateCustom：无目标节点 / 两种金额都不可解析 / 金额<=0 / 未评级", () => {
    expect(Distribute.calculateCustom({ rewardDef: { rewardId: "r", amount: "5" } })).toBeNull();
    expect(Distribute.calculateCustom({
      rewardDef: { rewardId: "r" }, targetNode: { id: "n", rankRate: "1" },
    })).toBeNull();
    expect(Distribute.calculateCustom({
      rewardDef: { rewardId: "r", amount: "0" }, targetNode: { id: "n", rankRate: "1" },
    })).toBeNull();
    expect(Distribute.calculateCustom({
      rewardDef: { rewardId: "r", amount: "5" }, targetNode: { id: "n" },
    })).toBeNull();
  });

  test("calculateCustom 动态取数：eventValue / attrs 点分路径 / 数字转字符串", () => {
    const node = { id: "n", rankRate: "1" };
    expect(Distribute.calculateCustom({
      rewardDef: { rewardId: "r", amountFrom: "eventValue" }, event: { eventValue: "88" }, targetNode: node,
    }).amount).toBe("88");
    expect(Distribute.calculateCustom({
      rewardDef: { rewardId: "r", amountFrom: "event.attrs.bonus" }, event: { attrs: { bonus: 12 } }, targetNode: node,
    }).amount).toBe("12");
    expect(Distribute.calculateCustom({
      rewardDef: { rewardId: "r", amountFrom: "event.attrs.a.b" }, event: { attrs: { a: { b: "9" } } }, targetNode: node,
    }).amount).toBe("9");
  });

  test("calculateCustom 取数失败一律回退 amount 常量（未知前缀 / 路径中断 / 值为空 / 无 event）", () => {
    const node = { id: "n", rankRate: "1" };
    const cases = [
      [{ rewardId: "r", amountFrom: "order.total", amount: "7" }, { eventValue: "999" }],   // 未知前缀
      [{ rewardId: "r", amountFrom: "event.attrs.a.b", amount: "7" }, { attrs: { a: "标量" } }], // 路径中断
      [{ rewardId: "r", amountFrom: "eventValue", amount: "7" }, { eventValue: "" }],        // 值为空
      [{ rewardId: "r", amountFrom: "event.attrs.x", amount: "7" }, undefined],              // 无 event
    ];
    for (const [rewardDef, event] of cases) {
      const rec = Distribute.calculateCustom({ rewardDef, event, targetNode: node });
      expect(rec.amount).toBe("7");
      expect(rec.snapshot.amountFrom).toBe(rewardDef.amountFrom);
    }
    // 取数失败且无 amount 常量 → 不发放
    expect(Distribute.calculateCustom({
      rewardDef: { rewardId: "r", amountFrom: "event.attrs.x" }, event: { attrs: {} }, targetNode: node,
    })).toBeNull();
  });
});

// ====================== 5. 模型层归一化 ======================

describe("Model 归一化", () => {
  test("RewardDef.levelRates：逐项 String，null 保留，非数组原样交由计算层抛错", () => {
    expect(new Model.RewardDef({ rewardId: "r", type: "LEVEL", levelRates: [10, null, "3"] }).levelRates)
      .toEqual(["10", null, "3"]);
    expect(new Model.RewardDef({ rewardId: "r", levelRates: "bad" }).levelRates).toBe("bad");
    expect(new Model.RewardDef({ rewardId: "r" }).levelRates).toBeNull();
  });

  test("RewardDef：rate/fixedAmount/amount/amountFrom 缺省 null，ancestorLevel/maxDepth 不兜底", () => {
    const d = new Model.RewardDef({ rewardId: "r" });
    expect([d.rate, d.fixedAmount, d.amount, d.amountFrom, d.ancestorLevel, d.maxDepth])
      .toEqual([null, null, null, null, null, null]);
    expect(d.type).toBe("DIRECT");
    expect(d.target).toBe("PARENT");
    expect(d.skipRankZero).toBe(true);
    expect(d.accumulateInChain).toBe(false);
  });

  test("RewardDef：数值字段一律 String 化 / Number 化，不保留宿主传入的原类型", () => {
    const d = new Model.RewardDef({
      rewardId: "r", type: "CUSTOM", rate: 10, fixedAmount: 5, amount: 7,
      amountFrom: "eventValue", ancestorLevel: "3", maxDepth: "2",
    });
    expect([d.rate, d.fixedAmount, d.amount, d.amountFrom]).toEqual(["10", "5", "7", "eventValue"]);
    expect([d.ancestorLevel, d.maxDepth]).toEqual([3, 2]); // 层号是数字，便于与链长比较
  });

  test("Condition：无参可构造；空 source 不落字段；复合类型 children 归一为数组；未知类型无 children", () => {
    expect(new Model.Condition()).toEqual({});
    const c = new Model.Condition({ type: "COMPARE", field: "a", source: "" });
    expect("source" in c).toBe(false);
    expect(new Model.Condition({ type: "AND" }).children).toEqual([]);
    expect("children" in new Model.Condition({ type: "XOR", children: [1] })).toBe(false);
  });

  test("RankDef / EngineEvent / EngineNode 缺省值", () => {
    const t = new Model.RankDef({});
    expect([t.levelIndex, t.rankId, t.rankRate]).toEqual([0, "V0", "0"]);
    const e = new Model.EngineEvent({ sourceNodeId: "u" });
    expect([e.eventId, e.eventType, e.eventValue]).toEqual([null, "generic", "0"]);
    const n = new Model.EngineNode({ id: "a", tags: new Set(["x"]) });
    expect(n.tags instanceof Set).toBe(true);
    expect(n.tags.has("x")).toBe(true);
  });
});

// ====================== 6. 灰度版本路由边界 ======================

describe("Utils 灰度路由边界", () => {
  test("未启用 / 无 versions 字段 / 空数组 → null", () => {
    expect(selectVersionByRoutingKey(null, "u1")).toBeNull();
    expect(selectVersionByRoutingKey({ enabled: false, versions: [{ version: 1, weight: 100 }] }, "u1")).toBeNull();
    expect(selectVersionByRoutingKey({ enabled: true }, "u1")).toBeNull();
    expect(selectVersionByRoutingKey({ enabled: true, versions: [] }, "u1")).toBeNull();
  });

  test("多版本全部缺 weight（视为 0）→ 兜底返回最后一个版本", () => {
    const versions = [{ version: 1 }, { version: 2 }];
    expect(selectVersionByRoutingKey({ enabled: true, versions }, "u1").version).toBe(2);
  });

  test("validateGrayscaleWeights：无配置视为通过；缺 weight 按 0 汇总", () => {
    expect(validateGrayscaleWeights(null)).toBe(true);
    expect(validateGrayscaleWeights({})).toBe(true);
    expect(validateGrayscaleWeights({ versions: [{ version: 1 }] })).toBe(false);
    expect(validateGrayscaleWeights({ versions: [{ version: 1, weight: 60 }, { version: 2, weight: 40 }] })).toBe(true);
  });
});

// ====================== 7. 接入模板的兼容回退路径 ======================

describe("customerAdapterTemplate 兼容回退", () => {
  test("_mapEvent：缺 id/type/amount 时的兜底（eventId 用时间戳、类型 DEFAULT、金额 \"0\"）", () => {
    const e = adapterTemplate._mapEvent({ memberId: "u1" });
    expect(e.sourceNodeId).toBe("u1");
    expect(e.eventType).toBe("DEFAULT");
    expect(e.eventValue).toBe("0");
    expect(String(e.eventId)).toMatch(/^\d+$/);
  });

  test("_buildRankDefs / _buildRewardDefs：入参缺省为空数组，逐项字段各有兜底", () => {
    expect(adapterTemplate._buildRankDefs()).toEqual([]);
    expect(adapterTemplate._buildRewardDefs()).toEqual([]);
    const tier = adapterTemplate._buildRankDefs([{}])[0];
    expect([tier.id, tier.levelIndex, tier.rankId, tier.rankRate]).toEqual([0, 0, "Level0", "0"]);
    expect(tier.conditions).toEqual([]); // 无门槛配置时不造条件
    const def = adapterTemplate._buildRewardDefs([{}])[0];
    expect([def.rewardId, def.type, def.rate]).toEqual(["reward-0", "DIRECT", "0"]);
  });

  test("executeCustomerIncentive：规则集「直接形态」（无 config_json）+ 外部 capState 生效", () => {
    const res = adapterTemplate.executeCustomerIncentive({
      event: { memberId: "u1", amount: "100" },
      directParent: { id: "p1", rankRate: "10" },
      ruleSet: {
        rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "10", skipRankZero: false }],
        capDefs: [{ scope: "PLATFORM_DAILY", limit: "5", onExceed: "REJECT" }],
        pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
      },
      capState: { platformPaid: "3" }, // 已用 3，剩余额度 2
    });
    expect(res.final).toHaveLength(1);
    expect(res.final[0].amount).toBe("2"); // 10 被裁剪到剩余额度 2，证明外部水位真的传进去了
    expect(res.final[0].snapshot.payoutCaps.boundBy).toBe("PLATFORM_DAILY");
  });
});

// ====================== 8. validateCustomerConfig 的非 Joi 回退校验 ======================

describe("Validation.validateCustomerConfig 基础回退校验（宿主未安装 joi 时的实际路径）", () => {
  test("非对象入参直接拒绝", () => {
    expect(validateCustomerConfig(null, false).errors).toEqual(["配置必须是非空对象"]);
    expect(validateCustomerConfig([], false).valid).toBe(false);
  });

  test("八个必填项缺失全部报出，并告警未注入 UniqueConstraintError", () => {
    const r = validateCustomerConfig({}, false);
    expect(r.valid).toBe(false);
    for (const f of ["name", "ruleSetCode", "model", "buildEvent", "buildRecord", "idempotency", "sequelize", "ruleSetService"]) {
      expect(r.errors).toContain(`"${f}" 是必填项`);
    }
    expect(r.warnings[0]).toContain("未注入 UniqueConstraintError");
  });

  test("字段存在但类型不是函数时逐项报出（含 idempotency / sequelize / ruleSetService / model 四组）", () => {
    const r = validateCustomerConfig({
      name: "x", ruleSetCode: "R",
      buildEvent: 1, buildRecord: 2,
      idempotency: {}, sequelize: {}, ruleSetService: {}, model: {},
    }, false);
    expect(r.valid).toBe(false);
    for (const msg of [
      "\"buildEvent\" 必须是函数", "\"buildRecord\" 必须是函数",
      "\"idempotency.buildPreReadWhere\" 必须是函数", "\"idempotency.buildFallbackWhere\" 必须是函数",
      "\"sequelize.transaction\" 必须是函数", "\"ruleSetService.getActiveRuleSet\" 必须是函数",
      "\"model.create\" 必须是函数", "\"model.findAll\" 必须是函数",
      "\"model.findOne\" 必须是函数", "\"model.findAndCountAll\" 必须是函数",
    ]) {
      expect(r.errors).toContain(msg);
    }
  });

  test("完整合法配置（含 UniqueConstraintError）通过且无告警", () => {
    const noop = () => {};
    const r = validateCustomerConfig({
      name: "x", ruleSetCode: "R",
      buildEvent: noop, buildRecord: noop,
      idempotency: { buildPreReadWhere: noop, buildFallbackWhere: noop },
      sequelize: { transaction: noop },
      ruleSetService: { getActiveRuleSet: noop },
      model: { create: noop, findAll: noop, findOne: noop, findAndCountAll: noop },
      UniqueConstraintError: class extends Error {},
    }, false);
    expect(r).toEqual({ valid: true });
  });
});

// ====================== 9. Allocate.compareAmounts 策略分叉 ======================

describe("Allocate.compareAmounts 策略分叉（未知策略必须 fail-closed）", () => {
  test("未知策略返回 defaultValue，绝不静默取最大值", () => {
    // 方向性：若 default 分支改成 fallthrough 到 MAX，配错策略名会取到最大金额 = 超发。
    expect(Allocate.compareAmounts("MAXX", ["100", "5"])).toBe("0");
    expect(Allocate.compareAmounts("MAXX", ["100", "5"], { defaultValue: "1" })).toBe("1");
  });

  test("amounts 为空数组或非数组时返回 defaultValue", () => {
    expect(Allocate.compareAmounts("MAX", [])).toBe("0");
    expect(Allocate.compareAmounts("MAX", "100")).toBe("0");
    expect(Allocate.compareAmounts("MAX", [], { defaultValue: "7" })).toBe("7");
  });

  test("FIRST：全部为零时取最后一个值；最后一个是空串时回落 defaultValue", () => {
    expect(Allocate.compareAmounts("FIRST", ["0", "0.00"])).toBe("0.00");
    expect(Allocate.compareAmounts("FIRST", ["0", ""])).toBe("0");
    expect(Allocate.compareAmounts("FIRST", ["0", ""], { defaultValue: "9" })).toBe("9");
  });

  test("三种合法策略的基线口径不变", () => {
    expect(Allocate.compareAmounts("MAX", ["1", "30", "2"])).toBe("30");
    expect(Allocate.compareAmounts("MIN", ["10", "3", "20"])).toBe("3");
    expect(Allocate.compareAmounts("FIRST", ["0", "8", "9"])).toBe("8");
  });
});

// ====================== 10. applyCaps / applyBudgetGuard 边界 ======================

describe("Allocate.applyCaps 边界", () => {
  test("负金额记录的报错信息里 nodeId 依次回退 memberId → \"?\"", () => {
    expect(() => Allocate.applyCaps([{ memberId: "m9", amount: "-1" }], []))
      .toThrow(/nodeId=m9, amount=-1/);
    expect(() => Allocate.applyCaps([{ amount: "-1" }], []))
      .toThrow(/nodeId=\?, amount=-1/);
  });

  test("周期桶的 memberPaid 为 null 时就地补建 Map，水位照常推进", () => {
    const state = {
      platformPaid: "0",
      memberPaid: new Map(),
      periods: { WEEKLY: { platformPaid: "0", memberPaid: null } },
    };
    const out = Allocate.applyCaps(
      [{ nodeId: "n1", amount: "10" }],
      [{ scope: "PLATFORM_WEEKLY", limit: "100" }],
      state
    );
    expect(out.map((r) => r.amount)).toEqual(["10"]);
    expect(state.periods.WEEKLY.platformPaid).toBe("10");
    expect(state.periods.WEEKLY.memberPaid instanceof Map).toBe(true);
    expect(state.periods.WEEKLY.memberPaid.get("n1")).toBe("10");
  });

  test("同 scope 多条时取最严 —— 更严的那条排在前面也一样生效", () => {
    // 「取最严」不依赖配置顺序：limit:100 在前时同样按 100 封顶。
    const out = Allocate.applyCaps(
      [{ nodeId: "n1", amount: "500" }],
      [{ scope: "PLATFORM_DAILY", limit: "100" }, { scope: "PLATFORM_DAILY", limit: "1000" }],
      { platformPaid: "0", memberPaid: new Map() }
    );
    expect(out[0].amount).toBe("100");
    expect(out[0].snapshot.payoutCaps.boundBy).toBe("PLATFORM_DAILY");
    expect(out[0].snapshot.payoutCaps.limits).toEqual({ PLATFORM_DAILY: "100" });
  });

  test("记录只带 memberId、水位桶缺 platformPaid 时按 0 起算并补齐", () => {
    const state = { memberPaid: new Map() };
    const out = Allocate.applyCaps(
      [{ memberId: "m1", amount: "30" }],
      [{ scope: "PER_USER_DAILY", limit: "20" }],
      state
    );
    expect(out.map((r) => r.amount)).toEqual(["20"]);
    expect(state.platformPaid).toBe("20");
    expect(state.memberPaid.get("m1")).toBe("20");
  });
});

describe("Allocate.applyBudgetGuard 边界", () => {
  const CFG = { totalBudget: "10", eventValue: "100" };

  test("空输入 / 缺配置一律原样返回（不改金额、不抛错）", () => {
    expect(Allocate.applyBudgetGuard([], CFG)).toEqual([]);
    expect(Allocate.applyBudgetGuard(null, CFG)).toBeNull();
    const recs = [{ nodeId: "n1", amount: "5" }];
    expect(Allocate.applyBudgetGuard(recs, null)).toBe(recs);
    expect(Allocate.applyBudgetGuard(recs, { eventValue: "100" })).toBe(recs);
    expect(Allocate.applyBudgetGuard(recs, { totalBudget: "10" })).toBe(recs);
  });

  test("缺 amount 的记录按 0 计入总额，不会污染裁剪比例", () => {
    // 未超发：原样返回。
    const under = Allocate.applyBudgetGuard([{ nodeId: "a" }, { nodeId: "b", amount: "5" }], CFG);
    expect(under.map((r) => r.amount)).toEqual([undefined, "5"]);
    // 超发裁剪：缺 amount 的那条裁成 "0"，另一条吃满整个预算上限。
    const over = Allocate.applyBudgetGuard([{ nodeId: "a" }, { nodeId: "b", amount: "20" }], CFG);
    expect(over.map((r) => r.amount)).toEqual(["0", "10"]);
    expect(over[1].snapshot.overBudget.originalAmount).toBe("20");
  });

  test("onExceed=WARN：context 已有告警数组时追加而非覆盖", () => {
    const context = { overBudgetWarnings: [{ pre: true }] };
    const out = Allocate.applyBudgetGuard(
      [{ nodeId: "a", amount: "50" }],
      { ...CFG, onExceed: "WARN" },
      context
    );
    expect(out.map((r) => r.amount)).toEqual(["50"]); // WARN 不裁剪
    expect(context.overBudgetWarnings).toHaveLength(2);
    expect(context.overBudgetWarnings[0]).toEqual({ pre: true });
    expect(context.overBudgetWarnings[1]).toMatchObject({
      totalAmount: "50",
      budgetLimit: "10",
      overAmount: "40",
      recordCount: 1,
    });
  });

  test("未知 onExceed 抛错（不静默按 CAP 或放行处理）", () => {
    expect(() => Allocate.applyBudgetGuard([{ nodeId: "a", amount: "50" }], { ...CFG, onExceed: "XX" }))
      .toThrow(/未知 onExceed 值: "XX"/);
  });
});

// ====================== 11. executePipeline 缺省与守卫分叉 ======================

describe("Orchestrate.executePipeline 缺省与守卫分叉", () => {
  const DIST = {
    id: "d",
    handler: "DISTRIBUTE",
    config: {
      event: { eventValue: "100", sourceNodeId: "n1" },
      targetNode: { nodeId: "n1", rankRate: "10" },
      rewardDefs: [{ rewardId: "x", type: "DIRECT", target: "SOURCE", rate: "10", skipRankZero: false }],
    },
  };

  test("stages 缺省为空数组：不抛错、final 为 null", () => {
    const out = Orchestrate.executePipeline({});
    expect(out.results).toEqual({});
    expect(out.final).toBeNull();
  });

  test("DISTRIBUTE 缺 rewardDefs：产出空数组而非抛错（无奖励项 = 不发放）", () => {
    const out = Orchestrate.executePipeline({
      stages: [{ id: "d", handler: "DISTRIBUTE", config: { event: { eventValue: "100" }, targetNode: { nodeId: "n1", rankRate: "10" } } }],
    });
    expect(out.final).toEqual([]);
  });

  test("RANK 缺 nodes / rankDefs：空转不抛错，输出仍是空数组", () => {
    const out = Orchestrate.executePipeline({ stages: [{ id: "r", handler: "RANK", config: {} }] });
    expect(out.results.r).toEqual([]);
    expect(out.final).toEqual([]);
  });

  test("RANK：rankDefs 缺 levelIndex 按 0 排序；nodes 内非对象元素跳过；未命中等级写 \"0\"", () => {
    const nodes = [null, { nodeId: "n1", directCount: 5 }, { nodeId: "n2", directCount: 0 }];
    const rankDefs = [{
      rankRate: "8",
      conditions: [{ type: "COMPARE", source: "target", field: "directCount", operator: "GTE", value: "3" }],
    }];
    Orchestrate.executePipeline({ stages: [{ id: "r", handler: "RANK", config: { nodes, rankDefs } }] });
    expect(nodes[0]).toBeNull();
    expect(nodes[1].rankRate).toBe("8");
    expect(nodes[2].rankRate).toBe("8"); // 缺 levelIndex 的等级按 levelIndex=0 处理 → 无门槛等级
    expect(nodes[1].rankId).toBeUndefined(); // 等级未声明 rankId 时不写
  });

  test("RANK：未命中任何等级的节点 rankRate 置 \"0\"（最低等级，交给 skipRankZero 消费）", () => {
    const nodes = [{ nodeId: "n2", directCount: 0 }];
    Orchestrate.executePipeline({
      stages: [{
        id: "r",
        handler: "RANK",
        config: {
          nodes,
          rankDefs: [{
            levelIndex: 1,
            rankId: "V1",
            rankRate: "8",
            conditions: [{ type: "COMPARE", source: "target", field: "directCount", operator: "GTE", value: "3" }],
          }],
        },
      }],
    });
    expect(nodes[0].rankRate).toBe("0");
    expect(nodes[0].rankId).toBeUndefined();
  });

  test("一条流水线最多一个 REVERSE —— 首个 REVERSE 零产出也不放行第二个", () => {
    expect(() => Orchestrate.executePipeline({
      stages: [
        { id: "rv1", handler: "REVERSE", config: { originalRecords: [], ratio: "100" } },
        { id: "rv2", handler: "REVERSE", config: { originalRecords: [{ recordId: "r2", nodeId: "n1", amount: "10" }], ratio: "100" } },
      ],
    })).toThrow(/是本流水线第 2 个 REVERSE/);
  });

  test("CAP 缺 capDefs：不裁剪（无封顶配置）而非抛错", () => {
    const out = Orchestrate.executePipeline({ stages: [DIST, { id: "c", handler: "CAP", config: {} }] });
    expect(out.final.map((r) => r.amount)).toEqual(["10"]);
  });

  test("CAMPAIGN 缺 campaignDefs：金额不变且汇总标记零命中", () => {
    const out = Orchestrate.executePipeline({
      stages: [DIST, { id: "cp", handler: "CAMPAIGN", config: { occurredAt: new Date("2026-08-20T00:00:00Z") } }],
    });
    expect(out.final.map((r) => r.amount)).toEqual(["10"]);
    expect(out.context.campaignSummary).toMatchObject({
      activeCampaignIds: [],
      boostedCount: 0,
      untouchedCount: 1,
      totalBefore: "10",
      totalAfter: "10",
    });
  });

  test("SPLIT 未写 id 时报错信息回退用 handler 名定位，并列出后续阶段", () => {
    expect(() => Orchestrate.executePipeline({
      stages: [
        { handler: "SPLIT", config: { totalAmount: "100", targets: [{ nodeId: "a", ratio: "100" }] } },
        { handler: "CAP", config: {} },
      ],
    })).toThrow(/SPLIT 阶段 "SPLIT" 后还有 1 个阶段（CAP）/);
  });
});
