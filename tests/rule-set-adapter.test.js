/**
 * @usethink/incentive-engine rule-set-adapter 单元测试
 *
 * 覆盖 buildPipelineStages 的 4 种 handler 分支（DISTRIBUTE / CAP / OVER / 透传）
 * 以及缺省流水线、自定义 pipelineDef、空 rewardDefs/capDefs 等边界场景。
 *
 * @version 1.0.0
 */

const { buildPipelineStages } = require("../src/adapters/rule-set-adapter");

// ===================== 辅助 =====================

const mockEvent = { sourceNodeId: "u1", eventType: "purchase", eventValue: "1000" };
const mockDirectParent = { id: "u0", rankRate: "10" };
const mockAncestors = [{ id: "u0", rankRate: "10" }];
const defaultRewardDefs = [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }];
const defaultCapDefs = [{ capId: "daily", scope: "PLATFORM_DAILY", limit: "10000" }];

function makeInput(overrides = {}) {
  return { event: mockEvent, directParent: mockDirectParent, ancestors: mockAncestors, ...overrides };
}

// ===================== 测试 =====================

describe("buildPipelineStages", () => {
  test("缺省流水线：DISTRIBUTE → CAP", () => {
    const stages = buildPipelineStages(
      { rewardDefs: defaultRewardDefs, capDefs: defaultCapDefs },
      makeInput()
    );
    expect(stages).toHaveLength(2);
    expect(stages[0].handler).toBe("DISTRIBUTE");
    expect(stages[1].handler).toBe("CAP");
  });

  test("DISTRIBUTE 阶段装配正确", () => {
    const stages = buildPipelineStages(
      { rewardDefs: defaultRewardDefs, capDefs: defaultCapDefs },
      makeInput()
    );
    const distStage = stages[0];
    expect(distStage.id).toBe("distribute");
    expect(distStage.config.event).toBe(mockEvent);
    expect(distStage.config.directParent).toBe(mockDirectParent);
    expect(distStage.config.ancestors).toBe(mockAncestors);
    expect(distStage.config.rewardDefs).toBe(defaultRewardDefs);
  });

  test("CAP 阶段装配正确", () => {
    const stages = buildPipelineStages(
      { rewardDefs: defaultRewardDefs, capDefs: defaultCapDefs },
      makeInput()
    );
    const capStage = stages[1];
    expect(capStage.id).toBe("cap");
    expect(capStage.config.capDefs).toBe(defaultCapDefs);
  });

  test("OVER 阶段注入 eventValue", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        pipelineDef: {
          stages: [
            { handler: "DISTRIBUTE" },
            { handler: "OVER", config: { totalBudget: "5000", onExceed: "CAP" } },
          ],
        },
      },
      makeInput()
    );
    expect(stages).toHaveLength(2);
    const overStage = stages[1];
    expect(overStage.handler).toBe("OVER");
    expect(overStage.config.eventValue).toBe("1000");
    expect(overStage.config.totalBudget).toBe("5000");
    expect(overStage.config.onExceed).toBe("CAP");
  });

  test("OVER 阶段缺省 config 使用默认值", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        pipelineDef: { stages: [{ handler: "OVER" }] },
      },
      makeInput()
    );
    const overStage = stages[0];
    expect(overStage.config.totalBudget).toBe("100");
    expect(overStage.config.onExceed).toBe("CAP");
  });

  test("自定义 pipelineDef 覆盖默认流水线", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        pipelineDef: {
          stages: [
            { id: "pre-check", handler: "OVER" },
            { handler: "DISTRIBUTE" },
            { handler: "CAP" },
            { handler: "OVER", config: { totalBudget: "8000", onExceed: "WARN" } },
          ],
        },
      },
      makeInput()
    );
    expect(stages).toHaveLength(4);
    expect(stages[0].id).toBe("pre-check");
    expect(stages[0].handler).toBe("OVER");
    expect(stages[3].handler).toBe("OVER");
    expect(stages[3].config.totalBudget).toBe("8000");
  });

  test("空 rewardDefs/capDefs 时仍能创建阶段", () => {
    const stages = buildPipelineStages(
      { rewardDefs: [], capDefs: [] },
      makeInput()
    );
    expect(stages).toHaveLength(2);
    expect(stages[0].config.rewardDefs).toEqual([]);
    expect(stages[1].config.capDefs).toEqual([]);
  });

  test("未知 handler 透传", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        pipelineDef: {
          stages: [
            { handler: "DISTRIBUTE" },
            { handler: "CUSTOM_HANDLER", config: { some: "value" } },
            { handler: "CAP" },
          ],
        },
      },
      makeInput()
    );
    expect(stages).toHaveLength(3);
    // 未知 handler 原样透传
    expect(stages[1].handler).toBe("CUSTOM_HANDLER");
    expect(stages[1].config.some).toBe("value");
  });

  test("SPLIT handler 显式处理并规范化 id/config", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        pipelineDef: {
          stages: [
            { handler: "SPLIT", config: { strategy: "even" } },
          ],
        },
      },
      makeInput()
    );
    expect(stages[0].handler).toBe("SPLIT");
    expect(stages[0].id).toBe("split");
    expect(stages[0].config.strategy).toBe("even");
  });

  test("SPLIT handler 无 config 时使用空对象", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        pipelineDef: { stages: [{ handler: "SPLIT" }] },
      },
      makeInput()
    );
    expect(stages[0].handler).toBe("SPLIT");
    expect(stages[0].config).toEqual({});
  });

  test("belnd 模式：使用 stage.id 自定义", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        pipelineDef: {
          stages: [
            { id: "distribute-phase1", handler: "DISTRIBUTE" },
            { id: "distribute-phase2", handler: "DISTRIBUTE" },
          ],
        },
      },
      makeInput()
    );
    expect(stages[0].id).toBe("distribute-phase1");
    expect(stages[1].id).toBe("distribute-phase2");
    // 每个 DISTRIBUTE 阶段都获得完整的 config
    expect(stages[0].config.rewardDefs).toBe(defaultRewardDefs);
    expect(stages[1].config.rewardDefs).toBe(defaultRewardDefs);
  });

  const rankDefs = [
    { rankId: "V0", levelIndex: 0, rankRate: "0", conditions: [] },
    { rankId: "V1", levelIndex: 1, rankRate: "15", conditions: [{ field: "directCount", operator: "GTE", value: 3 }] },
    { rankId: "V3", levelIndex: 3, rankRate: "30", conditions: [{ field: "directCount", operator: "GTE", value: 10 }] },
  ];

  test("RANK 阶段装配：注入 rankDefs 并默认评估 directParent+ancestors（按 id 去重）", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        capDefs: defaultCapDefs,
        rankDefs,
        pipelineDef: { stages: [{ handler: "RANK" }, { handler: "DISTRIBUTE" }, { handler: "CAP" }] },
      },
      makeInput() // directParent u0 + ancestors [u0] → 同 id 去重为 1 个
    );
    expect(stages[0].handler).toBe("RANK");
    expect(stages[0].id).toBe("rank");
    expect(stages[0].config.rankDefs).toBe(rankDefs);
    expect(stages[0].config.nodes).toHaveLength(1);
    expect(stages[0].config.nodes[0].id).toBe("u0");
    expect(stages[0].config.overwrite).toBe(false);
  });

  test("RANK 阶段：explicit nodes 覆盖默认，overwrite 透传", () => {
    const extraNode = { id: "uExt", directCount: 5 };
    const stages = buildPipelineStages(
      {
        rewardDefs: defaultRewardDefs,
        rankDefs,
        pipelineDef: { stages: [{ handler: "RANK", config: { nodes: [extraNode], overwrite: true } }] },
      },
      makeInput()
    );
    expect(stages[0].config.nodes).toEqual([extraNode]);
    expect(stages[0].config.overwrite).toBe(true);
  });

  test("RANK 阶段：directParent 为空时仅评估 ancestors", () => {
    const stages = buildPipelineStages(
      {
        rewardDefs: [],
        capDefs: [],
        rankDefs,
        pipelineDef: { stages: [{ handler: "RANK" }] },
      },
      makeInput({ directParent: null, ancestors: [{ id: "a1" }, { id: "a2" }, { id: "a1" }] })
    );
    // 去空 + 按 id 去重：a1(重复)、a2 → 2 个
    expect(stages[0].config.nodes).toHaveLength(2);
  });
});