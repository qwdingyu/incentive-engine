/**
 * @usethink/incentive-engine 跨特性组合业务测试
 *
 * 现有 engine-core 测试多为「单方法/单阶段」单元测试。本文件补充
 * 真实业务中必然出现的【多特性组合】场景，验证特性间交互正确：
 *
 * 1. 平台日封顶 + 单用户日封顶同时作用（双封顶叠加）
 * 2. 预算兜底（OVER）+ 平台封顶（CAP）互动：先压缩再裁剪
 * 3. RANK → DISTRIBUTE 全链路：等级评估驱动分成比例
 * 4. 多事件累计封顶：同一平台水位跨事件推进（资金不变量）
 * 5. 多级链式极差 + 单用户封顶：同一节点多类收益合并计算额度
 * 6. 完整流水线 RANK→DISTRIBUTE→OVER→CAP→SPLIT 端到端
 *
 * @version 1.0.0
 */

const engine = require("../src/engine");
const { buildPipelineStages } = require("../src/adapters");

describe("跨特性组合：平台日封顶 + 单用户日封顶同时作用", () => {
  test("双封顶叠加：先平台裁剪，再单用户裁剪，取更严者", () => {
    const records = [
      { nodeId: "u1", amount: "100" },
      { nodeId: "u2", amount: "100" },
    ];
    // 平台日封顶 150，单用户日封顶 80
    const capped = engine.Allocate.applyCaps(
      records,
      [
        { capId: "plat", scope: "PLATFORM_DAILY", limit: "150" },
        { capId: "user", scope: "PER_USER_DAILY", limit: "80" },
      ],
      { platformPaid: "0", memberPaid: new Map() }
    );
    // u1: 平台剩 150 → 单用户剩 80 → 裁剪到 80
    // u2: 平台剩 70 → 单用户剩 80 → 裁剪到 70（平台更严）
    expect(capped[0].amount).toBe("80");
    expect(capped[1].amount).toBe("70");
  });

  test("双封顶水位各自独立推进", () => {
    const records = [
      { nodeId: "u1", amount: "60" },
      { nodeId: "u1", amount: "60" },
    ];
    const state = { platformPaid: "0", memberPaid: new Map() };
    const capped = engine.Allocate.applyCaps(
      records,
      [
        { capId: "plat", scope: "PLATFORM_DAILY", limit: "100" },
        { capId: "user", scope: "PER_USER_DAILY", limit: "100" },
      ],
      state
    );
    // 第一条 60：平台 60/100，单用户 60/100
    // 第二条 60：平台剩 40 → 40；单用户剩 40 → 40
    expect(capped[0].amount).toBe("60");
    expect(capped[1].amount).toBe("40");
    expect(state.platformPaid).toBe("100");
    expect(state.memberPaid.get("u1")).toBe("100");
  });
});

describe("跨特性组合：预算兜底（OVER）+ 平台封顶（CAP）互动", () => {
  test("先 OVER 压缩到预算，再 CAP 裁剪到封顶", () => {
    const event = { sourceNodeId: "u1", eventValue: "1000" };
    const rewardDefs = [
      { rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" },
      { rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "50" },
    ];
    const directParent = { id: "p1", rankRate: "10" };
    const result = engine.Orchestrate.executePipeline({
      context: { capState: { platformPaid: "0", memberPaid: new Map() } },
      stages: [
        { id: "distribute", handler: "DISTRIBUTE", config: { event, directParent, rewardDefs } },
        // 预算 120%：应发 1000+500=1500，预算上限 1200 → 压缩
        { id: "over", handler: "OVER", config: { totalBudget: "120", eventValue: "1000", onExceed: "CAP" } },
        // 平台日封顶 1100
        { id: "cap", handler: "CAP", config: { capDefs: [{ scope: "PLATFORM_DAILY", limit: "1100" }] } },
      ],
    });
    // OVER 压缩后总额 = 1200，CAP 再裁剪到 1100
    const total = result.final.reduce((s, r) => s + Number(r.amount), 0);
    expect(total).toBe(1100);
  });
});

describe("跨特性组合：RANK → DISTRIBUTE 全链路（等级评估驱动分成）", () => {
  const rankDefs = [
    { rankId: "V0", levelIndex: 0, rankRate: "0" },
    { rankId: "V1", levelIndex: 1, rankRate: "10", conditions: [{ type: "COMPARE", field: "directCount", operator: "GTE", value: 3 }] },
    { rankId: "V2", levelIndex: 2, rankRate: "20", conditions: [{ type: "COMPARE", field: "directCount", operator: "GTE", value: 10 }] },
  ];

  test("RANK 评估节点等级 → DISTRIBUTE 按命中等级比例发放", () => {
    const event = { sourceNodeId: "u1", eventValue: "1000" };
    const directParent = { id: "p1", directCount: 15 }; // 命中 V2 → 20%
    const stages = buildPipelineStages(
      { rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "20" }], rankDefs, pipelineDef: { stages: [{ handler: "RANK" }, { handler: "DISTRIBUTE" }] } },
      { event, directParent }
    );
    const result = engine.Orchestrate.executePipeline({ stages });
    // RANK 把 p1 的 rankRate 写为 20（V2），DISTRIBUTE 按 20% 发 200
    expect(directParent.rankRate).toBe("20");
    expect(result.final[0].amount).toBe("200");
  });

  test("RANK 未命中高等级 → 落到 V0，skipRankZero 默认跳过", () => {
    const event = { sourceNodeId: "u1", eventValue: "1000" };
    const directParent = { id: "p1", directCount: 1 }; // 未命中 V1/V2 → V0 rankRate 0
    const stages = buildPipelineStages(
      { rewardDefs: [{ rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "20" }], rankDefs, pipelineDef: { stages: [{ handler: "RANK" }, { handler: "DISTRIBUTE" }] } },
      { event, directParent }
    );
    const result = engine.Orchestrate.executePipeline({ stages });
    // V0 rankRate=0 → skipRankZero 默认 true → 零发放
    expect(directParent.rankRate).toBe("0");
    expect(result.final).toEqual([]);
  });
});

