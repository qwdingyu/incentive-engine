/**
 * 条件评估器 — 纯计算，无外部依赖
 *
 * 独立于 rank-evaluator 的通用条件评估模块，支持复合条件（AND/OR/NOT）
 * 和原子比较条件（COMPARE）。任何业务场景（等级评估、规则过滤、事件前置条件）
 * 均可复用本模块，避免条件评估逻辑分散在各服务中各自实现。
 *
 * 使用示例：
 * ```js
 * const { evaluateCondition } = require("./condition-evaluator");
 * const node = { directCount: 5, teamPerformance: "10000" };
 * const result = evaluateCondition(
 *   { type: "COMPARE", field: "directCount", operator: "GTE", value: 3 },
 *   node
 * );
 * // result === true
 * ```
 *
 * @version 1.0.0
 */

const Decimal = require("../../decimal");

/**
 * 从数据对象中按字段路径解析值
 *
 * 支持：
 * - 顶级字段：node.directCount
 * - 子键字段：node.higherTierCounts[subKey]
 * - attrs 回退：node.attrs.directCount
 *
 * @private
 * @param {Object} data - 数据源（如引擎节点或普通对象）
 * @param {string} field - 字段名
 * @param {string} [subKey] - 子键（用于映射类型字段）
 * @returns {*} 字段值
 */
function _resolveField(data, field, subKey) {
  if (!data) return 0;
  if (field === "directCount") return data.directCount ?? data.attrs?.directCount ?? 0;
  if (field === "teamPerformance") return data.teamPerformance ?? data.attrs?.teamPerformance ?? "0";
  if (field === "higherTierCounts") {
    if (subKey !== undefined && subKey !== null) {
      return (data.higherTierCounts && data.higherTierCounts[subKey]) || 0;
    }
    return data.higherTierCount ?? data.attrs?.higherTierCount ?? 0;
  }
  // 从 attrs 或 data 直接读取（任意自定义字段）
  return data.attrs?.[field] ?? data[field] ?? 0;
}

/**
 * 执行原子 COMPARE 条件评估
 *
 * @private
 * @param {Object} condition - { field, operator, value, subKey? }
 * @param {Object} data - 数据源
 * @returns {boolean}
 */
function _evaluateCompare(condition, data) {
  const actual = _resolveField(data, condition.field, condition.subKey);
  const expected = condition.value;
  switch (condition.operator) {
    case "GTE": return _isNumeric(actual) && _isNumeric(expected) ? Decimal.gte(String(actual), String(expected)) : false;
    case "GT":  return _isNumeric(actual) && _isNumeric(expected) ? Decimal.gt(String(actual), String(expected)) : false;
    case "LTE": return _isNumeric(actual) && _isNumeric(expected) ? Decimal.lte(String(actual), String(expected)) : false;
    case "LT":  return _isNumeric(actual) && _isNumeric(expected) ? Decimal.lt(String(actual), String(expected)) : false;
    case "EQ":
      // 数值字段走 Decimal 精确比较；非数值（如等级标识 "V3"）走字符串相等
      return _isNumeric(actual) && _isNumeric(expected)
        ? Decimal.eq(String(actual), String(expected))
        : String(actual) === String(expected);
    case "NE":
      // 与 EQ 对称：数值走 Decimal，非数值走字符串不等
      return _isNumeric(actual) && _isNumeric(expected)
        ? !Decimal.eq(String(actual), String(expected))
        : String(actual) !== String(expected);
    default:
      // 未知操作符视为不满足，避免静默放行
      return false;
  }
}

/**
 * 判断值是否为可解析的数值（Decimal 可安全处理）
 * @private
 * @param {*} value
 * @returns {boolean}
 */
function _isNumeric(value) {
  if (value === null || value === undefined || value === "") return false;
  const str = String(value);
  return str.trim() !== "" && !isNaN(Number(str));
}

/**
 * 递归评估条件树（纯函数）
 *
 * 支持三种复合条件类型：
 * - AND：全部子条件为 true 时返回 true
 * - OR：任一子条件为 true 时返回 true
 * - NOT：对唯一子条件取反（子条件 > 1 时等同 AND 后取反）
 *
 * 原子条件：
 * - COMPARE：按 field/operator/value 比较
 *
 * @param {Object} condition - 条件定义（可以是普通对象或 Condition 实例）
 * @param {Object} data - 数据源（如引擎节点 { directCount, teamPerformance, higherTierCounts, attrs }）
 * @param {Object} [context] - 可选上下文（预留，如求值时间、环境标记）
 * @returns {boolean} 条件是否满足
 */
function evaluateCondition(condition, data, context) {
  if (!condition || !condition.type) return false;

  switch (condition.type) {
    case "COMPARE":
      return _evaluateCompare(condition, data);

    case "AND": {
      if (!Array.isArray(condition.children) || condition.children.length === 0) return true;
      return condition.children.every((child) => evaluateCondition(child, data, context));
    }

    case "OR": {
      if (!Array.isArray(condition.children) || condition.children.length === 0) return false;
      return condition.children.some((child) => evaluateCondition(child, data, context));
    }

    case "NOT": {
      if (!Array.isArray(condition.children) || condition.children.length === 0) return true;
      // 对首个子条件取反；多个子条件时等效为 AND 后取反
      const inner = condition.children.length === 1
        ? condition.children[0]
        : { type: "AND", children: condition.children };
      return !evaluateCondition(inner, data, context);
    }

    default:
      return false;
  }
}

module.exports = { evaluateCondition, _resolveField, _evaluateCompare };