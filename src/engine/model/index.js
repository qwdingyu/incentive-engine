/**
 * 引擎领域模型 — 纯数据对象，无方法，无外部依赖
 *
 * 通用原语（领域无关，供任意客户场景使用）：
 * - EngineNode：抽象节点（id/parentId/rankId/rankRate/attrs/tags）
 * - EngineEvent：激励源事件（eventId/sourceNodeId/eventType/eventValue）
 * - RewardDef：奖励定义（DIRECT/LEVEL，配置驱动）
 * - AllocationTarget：分配目标（target + ratio）
 * - RankDef：等级定义（含 conditions 条件列表）
 * - Condition：条件定义（COMPARE/AND/OR/NOT，支持复合条件树）
 *
 * v2.2.0 新增：Condition 条件模型
 *
 * @version 2.2.0
 */

const { EngineNode } = require("./engine-node");
const { EngineEvent } = require("./engine-event");
const { RewardDef } = require("./reward-def");
const { AllocationTarget } = require("./allocation-target");
const { RankDef } = require("./rank-def");
const { Condition } = require("./condition");

module.exports = {
  EngineNode,
  EngineEvent,
  RewardDef,
  AllocationTarget,
  RankDef,
  Condition,
};