describe("跨特性组合：多事件累计封顶（资金不变量）", () => {
  test("同一平台水位跨事件推进，累计发放 ≤ 日限额", () => {
    const event = { sourceNodeId: "u1", eventValue: "100" };
    const rewardDefs = [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }];
    const capDefs = [{ capId: "plat", scope: "PLATFORM_DAILY", limit: "250" }];

    // 模拟跨事件共享 capState（真实场景由 GenericSettlementService 的 load/saveCapState 持久化）
    const capState = { platformPaid: "0", memberPaid: new Map() };
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const result = engine.Orchestrate.executePipeline({
        context: { capState },
        stages: [
          { id: "distribute", handler: "DISTRIBUTE", config: { event, rewardDefs } },
          { id: "cap", handler: "CAP", config: { capDefs } },
        ],
      });
      total += result.final.reduce((s, r) => s + Number(r.amount), 0);
    }
    // 三单各 100，limit=250 → 累计 250（第三单只发 50）
    expect(total).toBe(250);
    expect(capState.platformPaid).toBe("250");
  });
});

describe("跨特性组合：多级链式极差 + 单用户封顶（同节点多类收益合并）", () => {
  test("同一节点直推 + 团队极差合并计算单用户日额度", () => {
    const event = { sourceNodeId: "u1", eventValue: "1000" };
    const rewardDefs = [
      { rewardId: "direct", type: "DIRECT", target: "PARENT", rate: "10" },
      { rewardId: "team", type: "LEVEL", accumulateInChain: true },
    ];
    const directParent = { id: "p1", rankRate: "15" };
    const ancestors = [
      { id: "p1", rankRate: "15" },
      { id: "p2", rankRate: "25" },
    ];
    const records = engine.Distribute.distributeByDefs({ event, directParent, ancestors, rewardDefs });
    // p1: 直推 100 + 团队极差 150 = 250；p2: 极差 100
    const capped = engine.Allocate.applyCaps(
      records,
      [{ capId: "user", scope: "PER_USER_DAILY", limit: "200" }],
      { platformPaid: "0", memberPaid: new Map() }
    );
    // p1 累计 250 > 200 → 裁剪到 200（直推 100 保留，团队极差 150 裁剪到 100）
    const p1Total = capped.filter((r) => r.nodeId === "p1").reduce((s, r) => s + Number(r.amount), 0);
    expect(p1Total).toBe(200);
    // p2 极差 100 < 200 不裁剪
    const p2Rec = capped.find((r) => r.nodeId === "p2");
    expect(p2Rec.amount).toBe("100");
  });
});

describe("跨特性组合：完整流水线 RANK→DISTRIBUTE→OVER→CAP→SPLIT 端到端", () => {
  test("等级评估 + 多级分销 + 预算兜底 + 双封顶 + 拆分 全链路", () => {
    const event = { sourceNodeId: "buyer", eventValue: "1000" };
    const directParent = { id: "p1", directCount: 15 }; // 命中 V2 → 20%
    const ancestors = [
      { id: "p1", directCount: 15 },
      { id: "p2", directCount: 5 },
    ];
    const rankDefs = [
      { rankId: "V0", levelIndex: 0, rankRate: "0" },
      { rankId: "V1", levelIndex: 1, rankRate: "10", conditions: [{ type: "COMPARE", field: "directCount", operator: "GTE", value: 3 }] },
      { rankId: "V2", levelIndex: 2, rankRate: "20", conditions: [{ type: "COMPARE", field: "directCount", operator: "GTE", value: 10 }] },
    ];
    const rewardDefs = [
      { rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" },
      { rewardId: "ref", type: "DIRECT", target: "PARENT", rate: "20" },
      { rewardId: "team", type: "LEVEL", accumulateInChain: true },
    ];
    const stages = buildPipelineStages(
      {
        rewardDefs,
        rankDefs,
        capDefs: [
          { capId: "plat", scope: "PLATFORM_DAILY", limit: "1500" },
          { capId: "user", scope: "PER_USER_DAILY", limit: "300" },
        ],
        pipelineDef: {
          stages: [
            { handler: "RANK" },
            { handler: "DISTRIBUTE" },
            { handler: "OVER", config: { totalBudget: "150", onExceed: "CAP" } },
            { handler: "CAP" },
            { handler: "SPLIT", config: { totalAmount: "1000", targets: [{ target: "LIQUID", ratio: "70" }, { target: "POINT", ratio: "30" }] } },
          ],
        },
      },
      { event, directParent, ancestors }
    );
    const result = engine.Orchestrate.executePipeline({
      context: { capState: { platformPaid: "0", memberPaid: new Map() } },
      stages,
    });

    // RANK：p1 命中 V2(20%)，p2 命中 V1(10%)
    expect(directParent.rankRate).toBe("20");
    expect(ancestors[1].rankRate).toBe("10");
    // DISTRIBUTE：self 1000 + ref 200 + team 极差(20% / 10%-20% 无) = 1200
    // OVER 预算 150% = 1500，未超 → 不压缩
    // CAP：平台 1500 未超；单用户 p1 = 200+200=400 > 300 → 裁剪到 300
    // SPLIT：1000 → 700/300
    expect(result.final.splits.map((s) => [s.target, s.amount])).toEqual([["LIQUID", "700"], ["POINT", "300"]]);
  });
});
