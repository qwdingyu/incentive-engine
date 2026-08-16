/**
 * COMPARE 比较分配器 — 纯计算，无外部依赖
 *
 * 在多个金额之间按比较操作符选择结果，支持：
 * - MAX：取最大值
 * - MIN：取最小值
 * - FIRST：取第一个非零值
 *
 * 用途：
 * - 多规则奖励中取最大值作为最终奖励（如"取直推收益与团队收益中的较大值"）
 * - 最低保障金额（取当前值与保底值的较大值）
 * - 限高（取当前值与上限值的较小值）
 *
 * 使用示例：
 * ```js
 * const { compareAmounts } = require("./compare-allocator");
 * const result = compareAmounts("MAX", ["100", "200", "50"]);  // "200"
 * const result = compareAmounts("MIN", ["100", "200", "50"]);  // "50"
 * const result = compareAmounts("FIRST", ["0", "200", "50"]);  // "200"
 * ```
 *
 * @version 1.0.0
 */

const Decimal = require("../../decimal");

/**
 * 比较多个金额，按指定策略返回结果
 *
 * @param {string} strategy - 比较策略: MAX | MIN | FIRST
 * @param {Array<string|number>} amounts - 金额数组（字符串或数字）
 * @param {Object} [options]
 * @param {string} [options.defaultValue="0"] - 空数组时的默认值
 * @returns {string} 比较后的金额（字符串，decimal 格式）
 */
function compareAmounts(strategy, amounts, options = {}) {
  const defaultValue = options.defaultValue || "0";

  if (!Array.isArray(amounts) || amounts.length === 0) {
    return defaultValue;
  }

  // 统一转为字符串
  const strAmounts = amounts.map((a) => String(a));

  switch (strategy) {
    case "MAX": {
      // 取最大值
      let max = strAmounts[0];
      for (let i = 1; i < strAmounts.length; i++) {
        if (Decimal.gt(strAmounts[i], max)) {
          max = strAmounts[i];
        }
      }
      return max;
    }

    case "MIN": {
      // 取最小值
      let min = strAmounts[0];
      for (let i = 1; i < strAmounts.length; i++) {
        if (Decimal.lt(strAmounts[i], min)) {
          min = strAmounts[i];
        }
      }
      return min;
    }

    case "FIRST": {
      // 取第一个非零值
      for (const amt of strAmounts) {
        if (!Decimal.eq(amt, "0")) {
          return amt;
        }
      }
      // 全部为零时返回最后一个值（或默认值）
      return strAmounts[strAmounts.length - 1] || defaultValue;
    }

    default:
      return defaultValue;
  }
}

module.exports = { compareAmounts };