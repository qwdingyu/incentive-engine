/**
 * 等级定义 — 纯数据容器
 *
 * 从 VipTier 模型映射而来，用于引擎等级评估。
 * v2.0.0 泛化：评估以 conditions 条件列表（COMPARE 数组，field/operator/value）为准，
 * 引擎不解释具体业务字段。旧的 min_direct_count / min_team_performance /
 * min_higher_tier_count / required_higher_tier 保留在 metadata 中（兼容与审计），
 * 由适配层 tierToRankDef 同时翻译为 conditions。
 * v2.1.1 清理：移除 teamBonusPct 字段（v2.0.0 条件驱动后无任何消费者；
 * 链式差额的 rankRate 由适配层从业务数据映射到节点，不再经等级定义携带）。
 *
 * @version 2.1.1
 */
class RankDef {
  /**
   * @param {Object} params
   * @param {number|string} params.id - VipTier 主键 ID
   * @param {number} params.levelIndex - 等级索引（0-based）
   * @param {string} params.rankId - 等级标识（如 'V0', 'V1'）
   * @param {Array} [params.conditions] - 晋升条件列表（COMPARE 数组）
   * @param {Object} params.metadata - 扩展元数据
   */
  constructor({ id, levelIndex = 0, rankId = "V0", conditions = [], metadata = {} }) {
    this.id = id;
    this.levelIndex = levelIndex;
    this.rankId = rankId;
    this.conditions = conditions;
    this.metadata = metadata;
  }
}

module.exports = { RankDef };
