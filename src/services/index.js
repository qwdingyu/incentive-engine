/**
 * 引擎框架服务模块 — 统一导出
 *
 * 提供构建在引擎纯计算核心之上的框架服务。
 * 这些服务依赖 Sequelize（可选 peer dependency），用于业务集成。
 *
 * 当前包含：
 * - GenericSettlementService: 通用结算服务
 *
 * @version 1.0.0
 */

const { GenericSettlementService, REQUIRED_CONFIG_KEYS } = require("./generic-settlement.service");

module.exports = {
  GenericSettlementService,
  REQUIRED_CONFIG_KEYS,
};