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
 * 资金安全（P1-2）：必须用纯 UTC 日期算术，不能用本地时区。
 * 原实现 `new Date(dateStr)` + 本地 `setDate()` + `toISOString()` 在夏令时
 * （DST）切换日会错日：如 America/New_York 下 2026-03-08（DST 开始日）加 1 天
 * 会因本地时间偏移被 toISOString 拉回同一天，导致 03-08 重复产出、03-09 被跳过。
 * 改用 Date.UTC + setUTCDate 后，日期算术与时区完全无关，任何时区结果一致。
 *
 * @param {string} dateStr - 起始日期，格式 YYYY-MM-DD。
 * @param {number} days - 增加天数（支持负数）。
 * @returns {string} 计算后的日期，格式 YYYY-MM-DD。
 */
function addBusinessDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  // 用 Date.UTC 构造 UTC 时间（注意 month 为 0-based），再 setUTCDate 做纯 UTC 天数算术。
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  // 用 UTC 分量格式化，避免 toISOString 的时区偏移。
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
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
  // 纯 UTC 解析（P1-2）：避免本地时区 DST 切换日产生 23/25 小时日，
  // 导致 (b-a)/86400000 出现 0.958/1.04 的偏差被 Math.round 误判。
  const [ay, am, ad] = dateA.split("-").map(Number);
  const [by, bm, bd] = dateB.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

module.exports = {
  formatDateInTimezone,
  addBusinessDays,
  dateDiff,
};