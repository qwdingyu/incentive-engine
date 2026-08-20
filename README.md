# @usethink/incentive-engine — 通用营销激励引擎

> **领域无关的纯计算核心**  
> 不查询数据库，不管理事务，不认识任何业务词（直推/极差/佣金/返利）。  
> 业务规则由上层翻译成 `rewardDefs`/`rankDefs`/`capDefs` 配置后交给引擎，引擎只做"输入 → 计算 → 输出"。

---

## 安装

```bash
npm install @usethink/incentive-engine
```

仅依赖 `decimal.js`（高精度金额计算）。如需使用校验模块，需自行安装 `joi`（peerDependency）。

---

## 快速开始

```javascript
const engine = require("@usethink/incentive-engine");

// 1. 定义奖励规则
const rewardDefs = [
  { rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" },
  { rewardId: "referral", type: "DIRECT", target: "PARENT", rate: "5" },
  { rewardId: "team_diff", type: "LEVEL", accumulateInChain: true },
];

// 2. 执行奖励分配
const records = engine.Distribute.distributeByDefs({
  event: { sourceNodeId: "user1", eventValue: "1000" },
  directParent: { id: "user0", rankRate: "10" },
  ancestors: [{ id: "user0", rankRate: "10" }, { id: "admin", rankRate: "30" }],
  rewardDefs,
});
// 输出:
// [
//   { nodeId: "user1", rewardId: "self",   amount: "1000", ... },  // 本人 100%
//   { nodeId: "user0", rewardId: "referral", amount: "50",  ... },  // 直推 5%
//   { nodeId: "user0", rewardId: "team_diff", amount: "100", ... }, // 极差 10%
//   { nodeId: "admin", rewardId: "team_diff", amount: "200", ... }, // 极差 20%
// ]

// 3. 封顶裁剪
const capped = engine.Allocate.applyCaps(records, [
  { scope: "PLATFORM_DAILY", limit: "200" },
  { scope: "PER_USER_DAILY", limit: "100" },
]);

// 4. 流水线编排（一键执行）
const result = engine.Orchestrate.executePipeline({
  stages: [
    { id: "distribute", handler: "DISTRIBUTE", config: { event, directParent, ancestors, rewardDefs } },
    { id: "cap", handler: "CAP", config: { capDefs } },
  ],
});
```

### 验证规则集配置

引擎提供 joi 校验工厂函数，用于验证规则集配置的合法性：

```javascript
const Joi = require("joi");
const { createRuleSetValidation } = require("@usethink/incentive-engine").Validation;
const { ruleSetConfigSchema } = createRuleSetValidation(Joi);

const { error } = ruleSetConfigSchema.validate(configJson);
if (error) {
  console.error("配置校验失败:", error.message);
}
```

> ⚠️ `createRuleSetValidation(Joi)` 需要调用方传入自己的 joi 实例，避免 joi 跨包版本不一致导致的 `"Cannot mix different versions"` 错误。

---

## 架构概览

### 架构原则

1. **默认纯函数，副作用仅限两处显式约定**：计算函数不查询外部状态、不做 IO。
   ⚠️ 两处按设计有意为之的就地写（不是纯函数）：`applyCaps` 会就地推进封顶水位 `state`
   （跨记录累计必须如此），`RANK` 阶段会就地写回节点的 `rankRate`/`rankId`
   （供随后 DISTRIBUTE 立即可见）。复用输入对象做并发/重放时必须注意这两处 —— 重放同一批
   `state` / 节点对象会导致水位重复累计或等级被前一次结果污染，正确做法是每次结算传入
   新构造的 `state` 与节点对象。
2. **领域无关**：引擎不认识任何业务实体（用户/订单/商品），只操作抽象节点和事件
3. **配置驱动**：奖励规则、封顶策略、等级条件全部由上层配置注入
4. **可组合**：通过流水线编排器将多个阶段组合成完整计算流程

---

## 子模块说明

### Model — 领域模型

纯数据容器，无方法，无外部依赖。

