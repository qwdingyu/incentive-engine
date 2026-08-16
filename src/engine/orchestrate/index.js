/**
 * 流水线编排模块 — 统一导出（v2.1.0 仅保留通用核心）
 *
 * 松茸场景的 executeOrderPipeline 已迁至 src/adapters/songrong-reward-adapter.js。
 */
const { executePipeline } = require("./pipeline-orchestrator");

module.exports = {
  executePipeline,
};
