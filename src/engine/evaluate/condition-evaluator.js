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
 * 数据源选择（v1.1.0）：COMPARE 条件可声明 `source` 指定对**哪个对象**求值 ——
 * `"event"`（事件侧，如"订单金额 >= 1000"）或 `"target"`（受益节点侧，如
 * "上级团队业绩满 5 万才发佣"）。未声明 `source` 时对第 2 参 `data` 求值，
 * 与 1.0.0 行为完全一致（向后兼容）。声明了 `source` 时从第 3 参 `context`
 * 取对应数据源（`{ event, target }`），取不到即抛错 —— 静默回落到另一个数据源
 * 会把"拦住不发"的门槛悄悄变成"放行发放"（超发方向），是资金安全事故。
 *
 * @version 1.1.0
 */

const Decimal = require("../../decimal");

/** COMPARE 条件支持的数据源名（context 的键） */
const CONDITION_SOURCES = Object.freeze(["event", "target"]);

/**
 * 解析 COMPARE 条件的求值数据源
 *
 * - 未声明 `source` → 返回第 2 参 `data`（默认数据源，向后兼容）
 * - `source: "event" | "target"` → 从 `context` 取对应对象
 * - 未知 source（拼写错误等）→ **抛错**：静默忽略等于让条件对错误对象求值
 * - 声明的数据源在 context 中缺失 → **抛错**：绝不回落到另一个数据源
 *
 * @private
 * @param {Object} condition - { field?, source? }
 * @param {Object} data - 默认数据源（第 2 参）
 * @param {Object} [context] - 命名数据源 { event?, target? }
 * @returns {Object} 求值数据源
 */
function _resolveDataSource(condition, data, context) {
  const source = condition.source;
  if (source === undefined || source === null || source === "") return data;
  if (!CONDITION_SOURCES.includes(source)) {
    throw new Error(
      `条件未知 source: ${JSON.stringify(source)}（field=${condition.field}）` +
      `：仅支持 ${CONDITION_SOURCES.map((s) => `"${s}"`).join(" | ")}`
    );
  }
  const picked = context ? context[source] : undefined;
  if (picked === undefined || picked === null) {
    throw new Error(
      `条件声明了 source: "${source}"，但求值上下文未提供该数据源（field=${condition.field}）：` +
      (source === "target"
        ? "受益节点侧条件需要目标节点对象 —— target=\"SOURCE\" 的奖励请给 distributeByDefs 传入 sourceNode"
        : "事件侧条件需要事件对象 —— 等级评估（evaluateTier）没有事件上下文，rankDefs 的条件请勿声明 source: \"event\"")
    );
  }
  return picked;
}

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
  // 三个硬编码字段名优先级与通用分支一致（attrs 优先），
  // 避免"某字段读顶层、另一字段读 attrs"的不一致行为。
  // 等级评估（rank-evaluator）直接读取 node.directCount 等，不经过此函数，零影响。
  if (field === "directCount") return data.attrs?.directCount ?? data.directCount ?? 0;
  if (field === "teamPerformance") return data.attrs?.teamPerformance ?? data.teamPerformance ?? "0";
  if (field === "higherTierCounts") {
    if (subKey !== undefined && subKey !== null) {
      return (data.higherTierCounts && data.higherTierCounts[subKey]) || 0;
    }
    return data.attrs?.higherTierCount ?? data.higherTierCount ?? 0;
  }
  // 通用分支：任意自定义字段，attrs 优先（与上面三个硬编码字段一致的优先级）
  return data.attrs?.[field] ?? data[field] ?? 0;
}

/**
 * 执行原子 COMPARE 条件评估
 *
 * @private
 * @param {Object} condition - { field, operator, value, subKey?, source? }
 * @param {Object} data - 默认数据源（condition.source 未声明时使用）
 * @param {Object} [context] - 命名数据源 { event?, target? }（condition.source 声明时使用）
 * @returns {boolean}
 */
function _evaluateCompare(condition, data, context) {
  const dataSource = _resolveDataSource(condition, data, context);
  const actual = _resolveField(dataSource, condition.field, condition.subKey);
  const expected = condition.value;
  // 统一 trim 后判断：decimal.js 不接受带空格数字（" 5 " 崩溃），
  // _isNumeric 与 Decimal 比较必须使用同一规范化值（trim 后），避免误判崩溃
  const actualStr = _toComparable(actual);
  const expectedStr = _toComparable(expected);
  switch (condition.operator) {
    case "GTE": return _isNumeric(actualStr) && _isNumeric(expectedStr) ? Decimal.gte(actualStr, expectedStr) : false;
    case "GT":  return _isNumeric(actualStr) && _isNumeric(expectedStr) ? Decimal.gt(actualStr, expectedStr) : false;
    case "LTE": return _isNumeric(actualStr) && _isNumeric(expectedStr) ? Decimal.lte(actualStr, expectedStr) : false;
    case "LT":  return _isNumeric(actualStr) && _isNumeric(expectedStr) ? Decimal.lt(actualStr, expectedStr) : false;
    case "EQ":
      // 数值字段走 Decimal 精确比较；非数值（如等级标识 "V3"）走字符串相等
      return _isNumeric(actualStr) && _isNumeric(expectedStr)
        ? Decimal.eq(actualStr, expectedStr)
        : actualStr === expectedStr;
    case "NE":
      // 与 EQ 对称：数值走 Decimal，非数值走字符串不等
      return _isNumeric(actualStr) && _isNumeric(expectedStr)
        ? !Decimal.eq(actualStr, expectedStr)
        : actualStr !== expectedStr;
    default:
      // 未知操作符视为不满足，避免静默放行
      return false;
  }
}

/**
 * 将值规范化为可比较字符串（trim + String 化）
 * @private
 * @param {*} value
 * @returns {string}
 */
function _toComparable(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
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
 * - COMPARE：按 field/operator/value 比较；可选 source 指定数据源（"event" | "target"）
 *
 * @param {Object} condition - 条件定义（可以是普通对象或 Condition 实例）
 * @param {Object} data - 默认数据源（如引擎节点 { directCount, teamPerformance, higherTierCounts, attrs }）
 * @param {Object} [context] - 命名数据源 { event?, target? }，供 COMPARE 的 source 选取；
 *        未声明 source 的条件不受影响（仍对 data 求值）
 * @returns {boolean} 条件是否满足
 */
function evaluateCondition(condition, data, context) {
  if (!condition || typeof condition !== "object") return false;
  // 扁平 COMPARE 容错：{ field, operator, value } 缺 type 时按 COMPARE 处理。
  // 调用方（reward-distributor / rank-evaluator）只在 conditions 数组的**顶层**补
  // type: "COMPARE"，复合条件的 children 不会被补；若此处直接 return false，
  // 「配了门槛却永远拦住」会变成静默少发 —— 与配错门槛同属难以发现的资金问题。
  const type = condition.type || (condition.field !== undefined ? "COMPARE" : null);
  if (!type) return false;

  switch (type) {
    case "COMPARE":
      return _evaluateCompare(condition, data, context);

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

module.exports = { evaluateCondition, _resolveField, _evaluateCompare, CONDITION_SOURCES };