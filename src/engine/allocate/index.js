/**
 * 分配器模块 — 统一导出（v2.2.0 新增 compareAmounts；v2.4.0 新增 CAP_SCOPES；
 * v2.5.0 新增 applyCampaign / resolveActiveCampaigns 活动期加成）
 *
 * 本模块只保留领域无关的通用分配原语；面向具体业务的封装（单条裁剪、
 * 金额克隆、固定比例拆分等）属于适配层职责，参考 src/adapters/customer-adapter-template.js。
 */
const { applyCaps, applyBudgetGuard, CAP_SCOPES } = require("./budget-controller");
const { splitByTargets } = require("./percentage-split-allocator");
const { compareAmounts } = require("./compare-allocator");
const {
  applyCampaign,
  resolveActiveCampaigns,
  CAMPAIGN_MULTIPLIER_MAX,
} = require("./campaign-multiplier");

module.exports = {
  applyCaps,
  applyBudgetGuard,
  // 合法封顶 scope 全集（8 个）：宿主做配置后台/校验时可直接引用，避免各自硬编码枚举
  CAP_SCOPES,
  splitByTargets,
  compareAmounts,
  // 活动期加成（限时系数）：必须排在 CAP/OVER 之前，否则加成金额绕过封顶
  applyCampaign,
  // 某时刻生效的活动（宿主做「当前翻倍中」展示与预览试算用）
  resolveActiveCampaigns,
  // 活动系数上限（倍数上限，防「把倍数写成百分比」）：宿主配置后台可直接引用
  CAMPAIGN_MULTIPLIER_MAX,
};
