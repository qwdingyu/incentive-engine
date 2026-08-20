/**
 * 引擎事件 — 通用领域模型（纯数据容器，无方法，无外部依赖）
 *
 * 触发奖励计算的"激励源"抽象。任何客户的业务事件（订单支付、注册激活、
 * 每日收益、内容打赏）都映射为一个 EngineEvent：
 * - eventId：事件唯一 ID（幂等键基础，同一事件重复计算必须产出相同结果）
 * - sourceNodeId：事件来源节点（谁的订单/行为触发了这次计算）
 * - eventType：事件类型（"purchase" / "signup" / "order_yield" / "release"）
 * - eventValue：事件数值（金额/积分/次数，decimal string）
 * - attrs：扩展属性（如商品类目、渠道，供条件/奖励定义使用）
 *
 * 激励源事件的最小实现：引擎只认「谁触发了多大金额的什么类型事件」。
 *
 * @version 1.0.0
 */
class EngineEvent {
  /**
   * @param {Object} params
   * @param {string} params.eventId - 事件唯一 ID（幂等键）
   * @param {string|number} params.sourceNodeId - 来源节点 ID
   * @param {string} params.eventType - 事件类型
   * @param {string|number} params.eventValue - 事件数值（金额/积分，decimal string）
   * @param {Object} params.attrs - 扩展属性
   */
  constructor({ eventId = null, sourceNodeId, eventType = "generic", eventValue = "0", attrs = {} }) {
    this.eventId = eventId;
    this.sourceNodeId = sourceNodeId;
    this.eventType = eventType;
    this.eventValue = String(eventValue);
    this.attrs = attrs;
  }
}

module.exports = { EngineEvent };
