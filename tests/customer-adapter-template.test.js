/**
 * @usethink/incentive-engine customerAdapterTemplate 测试
 *
 * 覆盖 P1-3 修复：官方接入模板的三个缺陷
 * - _buildRewardDefs 产出 rewardId（原实现传 id → rewardId: undefined）
 * - _buildRewardDefs 的 accumulateInChain 缺省 false（原实现缺省 true → 多级固定比例被极差化）
 * - _buildRankDefs 透传 rankRate（原实现丢弃 → 叠加 skipRankZero 全链零发放）
 *
 * 并验证 README「扩展指南」的完整示例现在能跑出非空结果（原实现 final = []）。
 *
 * @version 1.0.0
 */

const template = require("../src/adapters/customer-adapter-template");
const {
  _mapMemberToNode,
  _mapEvent,
  _buildRankDefs,
  _buildRewardDefs,
  executeCustomerIncentive,
} = template;

describe("customerAdapterTemplate（P1-3 修复）", () => {
  describe("_buildRewardDefs", () => {
    test("产出 rewardId（不再 undefined，可落库/对账）", () => {
      const defs = _buildRewardDefs([{ type: "DIRECT", rate: "10", target: "PARENT" }]);
      expect(defs[0].rewardId).toBeDefined();
      // 缺省兜底：reward-<index>
      expect(defs[0].rewardId).toBe("reward-0");
    });

    test("优先使用显式 rewardId", () => {
      const defs = _buildRewardDefs([{ rewardId: "referral", type: "DIRECT", rate: "10" }]);
      expect(defs[0].rewardId).toBe("referral");
    });

    test("accumulateInChain 缺省为 false（与 RewardDef 缺省一致，不极差化）", () => {
      const defs = _buildRewardDefs([{ type: "LEVEL" }]);
      expect(defs[0].accumulateInChain).toBe(false);
    });

    test("只有显式 accumulateInChain: true 才开启链式水位累加", () => {
      const defs = _buildRewardDefs([{ type: "LEVEL", accumulateInChain: true }]);
      expect(defs[0].accumulateInChain).toBe(true);
    });
  });

  describe("_buildRankDefs", () => {
    test("透传 rankRate（不再一律 0）", () => {
      const defs = _buildRankDefs([{ name: "V1", levelIndex: 1, rankRate: "15", minDirectCount: 3 }]);
      expect(defs[0].rankRate).toBe("15");
      // 未配置 rankRate 时退化为 "0"（兼容）
      const defs2 = _buildRankDefs([{ name: "V0", levelIndex: 0 }]);
      expect(defs2[0].rankRate).toBe("0");
    });

    test("minDirectCount/minTeamPerformance 转换为 conditions", () => {
      const defs = _buildRankDefs([
        { name: "V1", levelIndex: 1, rankRate: "15", minDirectCount: 3, minTeamPerformance: "50000" },
      ]);
      expect(defs[0].conditions).toHaveLength(2);
      expect(defs[0].conditions[0]).toEqual({ type: "COMPARE", field: "directCount", operator: "GTE", value: 3 });
      expect(defs[0].conditions[1]).toEqual({ type: "COMPARE", field: "teamPerformance", operator: "GTE", value: "50000" });
    });
  });

  describe("_mapMemberToNode / _mapEvent", () => {
    test("映射节点含 attrs 里的等级条件字段", () => {
      const node = _mapMemberToNode({ id: "u1", parentId: "u0", directCount: 5, teamPerformance: "10000" });
      expect(node.id).toBe("u1");
      expect(node.parentId).toBe("u0");
      expect(node.attrs.directCount).toBe(5);
      expect(node.attrs.teamPerformance).toBe("10000");
    });

    test("映射事件", () => {
      const ev = _mapEvent({ id: "E1", memberId: "u1", type: "purchase", amount: "1000" });
      expect(ev.sourceNodeId).toBe("u1");
      expect(ev.eventType).toBe("purchase");
      expect(ev.eventValue).toBe("1000");
      expect(ev.attrs.memberId).toBe("u1");
    });
  });

  describe("README 扩展指南完整示例（P1-3：修复后跑出非空结果）", () => {
    test("一级分销 DIRECT/PARENT/10% 跑出非空结果", () => {
      const result = executeCustomerIncentive({
        event: { memberId: "user1", amount: "1000", type: "purchase" },
        directParent: { id: "user0", parentId: null, directCount: 10, teamPerformance: "50000", rankRate: "10" },
        ruleSet: {
          config_json: { pipelineDef: { stages: [{ handler: "DISTRIBUTE" }] } },
          rewardDefs: [{ rewardId: "referral", type: "DIRECT", rate: "10", target: "PARENT" }],
          rankDefs: [{ rankId: "V0", levelIndex: 0, rankRate: "0" }],
        },
      });
      const records = result.final || [];
      // 修复前：final = []（empty）。修复后：user0 拿到 1000×10% = 100。
      expect(records.length).toBeGreaterThan(0);
      expect(records[0].nodeId).toBe("user0");
      expect(records[0].rewardId).toBe("referral");
      expect(records[0].amount).toBe("100");
    });

    test("多级固定比例（LEVEL 10/5/3）不被极差化：L1/L2/L3 分别拿 100/50/30", () => {
      const result = executeCustomerIncentive({
        event: { memberId: "user1", amount: "1000", type: "purchase" },
        ancestors: [
          { id: "L1", rankRate: "10" },
          { id: "L2", rankRate: "5" },
          { id: "L3", rankRate: "3" },
        ],
        ruleSet: {
          config_json: { pipelineDef: { stages: [{ handler: "DISTRIBUTE" }] } },
          rewardDefs: [{ rewardId: "multi", type: "LEVEL" }],
          rankDefs: [],
        },
      });
      const records = result.final || [];
      // 修复前：accumulateInChain 缺省被模板硬编码为 true → 只有 L1 拿钱。
      // 修复后：缺省 false（链式水位不推进）→ 每层按自身比例全额领取。
      const byNode = Object.fromEntries(records.map((r) => [r.nodeId, r.amount]));
      expect(byNode).toEqual({ L1: "100", L2: "50", L3: "30" });
    });
  });

  describe("RANK 阶段可用性（P1-3 补充：rankDefs 透传 + rankRate 不写死 0）", () => {
    const RANK_DEFS = [
      { rankId: "V0", levelIndex: 0, rankRate: "0" },
      {
        rankId: "V1",
        levelIndex: 1,
        rankRate: "10",
        conditions: [{ type: "COMPARE", field: "directCount", operator: "GTE", value: 3 }],
      },
    ];
    const run = (stages, directParent) =>
      executeCustomerIncentive({
        event: { memberId: "u1", amount: "1000", type: "purchase" },
        directParent,
        ruleSet: {
          // 标准形态：config_json 只放 pipelineDef，rankDefs/rewardDefs 挂顶层
          config_json: { pipelineDef: { stages } },
          rewardDefs: [{ rewardId: "referral", type: "DIRECT", rate: "10", target: "PARENT" }],
          rankDefs: RANK_DEFS,
        },
      });

    test("rankDefs 从顶层归一后 RANK 阶段生效：达标节点自动获得 rankRate 并发放", () => {
      // 修复前两处缺陷叠加导致 final = []：
      // (1) ruleSetConfig 未归一 rankDefs → RANK 拿到空等级表
      // (2) _mapMemberToNode 兜底写 node.rankRate = "0" → RANK 误判「宿主已预计算」而跳过
      const records = run(
        [{ handler: "RANK" }, { handler: "DISTRIBUTE" }],
        { id: "p0", parentId: null, directCount: 10, teamPerformance: "50000" }
      ).final || [];
      expect(records.map((r) => [r.nodeId, r.amount])).toEqual([["p0", "100"]]);
    });

    test("不达标节点停在 V0（rankRate=0）→ skipRankZero 生效，零发放", () => {
      const records = run(
        [{ handler: "RANK" }, { handler: "DISTRIBUTE" }],
        { id: "p0", parentId: null, directCount: 1, teamPerformance: "0" }
      ).final || [];
      expect(records).toEqual([]);
    });

    test("宿主显式预计算的 rankRate 优先，RANK 默认不覆盖", () => {
      const node = _mapMemberToNode({ id: "p0", directCount: 10, rankRate: "10" });
      expect(node.rankRate).toBe("10");
      const records = run(
        [{ handler: "DISTRIBUTE" }],
        { id: "p0", parentId: null, directCount: 10, rankRate: "10" }
      ).final || [];
      expect(records.map((r) => [r.nodeId, r.amount])).toEqual([["p0", "100"]]);
    });

    test("业务对象无 rankRate 时节点不带该字段（留给 RANK 评估）", () => {
      const node = _mapMemberToNode({ id: "p0", directCount: 10 });
      expect(node.rankRate).toBeUndefined();
    });

    test("既无 RANK 阶段也无预计算 rankRate → fail-safe 少发（[] 而非顶格发放）", () => {
      const records = run(
        [{ handler: "DISTRIBUTE" }],
        { id: "p0", parentId: null, directCount: 10, teamPerformance: "50000" }
      ).final || [];
      expect(records).toEqual([]);
    });
  });
});