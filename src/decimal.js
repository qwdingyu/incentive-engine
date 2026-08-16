/**
 * 高精度计算工具（资金安全版）
 *
 * ========== 使用规约 ==========
 * 1. 所有加减乘除运算必须经过本工具，严禁直接用 JavaScript 原生浮点数做金额计算
 * 2. 所有运算函数返回 string 而非 number，避免 .toNumber() 导致的浮点精度丢失
 * 3. 中间计算过程使用 4 位小数防累积误差，最终展示在 Controller 层用 toDisplay() 转 number
 * 4. 比较函数（gte/gt/lt/lte/eq）可直接用于 string 比较
 *
 * ========== 分层约定 ==========
 * - Service 层：全程使用 string，运算结果经 toString() 确保类型安全
 * - Controller 层：调用 toDisplay() 将 string 转 number 返回给前端
 * - 前端：收到 number 后自行处理展示精度
 *
 * @version 2.0.0
 */

const Decimal = require("decimal.js");

// 全局配置：28 位精度 + 四舍五入（银行家舍入为默认，但 HALF_UP 更符合业务预期）
Decimal.set({
  precision: 28,          // 中间计算精度 28 位（远超金额业务需要的 20 位）
  rounding: Decimal.ROUND_HALF_UP,  // 四舍五入（与日常认知一致）
  toExpNeg: -20,          // 极小值时不用科学计数法
  toExpPos: 20,           // 极大值时不用科学计数法
});

/**
 * 安全乘法 → 返回 string
 * @param {string|number} a
 * @param {string|number} b
 * @param {number} dp - 小数位数，默认 4
 */
function mul(a, b, dp = 4) {
  return new Decimal(a || 0).mul(new Decimal(b || 0)).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toString();
}

/**
 * 安全加法 → 返回 string
 */
function add(a, b, dp = 4) {
  return new Decimal(a || 0).plus(new Decimal(b || 0)).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toString();
}

/**
 * 安全减法 → 返回 string
 */
function sub(a, b, dp = 4) {
  return new Decimal(a || 0).minus(new Decimal(b || 0)).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toString();
}

/**
 * 安全除法 → 返回 string
 */
function div(a, b, dp = 4) {
  const bDec = new Decimal(b || 0);
  if (bDec.isZero()) return "0";
  return new Decimal(a || 0).div(bDec).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toString();
}

/**
 * 四舍五入到指定位数 → 返回 string
 */
function round(value, dp = 2) {
  return new Decimal(value || 0).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toString();
}

/**
 * 百分比计算：value × pct / 100 → 返回 string
 * @param {string|number} value - 基数
 * @param {string|number} pct - 百分比（如 70 表示 70%）
 */
function pct(value, pct, dp = 4) {
  return mul(value, div(pct, 100, 10), dp);
}

/**
 * 比较: a >= b
 */
function gte(a, b) {
  return new Decimal(a || 0).gte(new Decimal(b || 0));
}

/**
 * 比较: a < b
 */
function lt(a, b) {
  return new Decimal(a || 0).lt(new Decimal(b || 0));
}

/**
 * 比较: a > b
 */
function gt(a, b) {
  return new Decimal(a || 0).gt(new Decimal(b || 0));
}

/**
 * 比较: a <= b
 */
function lte(a, b) {
  return new Decimal(a || 0).lte(new Decimal(b || 0));
}

/**
 * 比较: a == b
 */
function eq(a, b) {
  return new Decimal(a || 0).eq(new Decimal(b || 0));
}

/**
 * 取最小值 → 返回 string
 */
function min(a, b) {
  return Decimal.min(new Decimal(a || 0), new Decimal(b || 0)).toString();
}

/**
 * 取最大值 → 返回 string
 */
function max(a, b) {
  return Decimal.max(new Decimal(a || 0), new Decimal(b || 0)).toString();
}

/**
 * 取反
 */
function neg(value) {
  return new Decimal(value || 0).neg().toString();
}

/**
 * 转为展示用数字（仅 Controller 层使用）
 */
function toDisplay(value, dp = 2) {
  return parseFloat(round(value, dp));
}

/**
 * 固定小数位字符串（保留尾部零，如 "30.0000"）
 */
function toFixed(value, dp = 4) {
  return new Decimal(value || 0).toFixed(dp);
}

module.exports = { mul, add, sub, div, round, pct, gte, gt, lt, lte, eq, min, max, neg, toDisplay, toFixed };
