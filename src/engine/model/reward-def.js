/**
 * 奖励定义 — 通用领域模型（纯数据容器，无方法，无外部依赖）
 *
 * 描述"怎么分"：一条奖励规则 = 类型 + 比例 + 适用对象 + 链式行为。
 * 引擎遍历 rewardDefs 列表驱动分配，不认识任何业务词（直推/极差是
 * 上层把业务规则翻译成 DIRECT/LEVEL 配置后的结果）。
 *
 * 类型语义（引擎实现）：
 * - DIRECT：按 eventValue × rate 分配给指定 target（SOURCE=事件来源节点自身；
 *   PARENT=直接上级；ANCESTOR=祖先链第 ancestorLevel 层这一个节点；
 *   不穿透：skipRankZero=true 时目标节点为最低等级则跳过）
 * - FIXED：按固定金额 fixedAmount 发放（与事件金额无关，target 语义同 DIRECT）
 * - LEVEL：链式分配，两种互斥口径 ——
 *   缺省沿祖先链按每个节点的 rankRate（顶层 rankRate 优先，回退到 node.attrs?.rankRate）
 *   做水位差，accumulateInChain=true 的奖励才累加水位；
 *   配置 levelRates 则改为「第 n 层拿 levelRates[n-1] 的固定比例」（不读 rankRate、不推进水位）。
 *   maxDepth 可限制参与计算的祖先层数（缺省不限）
 * - CUSTOM：固定金额 + 可选动态取数。amount 为固定金额常量；amountFrom 提供
 *   时从事件动态取数（"eventValue" 取事件值本身；"event.attrs.<path>" 按点分
 *   路径取事件扩展属性），取数失败回退 amount。target 语义同 DIRECT/FIXED。
 *
 * 「怎么分」的最小声明式表达：一条 RewardDef 即一条可配置的奖励规则。
 *
 * @version 1.4.0
 */
class RewardDef {
  /**
   * @param {Object} params
   * @param {string} params.rewardId - 奖励标识（写入收益记录的 rewardId 字段，用于区分奖励类型与对账）
   * @param {string} params.type - DIRECT | LEVEL | FIXED | CUSTOM
   * @param {string|number|null} params.rate - 比例（百分比整数，10=10%）；LEVEL 通常为 null（用链上 rankRate）
   * @param {string|number|null} [params.fixedAmount] - 固定金额（decimal string，FIXED 类型必填）
   * @param {string|number|null} [params.amount] - CUSTOM 固定金额常量（decimal string）
   * @param {string|null} [params.amountFrom] - CUSTOM 动态取数路径："eventValue" | "event.attrs.<path>"（可选）
   * @param {string} [params.target] - DIRECT/FIXED/CUSTOM 的目标：SOURCE | PARENT | ANCESTOR
   * @param {number|null} [params.ancestorLevel] - target=ANCESTOR 时的定点层号（>=1 整数，
   *        1 = 最近的祖先），与 LEVEL 的层号口径一致。仅对 target=ANCESTOR 有意义；
   *        缺失或非法值在计算时抛错（不静默按第 1 层发）。
   * @param {boolean} [params.skipRankZero] - 是否跳过最低等级节点（LEVEL 穿透；默认 true）
   * @param {boolean} [params.accumulateInChain] - LEVEL 是否累加到链式水位（默认 false）
   * @param {number|null} [params.maxDepth] - LEVEL 链式发放层数上限（>=1 整数；缺省 null = 不限层数）。
   *        按祖先链位置计数（1 = 最近的祖先），被跳过的层同样占一层。非法值在计算时抛错。
   * @param {Array<string|number>|null} [params.levelRates] - LEVEL 按层固定比例表（百分比整数，
   *        索引 0 = 最近的祖先）。配置后走「每层各拿自己的固定比例」口径，不读 rankRate、不推进水位；
   *        与 accumulateInChain=true 互斥。有效层数 = min(levelRates.length, maxDepth)。非法值在计算时抛错。
   * @param {string} [params.allocatorId] - 使用的分配器 ID
   * @param {Array} [params.conditions] - 适用条件（预留，一期不校验）
   * @param {Object} [params.metadata] - 扩展元数据（引擎不解释）
   */
  constructor({
    rewardId,
    type = "DIRECT",
    rate = null,
    fixedAmount = null,
    amount = null,
    amountFrom = null,
    target = "PARENT",
    ancestorLevel = null,
    skipRankZero = true,
    accumulateInChain = false,
    maxDepth = null,
    levelRates = null,
    allocatorId = null,
    conditions = [],
    metadata = {},
  }) {
    this.rewardId = rewardId;
    this.type = type;
    this.rate = rate === null || rate === undefined ? null : String(rate);
    this.fixedAmount = fixedAmount === null || fixedAmount === undefined ? null : String(fixedAmount);
    this.amount = amount === null || amount === undefined ? null : String(amount);
    this.amountFrom = amountFrom === null || amountFrom === undefined ? null : String(amountFrom);
    this.target = target;
    // ancestorLevel 保持 null 而不兜底为 1：缺失时由计算层抛错，
    // 「定点发第几层」漏配等于发错人，不能猜。
    this.ancestorLevel = ancestorLevel === null || ancestorLevel === undefined ? null : Number(ancestorLevel);
    this.skipRankZero = skipRankZero;
    this.accumulateInChain = accumulateInChain;
    this.maxDepth = maxDepth === null || maxDepth === undefined ? null : Number(maxDepth);
    // levelRates 逐项 String() 归一（与 rate 一致），非数组则原样保留交由计算层抛错。
    this.levelRates = Array.isArray(levelRates)
      ? levelRates.map((r) => (r === null || r === undefined ? r : String(r)))
      : (levelRates === undefined ? null : levelRates);
    this.allocatorId = allocatorId;
    this.conditions = conditions;
    this.metadata = metadata;
  }
}

module.exports = { RewardDef };
