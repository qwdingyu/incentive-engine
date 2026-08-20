/**
 * 条件定义 — 引擎通用条件模型（纯数据对象，无方法，无外部依赖）
 *
 * 表示一个可评估的条件表达式，支持复合条件（AND/OR/NOT）和原子条件（COMPARE）。
 *
 * 原子条件格式：
 * { type: "COMPARE", field: "directCount", operator: "GTE", value: 5, subKey?: "V3", source?: "target" }
 *
 * 复合条件格式：
 * { type: "AND", children: [condition1, condition2, ...] }
 * { type: "OR",  children: [condition1, condition2, ...] }
 * { type: "NOT", children: [condition] }
 *
 * source（v1.1.0）指定 COMPARE 对**哪个对象**求值：
 * - 省略      → 调用方给的默认数据源（rewardDefs 场景 = 事件；rankDefs 场景 = 被评估节点）
 * - "event"   → 事件侧（如"订单金额 >= 1000 才发佣"）
 * - "target"  → 受益节点侧（如"上级团队业绩满 5 万才发佣"、"只给 V2 以上的上级发"）
 *
 * @version 1.1.0
 */

class Condition {
  /**
   * @param {Object} params
   * @param {string} params.type - 条件类型: "COMPARE" | "AND" | "OR" | "NOT"
   * @param {string} [params.field] - COMPARE 类型时评估的字段名
   * @param {string} [params.operator] - COMPARE 类型时的比较操作符: GTE/GT/LTE/LT/EQ/NE
   * @param {*} [params.value] - COMPARE 类型时的期望值
   * @param {string} [params.subKey] - COMPARE 类型时的子键（如 higherTierCounts 的等级键）
   * @param {string} [params.source] - COMPARE 类型时的数据源: "event" | "target"（省略 = 默认数据源）
   * @param {Array<Condition|Object>} [params.children] - 复合条件类型的子条件列表
   */
  constructor({ type, field, operator, value, subKey, source, children } = {}) {
    this.type = type;
    if (type === "COMPARE") {
      this.field = field;
      this.operator = operator;
      this.value = value;
      if (subKey !== undefined && subKey !== null) this.subKey = subKey;
      // 未声明时不写该字段：写 undefined 会让「未声明」与「显式声明」在
      // JSON 序列化/差异比对上不可区分（与 subKey 同一处理口径）。
      if (source !== undefined && source !== null && source !== "") this.source = source;
    } else if (type === "AND" || type === "OR" || type === "NOT") {
      this.children = Array.isArray(children) ? children : [];
    }
  }
}

module.exports = { Condition };