| 模型 | 用途 |
|------|------|
| `EngineNode` | 抽象网络节点（id/parentId/rankId/attrs/tags） |
| `EngineEvent` | 激励源事件（eventId/sourceNodeId/eventType/eventValue） |
| `RewardDef` | 奖励定义（DIRECT/LEVEL/FIXED/CUSTOM，配置驱动） |
| `AllocationTarget` | 分配目标（target + ratio） |
| `RankDef` | 等级定义（含 conditions 条件列表 + rankRate 可选） |
| `Condition` | 条件定义（COMPARE/AND/OR/NOT，支持复合条件树） |

### Distribute — 奖励分配

| 函数 | 用途 |
|------|------|
| `distributeByDefs` | 遍历 RewardDef 列表驱动分配 |
| `calculateDirect` | 单条 DIRECT 奖励计算（eventValue × rate） |
| `calculateFixed` | 单条 FIXED 固定金额奖励计算（不依赖事件金额） |
| `calculateCustom` | 单条 CUSTOM 固定金额奖励计算（amount 常量 + amountFrom 动态取数） |
| `calculateLevelChain` | 链式水位差分配（极差/多级佣金的通用模式） |

### Allocate — 封顶/拆分/预算兜底

| 函数 | 用途 |
|------|------|
| `applyCaps` | 多维封顶裁剪（PLATFORM_DAILY + PER_USER_DAILY） |
| `applyBudgetGuard` | 总预算兜底保护（CAP/WARN/REJECT） |
| `splitByTargets` | 按比例拆分（如 70/30 拆分到两个科目） |
| `compareAmounts` | 比较分配器（MAX/MIN/FIRST） |

### Evaluate — 等级/条件评估

| 函数 | 用途 |
|------|------|
| `evaluateTier` | 判断单个节点是否满足某个等级条件 |
| `getHighestQualifiedTier` | 获取节点可达的最高等级（遍历全部等级） |
| `evaluateCondition` | 递归评估条件树（COMPARE/AND/OR/NOT） |

### Orchestrate — 流水线编排

内置阶段 handler：`DISTRIBUTE`（奖励分配）、`RANK`（等级评估，写入节点 rankRate）、`CAP`（封顶）、`OVER`（预算兜底）、`SPLIT`（金额拆分）。阶段按顺序执行，共享 context（封顶水位）；节点为对象引用，前序阶段对节点的就地修改对后续阶段立即可见。

| 函数 | 用途 |
|------|------|
| `executePipeline` | 按 stages 配置顺序执行，共享 context（封顶水位） |

### Validation — 配置校验

| 函数 | 用途 |
|------|------|
| `createRuleSetValidation(Joi)` | 工厂函数，传入 joi 实例，返回 `ruleSetConfigSchema` 等 schema |
| `validateCustomerConfig(config)` | 校验 GenericSettlementService 客户配置结构完整性，Joi 路径 + 基础回退 |

### Adapters — 通用适配工具

| 函数 | 用途 |
|------|------|
| `buildPipelineStages` | 将规则集 config_json 组装为引擎流水线阶段 |
| `customerAdapterTemplate` | 新客户接入引擎的参考实现（≤200 行） |

### Utils — 工具函数

| 函数 | 用途 |
|------|------|
| `selectVersionByRoutingKey` | 灰度版本路由选择器（MD5 hash 分桶） |
| `normalizePagination` | 分页参数归一化（page/pageSize 收敛，offset/limit 一致） |
| `formatDateInTimezone` | 日期按时区格式化为 YYYY-MM-DD |
| `addBusinessDays` | 日期加减天数（YYYY-MM-DD 输入/输出） |
| `dateDiff` | 两个 YYYY-MM-DD 日期之间的天数差 |

### Decimal — 高精度金额

| 导出 | 用途 |
|------|------|
| `Decimal` | decimal.js 实例（工厂模式，支持 `Decimal.pct`、`Decimal.toDisplay` 等扩展方法） |

### Services — 框架服务

框架服务层构建在引擎纯计算核心之上，提供与业务集成（DB、事务、幂等）的通用编排能力。

| 服务 | 用途 | 依赖 |
|------|------|------|
| `GenericSettlementService` | 配置驱动的事件→引擎→DB 结算编排，80% 重复代码消除 | Sequelize（可选 peer） |

**使用示例：**

