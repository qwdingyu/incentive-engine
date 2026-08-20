/**
 * 冲正模块 — 统一导出
 *
 * 领域无关的「已发放收益反向追回」原语。宿主负责「哪些记录属于这笔退款」
 * 与「已冲正多少」的查询，引擎只做比例计算与资金约束（累计不超额、重复冲正不重复产出）。
 */
const { reverseRecords, REVERSAL_DIRECTION } = require("./reversal-calculator");

module.exports = { reverseRecords, REVERSAL_DIRECTION };
