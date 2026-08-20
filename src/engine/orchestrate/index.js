/**
 * 流水线编排模块 — 统一导出（v2.1.0 仅保留通用核心）
 *
 * 面向具体业务的流水线封装（如「订单收益结算」）属于适配层/服务层职责：
 * 纯计算见 src/adapters/customer-adapter-template.js，含落账见 src/services/generic-settlement.service.js。
 */
const { executePipeline } = require("./pipeline-orchestrator");

module.exports = {
  executePipeline,
};
