/**
 * 奖励定义 — 通用领域模型（纯数据容器，无方法，无外部依赖）
 *
 * 描述"怎么分"：一条奖励规则 = 类型 + 比例 + 适用对象 + 链式行为。
 * 引擎遍历 rewardDefs 列表驱动分配，不认识任何业务词（直推/极差是
 * 上层把业务规则翻译成 DIRECT/LEVEL 配置后的结果）。
 *
 * 类型语义（引擎实现）：
 * - DIRECT：按 eventValue × rate 分配给指定 target（SOURCE=事件来源节点自身；
 *   PARENT=直接上级；不穿透：skipRankZero=true 时父节点为最低等级则跳过）
 * - FIXED：按固定金额 fixedAmount 发放（与事件金额无关，target 语义同 DIRECT）
 * - LEVEL：链式差额分配，沿祖先链按每个节点的 rankRate（顶层 rankRate 优先，
 *   回退到 node.attrs?.rankRate）做水位差，accumulateInChain=true 的奖励才累加水位
 * - CUSTOM：自定义，由上层注册处理器（一期预留，不实现）
 *
 * 对应《03_通用营销激励引擎架构设计.md》§4.3 RewardDef 的最小实现。
 *
 * @version 1.1.0
 */
class RewardDef {
  /**
   * @param {Object} params
   * @param {string} params.rewardId - 奖励标识（写入选民记录的 rewardType 字段）
   * @param {string} params.type - DIRECT | LEVEL | CUSTOM
   * @param {string|number|null} params.rate - 比例（百分比整数，10=10%）；LEVEL 通常为 null（用链上 rankRate）
   * @param {string|number|null} [params.fixedAmount] - 固定金额（decimal string，FIXED 类型必填）
   * @param {string} [params.target] - DIRECT 的目标：SOURCE | PARENT
   * @param {boolean} [params.skipRankZero] - 是否跳过最低等级节点（LEVEL 穿透；默认 true）
   * @param {boolean} [params.accumulateInChain] - LEVEL 是否累加到链式水位（默认 false）
   * @param {string} [params.allocatorId] - 使用的分配器 ID
   * @param {Array} [params.conditions] - 适用条件（预留，一期不校验）
   * @param {Object} [params.metadata] - 扩展元数据（引擎不解释）
   */
  constructor({
    rewardId,
    type = "DIRECT",
    rate = null,
    fixedAmount = null,
    target = "PARENT",
    skipRankZero = true,
    accumulateInChain = false,
    allocatorId = null,
    conditions = [],
    metadata = {},
  }) {
    this.rewardId = rewardId;
    this.type = type;
    this.rate = rate === null || rate === undefined ? null : String(rate);
    this.fixedAmount = fixedAmount === null || fixedAmount === undefined ? null : String(fixedAmount);
    this.target = target;
    this.skipRankZero = skipRankZero;
    this.accumulateInChain = accumulateInChain;
    this.allocatorId = allocatorId;
    this.conditions = conditions;
    this.metadata = metadata;
  }
}

module.exports = { RewardDef };
