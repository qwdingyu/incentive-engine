/**
 * 条件定义 — 引擎通用条件模型（纯数据对象，无方法，无外部依赖）
 *
 * 表示一个可评估的条件表达式，支持复合条件（AND/OR/NOT）和原子条件（COMPARE）。
 *
 * 原子条件格式：
 * { type: "COMPARE", field: "directCount", operator: "GTE", value: 5, subKey?: "V3" }
 *
 * 复合条件格式：
 * { type: "AND", children: [condition1, condition2, ...] }
 * { type: "OR",  children: [condition1, condition2, ...] }
 * { type: "NOT", children: [condition] }
 *
 * @version 1.0.0
 */

class Condition {
  /**
   * @param {Object} params
   * @param {string} params.type - 条件类型: "COMPARE" | "AND" | "OR" | "NOT"
   * @param {string} [params.field] - COMPARE 类型时评估的字段名
   * @param {string} [params.operator] - COMPARE 类型时的比较操作符: GTE/GT/LTE/LT/EQ
   * @param {*} [params.value] - COMPARE 类型时的期望值
   * @param {string} [params.subKey] - COMPARE 类型时的子键（如 higherTierCounts 的等级键）
   * @param {Array<Condition|Object>} [params.children] - 复合条件类型的子条件列表
   */
  constructor({ type, field, operator, value, subKey, children } = {}) {
    this.type = type;
    if (type === "COMPARE") {
      this.field = field;
      this.operator = operator;
      this.value = value;
      if (subKey !== undefined && subKey !== null) this.subKey = subKey;
    } else if (type === "AND" || type === "OR" || type === "NOT") {
      this.children = Array.isArray(children) ? children : [];
    }
  }
}

module.exports = { Condition };