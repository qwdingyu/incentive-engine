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
  const node = new engine.Model.EngineNode({
    id: member.id,
    parentId: member.parentId || null,
    rankId: member.rank || "DEFAULT",
    attrs: {
      directCount: member.directCount || 0,
      teamPerformance: member.teamPerformance || "0",
      ...(member.rankRate !== undefined ? { rankRate: member.rankRate } : {}),
    },
  });
  // P1-3 修复：EngineNode 构造器不接受顶层 rankRate，需构造后手动赋值。
  // rankRate 是引擎 DIRECT/LEVEL 消费的顶层字段（direct-calculator._isRankZero
  // 只读 node.rankRate，不看 attrs 回退）。原实现丢弃 rankRate 导致全链按 0 处理，
  // 叠加 skipRankZero 默认 true 后零发放。
  //
  // 关键：业务对象【没有】rankRate 时必须保持 node.rankRate 为 undefined，
  // 不能兜底写 "0"。RANK 阶段用 `node.rankRate !== undefined` 判断「宿主是否已预计算」，
  // 写死 "0" 会被当作预计算值而跳过等级评估 —— 节点永远停在最低等级、
  // skipRankZero 默认 true 直接零发放（静默，无任何报错）。
  // undefined 时 _isRankZero 仍安全回退为 0（少发不超发），二者不冲突。
  const rankRate = member.rankRate ?? member.attrs?.rankRate;
  if (rankRate !== undefined && rankRate !== null) {
    node.rankRate = String(rankRate);
  }
  return node;
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
      // P1-3 修复：透传 rankRate（等级关联的分成比例）。
      // 原实现丢弃 rankRate 导致一律 "0"，叠加 skipRankZero 默认 true 后全链零发放。
      rankRate: cfg.rankRate ?? "0",
      conditions,
      metadata: { ...cfg },
    });
  });
}

/** 从业务配置构建奖励定义列表 */
function _buildRewardDefs(rewardConfigs) {
  return (rewardConfigs || []).map((cfg, index) => new engine.Model.RewardDef({
    // P1-3 修复：用 rewardId 而非 id —— RewardDef 的落库标识字段是 rewardId，
    // 原实现传 id 导致 rewardId: undefined，落库后无法区分奖励类型、无法对账。
    rewardId: cfg.rewardId ?? cfg.id ?? `reward-${index}`,
    type: cfg.type || "DIRECT",
    rate: cfg.rate || "0",
    // P1-3 修复：accumulateInChain 缺省应为 false（与 RewardDef 缺省一致）。
    // 原实现 `cfg.accumulateInChain !== false` 使缺省为 true，会把「多级固定比例」
    // 意外变成「极差」（只有 L1 拿到钱）。改为显式 true 才开启链式水位累加。
    accumulateInChain: cfg.accumulateInChain === true,
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
  // P1-3 修复：rankDefs 必须与 rewardDefs/capDefs 一样做「顶层优先、config_json 回退」的
  // 双形态归一。原实现只归一了 rewardDefs/capDefs，rankDefs 仅依赖对 config_json 的展开 ——
  // 当规则集是标准形态（config_json 内只有 pipelineDef、rankDefs 挂在顶层）时 rankDefs 全丢，
  // RANK 阶段拿到空等级表 → 节点 rankRate 恒为 0 → skipRankZero 默认 true → 零发放（静默）。
  const ruleSetConfig = {
    ...(ruleSet.config_json || ruleSet),
    rewardDefs: ruleSet.rewardDefs || ruleSet.config_json?.rewardDefs || [],
    rankDefs: ruleSet.rankDefs || ruleSet.config_json?.rankDefs || [],
    capDefs: ruleSet.capDefs || ruleSet.config_json?.capDefs || [],
  };
  const stages = buildPipelineStages(ruleSetConfig, {
    event: engineEvent,
    directParent: directParentNode,
    ancestors: ancestorNodes,
  });

  // capState 缺省时不要写入 context.capState: undefined —— 让 CAP 阶段走自己的零水位默认值，
  // 避免下游用 `"capState" in context` 判断时误认为宿主传了水位。
  const context = capState ? { capState } : {};
  return engine.Orchestrate.executePipeline({ stages, context });
}

module.exports = {
  CUSTOMER_NAME, CUSTOMER_VERSION,
  _mapMemberToNode, _mapEvent, _buildRankDefs, _buildRewardDefs,
  executeCustomerIncentive,
};
