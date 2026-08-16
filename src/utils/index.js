/**
 * 引擎工具模块 — 统一导出
 *
 * 提供引擎附带的通用纯函数工具。
 *
 * 当前包含：
 * - selectVersionByRoutingKey: 灰度版本路由选择器（hash 加权路由）
 * - validateGrayscaleWeights: 灰度配置权重校验
 * - normalizePagination: 分页参数归一化
 * - formatDateInTimezone: 日期按时区格式化为 YYYY-MM-DD
 * - addBusinessDays: 日期加减天数
 * - dateDiff: 日期天数差
 *
 * @version 2.1.0
 */

const { selectVersionByRoutingKey, validateGrayscaleWeights } = require("./version-select");
const { normalizePagination } = require("./pagination");
const { formatDateInTimezone, addBusinessDays, dateDiff } = require("./business-date");

module.exports = {
  selectVersionByRoutingKey,
  validateGrayscaleWeights,
  normalizePagination,
  formatDateInTimezone,
  addBusinessDays,
  dateDiff,
};