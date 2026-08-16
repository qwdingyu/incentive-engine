/**
 * 客户适配器模板 — 新客户接入引擎的参考实现
 *
 * 用途：帮助新客户在 ≤ 200 行代码内完成引擎适配，快速接入激励计算。
 *
 * 接入步骤（推荐使用 GenericSettlementService）：
 * 1. 在 customer-configs/ 目录下创建客户配置对象（纯数据对象，非类）
 * 2. 使用 GenericSettlementService 的 settle() 方法一键完成计算 + 落账
 * 3. 或对于纯计算场景（无需 DB），直接调用 engine.Orchestrate.executePipeline()
 *
 * 引擎核心不依赖任何业务实体，适配器负责：
 * - 将业务数据映射为引擎通用原语（Node / Event / RankDef / RewardDef）
 * - 将引擎计算结果映射回业务动作（落账、发奖、通知）
 *
 * @version 2.0.0 (模板)
 */

const engine = require("../engine");
const { buildPipelineStages } = require("./rule-set-adapter");

// ============================================================
// 1. 客户配置（接入时修改）
// ============================================================
const CUSTOMER_NAME = "客户名称";
const CUSTOMER_VERSION = "2.0.0";

// ============================================================
// 2. 映射函数（接入时实现）
// ============================================================

/** 将业务会员对象映射为引擎节点 */
function _mapMemberToNode(member) {
  return new engine.Model.EngineNode({
    id: member.id,
    parentId: member.parentId || null,
    rankId: member.rank || "DEFAULT",
    attrs: {
      directCount: member.directCount || 0,
      teamPerformance: member.teamPerformance || "0",
    },
  });
}

/** 将业务事件映射为引擎事件 */
function _mapEvent(bizEvent) {
  return new engine.Model.EngineEvent({
    eventId: bizEvent.id || String(Date.now()),
    sourceNodeId: bizEvent.memberId,
    eventType: bizEvent.type || "DEFAULT",
    eventValue: bizEvent.amount || "0",
    attrs: bizEvent,
  });
}

/** 从业务配置构建等级定义列表 */
function _buildRankDefs(tierConfigs) {
  return (tierConfigs || []).map((cfg, index) => {
    const conditions = [];
    if (cfg.minDirectCount > 0) {
      conditions.push({ type: "COMPARE", field: "directCount", operator: "GTE", value: cfg.minDirectCount });
    }
    if (Number(cfg.minTeamPerformance) > 0) {
      conditions.push({ type: "COMPARE", field: "teamPerformance", operator: "GTE", value: String(cfg.minTeamPerformance) });
    }
    return new engine.Model.RankDef({
      id: cfg.id || index,
      levelIndex: cfg.levelIndex ?? index,
      rankId: cfg.name || `Level${index}`,
      conditions,
      metadata: { ...cfg },
    });
  });
}

/** 从业务配置构建奖励定义列表 */
function _buildRewardDefs(rewardConfigs) {
  return (rewardConfigs || []).map((cfg, index) => new engine.Model.RewardDef({
    id: cfg.id || index,
    type: cfg.type || "DIRECT",
    rate: cfg.rate || "0",
    accumulateInChain: cfg.accumulateInChain !== false,
    skipRankZero: cfg.skipRankZero !== false,
    metadata: { ...cfg },
  }));
}

// ============================================================
// 3. 主入口 — 执行引擎计算（纯计算，无 DB 落账）
// ============================================================

/**
 * 执行激励计算（纯计算路径）
 *
 * 适用于不需要 DB 落账的纯计算场景（如预览、试算）。
 * 如需完整「计算 + 幂等落账」，参见 GenericSettlementService。
 *
 * @param {Object} params
 * @param {Object} params.event - 业务事件
 * @param {Object} [params.directParent] - 直接上级（可选）
 * @param {Array<Object>} [params.ancestors] - 祖先链（可选，用于 LEVEL）
 * @param {Object} params.ruleSet - 规则集对象（含 config_json, rewardDefs, rankDefs, capDefs）
 * @param {Object} [params.capState] - 外部封顶水位（可选）
 * @returns {Object} 引擎计算结果 { final, context? }
 */
function executeCustomerIncentive({ event, directParent, ancestors, ruleSet, capState }) {
  const engineEvent = _mapEvent(event);
  const directParentNode = directParent ? _mapMemberToNode(directParent) : null;
  const ancestorNodes = (ancestors || []).map(_mapMemberToNode);

  // 使用 buildPipelineStages 将规则集配置一键转为引擎流水线阶段
  // 兼容两种数据格式：
  // - 标准：ruleSet = { config_json: { rewardDefs, capDefs, pipelineDef }, rewardDefs, capDefs }
  // - 直接：ruleSet = { rewardDefs, capDefs, pipelineDef }
  const ruleSetConfig = {
    ...(ruleSet.config_json || ruleSet),
    rewardDefs: ruleSet.rewardDefs || ruleSet.config_json?.rewardDefs || [],
    capDefs: ruleSet.capDefs || ruleSet.config_json?.capDefs || [],
  };
  const stages = buildPipelineStages(ruleSetConfig, {
    event: engineEvent,
    directParent: directParentNode,
    ancestors: ancestorNodes,
  });

  const result = engine.Orchestrate.executePipeline({ stages, context: { capState } });
  return result;
}

module.exports = {
  CUSTOMER_NAME, CUSTOMER_VERSION,
  _mapMemberToNode, _mapEvent, _buildRankDefs, _buildRewardDefs,
  executeCustomerIncentive,
};
