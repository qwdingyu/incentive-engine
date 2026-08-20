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
 * - parseInstant: 解析绝对时刻（Date / 带偏移量 ISO-8601；拒绝无歧义不明的输入）
 * - isWithinWindow: 判断时刻是否落在时间窗口内（左闭右开，供生效期/活动期使用）
 *
 * @version 2.2.0
 */

const { selectVersionByRoutingKey, validateGrayscaleWeights } = require("./version-select");
const { normalizePagination } = require("./pagination");
const { formatDateInTimezone, addBusinessDays, dateDiff } = require("./business-date");
const { parseInstant, isWithinWindow } = require("./instant-window");

module.exports = {
  selectVersionByRoutingKey,
  validateGrayscaleWeights,
  normalizePagination,
  formatDateInTimezone,
  addBusinessDays,
  dateDiff,
  parseInstant,
  isWithinWindow,
};