/**
 * 引擎适配器 — 通用适配层
 *
 * 提供通用适配工具，帮助上层业务将实体映射为引擎原语。
 *
 * - ruleSetAdapter: 规则集配置 → 流水线阶段（引擎无关）
 * - customerAdapterTemplate: 新客户接入引擎的参考实现（≤200 行）
 *
 * @version 2.2.0
 */

const { buildPipelineStages } = require("./rule-set-adapter");
const customerAdapterTemplate = require("./customer-adapter-template");

module.exports = {
  buildPipelineStages,
  customerAdapterTemplate,
};