```javascript
const { GenericSettlementService } = require("@usethink/incentive-engine").Services;
const { UniqueConstraintError } = require("sequelize"); // 宿主项目的 sequelize

const customerService = new GenericSettlementService({
  name: "customerA",
  ruleSetCode: "CUSTOMER_A_RULES",
  model: CustomerARewardModel,
  sequelize,           // 项目 Sequelize 实例
  ruleSetService,      // getActiveRuleSet(code, opts) 方法
  UniqueConstraintError,  // ⚠️ 必填！注入宿主 sequelize 的错误类（引擎包内 require("sequelize") 解析不到宿主 node_modules）
  logger: getLogger("CustomerA"),  // 可选，缺省使用 console
  buildEvent: (event) => ({ sourceNodeId: event.memberId, eventType: "purchase", eventValue: event.amount }),
  buildDirectParent: (event) => event.parent ? { id: event.parent.id, rankRate: event.parent.rankRate } : null,
  buildAncestors: (event) => (event.ancestors || []).map((a) => ({ id: a.id, rankRate: a.rankRate })),
  buildRecord: (event, engineRecord, extra) => ({ member_id: engineRecord.nodeId, amount: engineRecord.amount, order_id: event.orderNo }),
  idempotency: {
    buildPreReadWhere: (event) => ({ order_id: event.orderNo }),
    buildFallbackWhere: (event) => ({ order_id: event.orderNo }),
  },
});

// 一键结算（自管事务）
const result = await customerService.settle(businessEvent);
```

> ⚠️ **`UniqueConstraintError` 必填**：引擎包以 npm/file 方式安装时，包内 `require("sequelize")`
> 解析的是引擎自己的 node_modules（不含 sequelize，可选 peer）。必须由宿主注入
> `sequelize.UniqueConstraintError` 类，引擎才能识别唯一约束冲突并走幂等兜底。
> 未注入时唯一约束兜底静默失效（异常直接上抛）。

**settle 流程优化（v3.0）**：
- 计算阶段在**事务外**执行：规则集加载失败 / `buildRecord` 全部过滤时直接返回，不开启事务
- 无落账记录时返回 `{ success: true, data: { skipped: true, lines: [] } }`
- `settleWithTransaction` 在传入事务内做幂等预读，命中返回 `{ idempotent: true }`
- `batchSettle([])` 空数组视为合法空批次，返回 `{ success: true, data: { results: [] } }`
- **`ruleSetCode` 双传参契约**：三个入口 `settle(event, options)` / `settleWithTransaction(event, tx, options)` / `batchSettle(events, options)` 统一由 `options.ruleSetCode` 决定引擎**计算**选用的规则集；事件对象内的 `ruleSetCode` 字段不参与引擎选规则集（仅你的 `buildRecord` 用它落库 `rule_set_code` 审计列）。二者都缺省时退化为构造时 `config.ruleSetCode` 默认值。仅当**事件内 `ruleSetCode` 与本次生效规则集不一致**时 `_calculate` 才打 warn（那是「意图覆盖但传错位置」的确定信号）——正常依赖构造默认值不会产生日志噪音。需要覆盖规则集时务必显式传 `options.ruleSetCode`，并把事件内 `ruleSetCode` 也带上用于落库。

---

## 扩展指南

### 接入一个新客户（场景）

> 📖 完整接入指南（含 4 个行业 Demo 项目）见 **[`docs/006_多行业快速集成指南_2026-08-16.md`](docs/006_多行业快速集成指南_2026-08-16.md)** 和 **[`demo/`](demo/) 目录**。

