/**
 * 营销激励引擎 — 统一入口（v2.2.0 领域无关，仅通用核心）
 *
 * 引擎核心职责：纯计算，零外部依赖。
 * 不查询数据库，不管理事务，不负责幂等键判断。
 * 不认识任何业务词（直推/极差/佣金/返利）——业务规则由上层翻译成
 * rewardDefs/rankDefs/capDefs 配置后交给引擎。
 * 所有 DB 访问和事务边界由 Service 层负责，引擎只做"输入 → 计算 → 输出"。
 *
 * @version 2.2.0
 */

const Distribute = require("./distribute");
const Evaluate = require("./evaluate");
const Allocate = require("./allocate");
const Orchestrate = require("./orchestrate");
const Model = require("./model");

module.exports = {
  Distribute,
  Evaluate,
  Allocate,
  Orchestrate,
  Model,
};
