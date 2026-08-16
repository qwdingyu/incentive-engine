/**
 * 业务日期工具函数 — 纯函数（引擎无关）
 *
 * 提供与时间/时区相关的纯计算函数，不依赖任何外部服务或配置。
 * 依赖 configService 的函数（getBusinessTimezone / getBusinessNow / getBusinessDate）
 * 留在上层业务项目（如 rbb）中，本文件仅包含纯函数。
 *
 * @version 1.0.0
 */

/**
 * 将任意日期格式化为指定时区下的 YYYY-MM-DD 字符串
 *
 * @param {Date|string} date - 要格式化的日期。
 * @param {string} timezone - IANA 时区标识，如 "Asia/Shanghai"。
 * @returns {string} 该时区下的日期字符串，格式 YYYY-MM-DD。
 */
function formatDateInTimezone(date, timezone) {
  return new Date(date).toLocaleDateString("sv-SE", { timeZone: timezone });
}

/**
 * 在日期字符串上增加指定天数
 *
 * 输入/输出均为 YYYY-MM-DD，用于计算 T+N 业务日期。
 *
 * @param {string} dateStr - 起始日期，格式 YYYY-MM-DD。
 * @param {number} days - 增加天数（支持负数）。
 * @returns {string} 计算后的日期，格式 YYYY-MM-DD。
 */
function addBusinessDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

/**
 * 计算两个日期字符串之间的天数差
 *
 * 两个日期均为 YYYY-MM-DD 格式。返回 dateB - dateA 的天数差（可为负数）。
 *
 * @param {string} dateA - 起始日期，格式 YYYY-MM-DD。
 * @param {string} dateB - 结束日期，格式 YYYY-MM-DD。
 * @returns {number} 天数差。
 */
function dateDiff(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.round((b - a) / 86400000);
}

module.exports = {
  formatDateInTimezone,
  addBusinessDays,
  dateDiff,
};