1. **推荐方式：使用 `GenericSettlementService`**（需要 DB 落账的场景）
   - 在 `customer-configs/` 目录下创建客户配置对象（纯数据对象，非类）
   - 实例化 `GenericSettlementService` 传入配置，调用 `settle()` 方法
   - 详见上方 [Services — 框架服务](#services--框架服务) 示例，或 `demo/scenarios/04-full-settle.js`

2. **纯计算方式：使用 `customerAdapterTemplate`**（无需 DB 的纯计算场景）
   - 复制 `customerAdapterTemplate` 为 `customer-xxx-adapter.js`
   - 实现 `_mapMemberToNode`、`_mapEvent`、`_buildRankDefs`、`_buildRewardDefs`
   - 调用 `executeCustomerIncentive` 执行计算
   - 参考 `demo/scenarios/01~03-*.js`

```javascript
const { executeCustomerIncentive } = require("@usethink/incentive-engine").Adapters.customerAdapterTemplate;

const result = executeCustomerIncentive({
  event: { memberId: "user1", amount: "1000", type: "purchase" },
  // ⚠️ directParent 必须带 rankRate（等级比例，百分比整数）：
  //    skipRankZero 默认 true，rankRate 缺省为 0 会被当作最低等级而零发放。
  directParent: { id: "user0", parentId: null, directCount: 10, teamPerformance: "50000", rankRate: "10" },
  ruleSet: {
    config_json: { pipelineDef: { stages: [{ handler: "DISTRIBUTE" }] } },
    // ⚠️ rewardDef 必须带 rewardId（落库/对账标识），type/rate/target 为百分比整数语义。
    rewardDefs: [{ rewardId: "referral", type: "DIRECT", rate: "10", target: "PARENT" }],
    rankDefs: [{ rankId: "V0", levelIndex: 0, rankRate: "0" }],
  },
});
// result.final = [{ nodeId: "user0", rewardId: "referral", amount: "100", ... }]  // 1000 × 10%
```

**rankRate 的两条来路（二选一，缺一必零发放）**：

```javascript
// 方式 B：不预计算 rankRate，让引擎用 RANK 阶段按 rankDefs 现场评级
const result = executeCustomerIncentive({
  event: { memberId: "user1", amount: "1000", type: "purchase" },
  directParent: { id: "user0", parentId: null, directCount: 10, teamPerformance: "50000" }, // 无 rankRate
  ruleSet: {
    // RANK 必须排在 DISTRIBUTE 之前：它把命中等级的 rankRate 就地写入节点
    config_json: { pipelineDef: { stages: [{ handler: "RANK" }, { handler: "DISTRIBUTE" }] } },
    rewardDefs: [{ rewardId: "referral", type: "DIRECT", rate: "10", target: "PARENT" }],
    rankDefs: [
      { rankId: "V0", levelIndex: 0, rankRate: "0" },
      { rankId: "V1", levelIndex: 1, rankRate: "10",
        conditions: [{ type: "COMPARE", field: "directCount", operator: "GTE", value: 3 }] },
    ],
  },
});
// result.final = [{ nodeId: "user0", amount: "100", ... }]  // 命中 V1 → rankRate 10%
```

> ⚠️ **RANK 默认不覆盖宿主已预计算的 rankRate**（`node.rankRate !== undefined` 即视为宿主口径优先，
> 需覆盖请在 stage 上声明 `config: { overwrite: true }`）。因此**不要给节点兜底写 `rankRate: "0"`** ——
> 那会被当成「宿主已算好且为最低等级」而跳过评级，结果是静默零发放。没有预计算值时就别设这个字段。
> ⚠️ 两条来路都缺失时，`skipRankZero`（默认 `true`）会跳过发放并返回 `[]`。这是 fail-safe
> 方向（宁可少发不可超发）的有意设计，不是 bug；接入自测时先确认 `final` 非空再上量。

> ⚠️ 比例语义：`rate`/`ratio`/`rankRate` 均为**百分比整数**（`"10"` = 10%），不是小数。
> ⚠️ 流水线阶段：`pipelineDef.stages` 元素必须使用 `handler` 字段（如 `{ handler: "DISTRIBUTE" }`）。

---

## 开发

```bash
npm install      # 安装依赖
npm test         # 运行测试（覆盖全部模块）
npm run test:watch  # 观察模式
npm run smoke    # 顶层加载冒烟：模拟消费方 require 入口，防护可选 peer 误提升

cd demo && npm install && npm run demo:all   # 运行 4 个行业集成 Demo
```

### 发版防线

- `prepublishOnly` 在 `npm publish` 前执行 `scripts/verify-pack.js`，用 `npm pack --dry-run --json` 断言 tarball 必备文件（LICENSE / README / src 入口）齐全，发版零阻塞。
- `joi` / `sequelize` 为 **optional peerDependencies**：消费方缺装也能安全顶层加载（真正使用结算/校验功能时才需要）。改动引擎入口时请运行 `npm run smoke` 守护，勿把 optional peer 提升到顶层 `require`。

---

## License

MIT
