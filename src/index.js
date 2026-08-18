/**
 * @usethink/incentive-engine — 通用营销激励引擎（v3.3.1）
 *
 * 领域无关的纯计算核心，零外部业务依赖。
 * 不查询数据库，不管理事务，不认识任何业务词（直推/极差/佣金/茸贝）。
 *
 * 业务规则由上层翻译成 rewardDefs/rankDefs/capDefs 配置后交给引擎，
 * 引擎只做"输入 → 计算 → 输出"。
 *
 * 使用示例：
 * ```js
 * const engine = require("@usethink/incentive-engine");
 *
 * const records = engine.Distribute.distributeByDefs({
 *   event: { sourceNodeId: "user1", eventValue: "1000" },
 *   directParent: { id: "user0", rankRate: "10" },
 *   ancestors: [{ id: "user0", rankRate: "10" }],
 *   rewardDefs: [
 *     { rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" },
 *     { rewardId: "referral", type: "DIRECT", target: "PARENT", rate: "5" },
 *   ],
 * });
 * ```
 *
 * 子模块：
 * - engine.Model          — 纯数据模型（EngineNode, EngineEvent, RewardDef, etc.）
 * - engine.Distribute     — 奖励分配（DIRECT/LEVEL）
 * - engine.Allocate       — 封顶/拆分/预算兜底
 * - engine.Evaluate       — 等级评估/条件评估
 * - engine.Orchestrate    — 流水线编排
 * - engine.Adapters       — 适配器（buildPipelineStages, customerAdapterTemplate）
 * - engine.Services       — 框架服务（GenericSettlementService）
 * - engine.Validation     — 配置校验（createRuleSetValidation, validateCustomerConfig）
 * - engine.Utils          — 工具函数（分页/灰度路由/日期函数）
 * - engine.Decimal        — 安全金额计算（decimal.js 包装）
 *
 * @version 3.4.6
 * @license MIT
 */

const Engine = require("./engine");
const Adapters = require("./adapters");
const Decimal = require("./decimal");
const Services = require("./services");
const { createRuleSetValidation, validateCustomerConfig, CONFIG_FIELD_KEYS } = require("./validation");
const Utils = require("./utils");

module.exports = {
  ...Engine,
  Adapters,
  Decimal,
  Services,
  Validation: { createRuleSetValidation, validateCustomerConfig, CONFIG_FIELD_KEYS },
  Utils,
};