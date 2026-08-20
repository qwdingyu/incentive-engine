# @usethink/incentive-engine — 通用营销激励引擎

> **领域无关的纯计算核心**  
> 不查询数据库，不管理事务，不认识任何业务词（直推/极差/佣金/返利）。  
> 业务规则由上层翻译成 `rewardDefs`/`rankDefs`/`capDefs` 配置后交给引擎，引擎只做"输入 → 计算 → 输出"。

---

## 安装

```bash
npm install @usethink/incentive-engine
```

仅依赖 `decimal.js`（高精度金额计算）。如需使用校验模块，需自行安装 `joi`（peerDependency）；
`GenericSettlementService` 需要宿主提供 `sequelize`（peerDependency）。

包内自带 TypeScript 类型声明（`src/index.d.ts`，由 `package.json` 的 `types` 指向），
TS 项目无需额外安装 `@types/*`。

> ⚠️ **4.0.0 是资金安全导向的破坏性升级**：若干「配置写错却静默按最宽松口径放行」的路径
> 改为显式抛错或按最严口径处理。升级前请读 [`CHANGELOG.md`](CHANGELOG.md)，
> 并在预发环境用真实规则集与真实订单核对发放总额。

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
| `RewardDef` | 奖励定义（DIRECT/LEVEL/FIXED/CUSTOM，配置驱动；LEVEL 支持水位差 / 按层固定比例两种口径） |
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
| `calculateLevelChain` | 链式分配：按 `rankRate` 水位差（极差），或按 `levelRates` 每层固定比例；支持 `maxDepth` 层数上限 |

**LEVEL 的两种口径：水位差（极差）vs 按层固定比例**

```javascript
// A. 水位差（缺省）：每层拿「自身 rankRate − 下方已发水位」的差额 —— 极差/级差
{ rewardId: "team_diff", type: "LEVEL", accumulateInChain: true }

// B. 按层固定比例：第 n 层拿 levelRates[n-1] —— 一级 10%、二级 5%、三级 3%
{ rewardId: "multi_level", type: "LEVEL", levelRates: ["10", "5", "3"] }
```

- `levelRates` 索引 0 = 最近的祖先；**完全不读 `rankRate`、不推进水位**，各层相互独立。
- 比例表长度即隐式深度上限：第 4 层及以后不发。与 `maxDepth` 并存时取**更严**的一方
  （有效层数 = `min(levelRates.length, maxDepth)`）。
- 比例为 `0` 的层不发放但**仍占一层**（层号由链位置决定，不因跳过而前移）；
  记录的 `snapshot.depth` 即层号。
- ⚠️ 与 `accumulateInChain: true` **互斥并抛错**：水位差与按层固定比例的发放总额不同，
  静默择一等于悄悄改变发放金额。按层固定比例请不要写 `accumulateInChain`。
- ⚠️ 空数组 / 含负数、非数字、空值的元素 / 全为 `0` 一律**抛错**，不静默零发放；
  挂在非 `LEVEL` 类型上会被 `ruleSetConfigSchema` 拒绝。
- 按层固定比例的记录带 `snapshot.mode === "LEVEL_RATES"`（水位差记录无此字段），便于对账辨识；
  两套口径都满足 `amount = eventValue × diffRate`。

**LEVEL 的层数上限 `maxDepth`（深度风控）**

```javascript
{ rewardId: "team_diff", type: "LEVEL", accumulateInChain: true, maxDepth: 5 }
```

- 按**祖先链位置**计数：`1` = 最近的祖先。被跳过的层（`diffRate <= 0`，即同级/降级）同样占一层。
- 超出 `maxDepth` 的祖先完全不参与计算，也不推进链式水位。
- 缺省（不写该字段）= 不限层数，发放深度由你传入的 `ancestors` 数组长度决定。
- 非法值（`0` / 负数 / 小数 / 非数字）**抛错**，不静默忽略 —— 链深直接决定发放总额，
  一个写错的深度上限等于深度风控完全失效。
- 只对 `LEVEL` 有意义；挂在 `DIRECT`/`FIXED`/`CUSTOM` 上会被 `ruleSetConfigSchema` 拒绝。
- 每条 LEVEL 记录的 `snapshot.depth` 记录其层号，便于对账回溯。
- 与 `levelRates` 并存时取更严的一方（见上）。

**定点单层发放 `target: "ANCESTOR"`（只给第 n 层这一个人发）**

```javascript
// 只给祖先链第 3 层这一个节点发 3%（不遍历整链）
{ rewardId: "gen3", type: "DIRECT", target: "ANCESTOR", ancestorLevel: 3, rate: "3", skipRankZero: false }

// FIXED / CUSTOM 同样支持
{ rewardId: "gen2_red", type: "FIXED", target: "ANCESTOR", ancestorLevel: 2, fixedAmount: "50", skipRankZero: false }
```

- 目标节点 = `ancestors[ancestorLevel - 1]`，`1` = 最近的祖先，层号口径与 `maxDepth`/`levelRates` 一致。
- `DIRECT` / `FIXED` / `CUSTOM` 三种类型都可用；`LEVEL` **不支持**（LEVEL 本身就是遍历整条链，
  写 `target: "ANCESTOR"` 会被 `ruleSetConfigSchema` 拒绝）。
- 与 `levelRates: ["0","0","3"]` 的区别：后者语义上仍是链式遍历（产出多条 0 元候选的层号占位），
  前者只产出**一条**记录，对账口径更清晰。
- ⚠️ `target: "ANCESTOR"` 时 `ancestorLevel` **必填**：缺失或非法（`0` / 负数 / 小数 / 非数字）
  一律**抛错**，引擎不兜底取第 1 层 —— 「定点发第几层」配错等于把钱发给错误的人。
- ⚠️ 与 `PARENT` 一样受 `skipRankZero`（**缺省 `true`**）约束：目标节点 `rankRate <= 0`（含未评级）
  时静默跳过。定点发放的比例挂在规则上、与目标等级无关，因此**通常应显式写 `skipRankZero: false`**。
- 祖先链长度不足该层时**不产生记录且不抛错** —— 链路深浅是运行期网络结构，不是配置错误，方向上属于少发。
- `ancestorLevel` 挂在 `SOURCE`/`PARENT` 上会被 `ruleSetConfigSchema` 拒绝（防止误以为已按层寻址）。
- 记录的 `snapshot` 带 `target: "ANCESTOR"`、`ancestorLevel` 与 `depth`（层号，与 LEVEL 记录同名同义），
  两套按层寻址的原语可统一对账。

**发放门槛的数据源 `conditions[].source`（读事件 还是 读受益人）**

```javascript
// 只给 V2 以上的上级发佣（读受益节点自身字段）
{ rewardId: "p", type: "DIRECT", target: "PARENT", rate: "10", skipRankZero: false,
  conditions: [{ field: "vipLevel", operator: "GTE", value: 2, source: "target" }] }

// 事件侧 + 受益人侧混在同一棵树：订单满 1000 且上级团队业绩满 5 万
{ rewardId: "p2", type: "DIRECT", target: "PARENT", rate: "5", skipRankZero: false,
  conditions: [{ type: "AND", children: [
    { field: "orderAmount",     operator: "GTE", value: 1000,  source: "event"  },
    { field: "teamPerformance", operator: "GTE", value: 50000, source: "target" },
  ] }] }

// LEVEL 逐层求值：只给链上 V2 以上的祖先发，被拦下的层不推进水位、不改变其余层层号
{ rewardId: "lv", type: "LEVEL", levelRates: ["10", "5", "3"],
  conditions: [{ field: "vipLevel", operator: "GTE", value: 2, source: "target" }] }
```

- `source: "event"` 读事件对象，`source: "target"` 读**受益节点**（`attrs` 优先、回退顶层字段，
  与等级评估同一口径）。**不写 `source` 时数据源仍是事件** —— 既有配置行为逐位不变。
- `field` 用**扁平字段名**（如 `vipLevel`、`teamPerformance`），不支持点分路径；
  节点侧读取顺序为 `node.attrs[field]` → `node[field]` → `0`。
  （点分路径只在 `CUSTOM` 的 `amountFrom: "event.attrs.<path>"` 上支持。）
- `DIRECT`/`FIXED`/`CUSTOM` 对目标节点求值一次；`LEVEL` 沿祖先链**逐层**求值 ——
  被拦下的层不发放、**不推进水位**、也不改变其余层的层号（与 `diffRate <= 0` 跳过同一口径）。
- ⚠️ 未知 `source`、或声明了 `source` 但该数据源缺失，一律**抛错**，绝不静默回退到另一个数据源：
  回退会把「该拦住」翻成「放行」，方向上是超发。
- ⚠️ `target: "SOURCE"` + 受益人侧条件时必须额外传入 `sourceNode`（事件来源节点对象）——
  引擎手上只有 `event.sourceNodeId`，没有节点对象无法求值，缺失时抛错。
  `Adapters.buildPipelineStages({...}, { event, sourceNode, ... })` 与
  `GenericSettlementService` 的可选钩子 `buildSourceNode(event)` 都可注入。
- `PARENT`/`ANCESTOR` 的节点不存在（无上级 / 链长不足）属运行期网络结构 —— 静默不发、不抛错。
- 支持的比较操作符：`GTE` / `GT` / `LTE` / `LT` / `EQ` / `NE`（数值走高精度比较，
  非数值如 `"V3"` 走字符串相等）；`ruleSetConfigSchema` 会**递归校验整棵条件树**，
  `operator` 写错、`source` 拼错、`AND` 的 `children` 为空都在配置期报错并定位到具体字段。

### Allocate — 封顶/拆分/预算兜底

| 函数 | 用途 |
|------|------|
| `applyCaps` | 多维多周期封顶裁剪（`PLATFORM`/`PER_USER` × `DAILY`/`WEEKLY`/`MONTHLY`/`TOTAL`，见下） |
| `applyBudgetGuard` | 总预算兜底保护（CAP/WARN/REJECT） |
| `splitByTargets` | 按比例拆分（如 70/30 拆分到两个科目） |
| `compareAmounts` | 比较分配器（MAX/MIN/FIRST） |
| `applyCampaign` | 活动期加成（限时翻倍，必须排在 CAP 之前，见下） |
| `resolveActiveCampaigns` | 查询某时刻命中的活动（配置后台展示用，不产生记录） |
| `CAMPAIGN_MULTIPLIER_MAX` | 活动系数上限（倍数，10） |
| `CAP_SCOPES` | 合法封顶 scope 全集（8 个常量数组，宿主做配置后台时直接引用，不要各自硬编码） |

#### 封顶 scope：`<维度>_<周期>`（8 个全组合）

| | `DAILY` | `WEEKLY` | `MONTHLY` | `TOTAL` |
|---|---|---|---|---|
| `PLATFORM_` | 平台日封顶 | 平台周封顶 | 平台月封顶 | 平台活动总量封顶 |
| `PER_USER_` | 单用户日封顶 | 单用户周封顶 | 单用户月封顶 | 单用户活动总量封顶 |

```javascript
const capped = engine.Allocate.applyCaps(records, [
  { capId: "plat_month", scope: "PLATFORM_MONTHLY", limit: "50000" },
  { capId: "user_total", scope: "PER_USER_TOTAL",   limit: "800" },   // 活动总量：一个永不归零的水位行
], capState);
// 最终金额 = min(原金额, 各生效维度剩余额度)；snapshot.payoutCaps.boundBy 标出实际裁剪它的那个 scope
```

⚠️ **引擎不认识日期**。`PLATFORM_DAILY` 之所以是「日」封顶，靠的是宿主那行水位按业务日存、
跨天自然归零 —— 引擎侧四个周期的唯一差别是**水位分桶的键**。因此周期边界始终由宿主决定：
按 `biz_week` / `biz_month` / `campaign_id` 分行即得周/月/活动总量口径。
「活动总量封顶」不是单独的 scope，而是 `PLATFORM_TOTAL` / `PER_USER_TOTAL` + 一行按活动键存、
活动期内不归零的水位。

水位 `state` 的形状：`DAILY` 仍复用顶层 `platformPaid` / `memberPaid`（老宿主零改动），
其余周期落在 `state.periods[周期]`，且**只在该周期真的配了封顶时才创建**：

```javascript
{ platformPaid: "100", memberPaid: Map { "u0" => "100" },      // DAILY（唯一存放处，不重复进 periods）
  periods: { MONTHLY: { platformPaid: "1100", memberPaid: Map { "u0" => "1100" } } } }
```

跨结算周期封顶（`_WEEKLY` / `_MONTHLY` / `_TOTAL`）**必须**成对配置
`loadCapState` / `saveCapState`，否则 `GenericSettlementService` 直接拒绝结算（见下节）：
水位每次从 0 起算时，「月封顶 5 万」实际是「单事件封顶 5 万」，跑 100 单就发 500 万 ——
那是比不配封顶更危险的**虚假保障**。宿主还需连同 `capState.periods` 一起持久化/还原
（`memberPaid` 必须还原成 `Map`；缺失或类型不对时 `applyCaps` **抛错**，绝不按 0 起算）。

### Evaluate — 等级/条件评估

| 函数 | 用途 |
|------|------|
| `evaluateTier` | 判断单个节点是否满足某个等级条件 |
| `getHighestQualifiedTier` | 获取节点可达的最高等级（遍历全部等级） |
| `evaluateCondition` | 递归评估条件树（COMPARE/AND/OR/NOT），支持 `source: "event"｜"target"` 命名数据源 |

### Reverse — 冲正（退款/撤单追回）

发放侧的镜像原语：把**已发放**的收益记录按比例反向追回，产出负金额记录。

| 函数 | 用途 |
|------|------|
| `reverseRecords` | 按比例冲正一批已发放收益记录（纯计算，不查库） |
| `REVERSAL_DIRECTION` | 冲正记录的方向标记常量（`"REVERSAL"`） |

```javascript
const { records, summary } = engine.Reverse.reverseRecords({
  // 宿主从自己库里还原的原始收益记录（引擎不查库、不认识订单/退款/佣金）
  originalRecords: [
    { recordId: 9001, nodeId: "user0", amount: "100", rewardId: "referral" },
  ],
  ratio: "30",                       // 部分退款 30% → 追回 30
  reversedMap: new Map([[9001, "0"]]), // recordId → 已冲正累计（正数）
  onExceed: "CLAMP",                 // 缺省；超过剩余额度时裁剪
  reasonCode: "REFUND",              // 可选，透传到 snapshot 便于对账
});
// records = [{
//   nodeId: "user0", rewardId: "referral",
//   amount: "-30",            // 负数：宿主 SUM(amount) 即净发放额，无需 CASE WHEN
//   reversedAmount: "30",     // 正数绝对值：偏好「正金额 + 方向列」记账的宿主用这个
//   direction: "REVERSAL", originalRecordId: 9001,
//   snapshot: { reversal: { originalAmount: "100", alreadyReversed: "0",
//                           remainingBefore: "100", ratio: "30", basis: "RATIO",
//                           reasonCode: "REFUND" } },
// }]
// summary = { ratio: "30", basis: "RATIO", recordCount: 1, skippedCount: 0,
//             clampedCount: 0, totalOriginal: "100", totalReversed: "30" }
```

**冲正比例的两种口径（二选一，且必须恰好一种）**

```javascript
{ ratio: "100" }                                        // 全额追回
{ ratio: "30" }                                         // 按百分比部分追回
{ reversalValue: "300", originalEventValue: "1000" }     // 按金额占比推导（退 300 / 订单 1000 = 30%）
```

- ⚠️ **冲正比例没有缺省值**：两种都不传直接**抛错**，绝不默认 100% —— 默认全额追回属于
  「超额扣款」方向，配漏了等于凭空多扣用户的钱。两种同时传也抛错（静默择一等于悄悄改追回金额）。
- `reversalValue > originalEventValue`（比例 > 100%）抛错；`ratio` 必须 `0 < ratio <= 100`。
- 按金额占比时 `summary.basis === "EVENT_VALUE"`，`snapshot.reversal` 额外带
  `reversalValue` / `originalEventValue`；按百分比时 `basis === "RATIO"`。

**资金安全约束（方向与发放侧相反但同源：宁可少追回，不可超额追回）**

- 金额一律 **`ROUND_DOWN` 截断到 4 位**：`33.3333 × 30%` 得 `"9.9999"` 而不是四舍五入的
  `10.0000` —— 追回侧多一分钱就是从用户账上凭空多扣。
- **累计冲正永不超过原始发放额**：`reversedMap` 提供每条记录的已冲正累计，本次超出剩余额度时
  `onExceed: "CLAMP"`（缺省）裁剪到剩余额度并在 `snapshot.reversal.clamped` 标记、
  计入 `summary.clampedCount`；`onExceed: "REJECT"` 抛错。
- ⚠️ **多次部分退款场景必须传 `reversedMap`**：不传视为「全部未冲正」，两次 60% 退款会累计追回
  120% —— 超额扣款。`reversedMap` 支持 `Map` 与普通对象两种形态。
- **已全额冲正的记录不再产出第二条**（重复退款回调的计算侧幂等保障），计入 `summary.skippedCount`。
- ⚠️ **不能对冲正记录再冲正**：传入 `direction: "REVERSAL"` 或负金额的记录一律**抛错** ——
  负金额 × 比例 = 正金额，会变成「反向发钱」，这是最危险的一类静默错误。
- `recordId`（或 `id`）与 `nodeId`（或 `memberId`）缺失即抛错：`recordId` 是「已冲正累计」的
  查找键，缺了「累计不超额」的约束会静默失效。
- `originalRecords: []` 返回空结果**不抛错**（订单本来就没发过佣金是正常运行期情况）；
  但传非数组（漏传）抛错 —— 静默返回空等于「所有退款都不追回」。

**⚠️ 冲正记录不得流经 `CAP` / `OVER`**

`Allocate.applyCaps` 与 `Allocate.applyBudgetGuard` 遇到负金额或 `direction: "REVERSAL"` 的记录
**当场抛错**（`不接受冲正/负金额记录`）。原因：负金额会反向推进封顶水位、释放当日已用预算，
使后续发放突破日限额 —— 「下单发佣 → 退款 → 再下单」即可套出超额佣金。

封顶水位**默认不随冲正回退**，这是有意的最安全口径。是否回退属于宿主的业务决策，
若确需回退请自行在 `capState` 上处理，并明确知道它会释放当日预算。

**流水线里的 `REVERSE` 阶段**

```javascript
const result = engine.Orchestrate.executePipeline({
  stages: [{ id: "rev", handler: "REVERSE", config: { originalRecords, ratio: "30", reversedMap } }],
});
// result.final = 冲正记录数组；result.context.reversalSummary = summary
```

- **`REVERSE` 与 `DISTRIBUTE` 在同一条流水线内互斥**（两个顺序都抛错）：正负记录混批会污染
  封顶水位与对账口径。追回与发放请拆成两次 `executePipeline` 调用。
- 一条流水线**最多一个 `REVERSE`**（多个冲正没有合并语义，静默覆盖会漏追回），
  且必须是第一个产出记录的阶段（前序已有记录即抛错）。
- ⚠️ **`REVERSE` 不能写进规则集**：`ruleSetConfigSchema` 的 handler 白名单**故意排除**它 ——
  冲正需要运行期的原始收益记录（宿主查库还原），静态规则集声明出来必然缺 `originalRecords`
  而在计算期抛错。冲正走 `Reverse.reverseRecords`、流水线 `REVERSE` 阶段或
  `GenericSettlementService.reverse()` 三个运行期入口。

### Campaign — 活动期加成（限时翻倍）与规则集生效期

「双十一佣金翻倍」「开业首周 1.5 倍」「规则集只在活动期内生效」这三类**带时间维度**的
需求由 `Allocate.applyCampaign` + 规则集 `effective` 提供。加成系数直接放大发放金额，
因此这里的每条约束方向都是 fail-closed。

**引擎只认「绝对时刻」—— 不认识日期，也绝不调用 `Date.now()`**

时刻一律由宿主显式提供，且只接受两种无歧义写法：

- `Date` 实例；
- **带显式偏移量**的 ISO-8601 字符串（`"2026-11-11T00:00:00+08:00"` / `"...Z"`）。

被**显式拒绝**（抛错，不猜测时区）的输入，全部是静默算错时刻的来源：

| 写法 | 为什么拒绝 |
|------|-----------|
| `"2026-11-11T00:00:00"` | 无偏移量 → V8 按**进程本地时区**解析，同一配置在不同环境相差数小时 |
| `"2026-11-11"` | 纯日期 → V8 按 **UTC** 解析，与上一条口径**相反** |
| `1762790400`（数字时间戳） | 秒与毫秒无法区分：传秒会落到 1970 年，窗口永不命中（加成静默失效） |

时刻必须是**事件真实发生时刻**（下单/支付时间），不是结算执行时刻 —— 引擎不用「当前时间」
兜底正是为此：结算重试、补跑昨天的单、对账重算都在活动窗口之外执行，用「现在」判定
等于给历史订单套上今天的系数（超发），或让当天的单错过当时的活动（少发）。

**窗口一律左闭右开 `[startAt, endAt)`，两端都必填**

相邻窗口不会同时命中，也不必纠结 `23:59:59` 与 `24:00:00`。缺 `endAt` 的开口窗口
= 永久翻倍 = 持续超发，因此在配置期即被拒绝。

**`multiplier` 是「倍数」不是百分比，上限 `CAMPAIGN_MULTIPLIER_MAX`（10）**

`2` 表示翻倍、`1.5` 表示 1.5 倍、不加成写 `1`。设上限是因为「把 100%（即不加成）
误写成 `multiplier: 100`」是最容易犯的一类配置错误 —— 无上限会直接把发放额放大 100 倍。
加成后金额一律 **`ROUND_DOWN`** 截断到 4 位（`33.3333 × 1.5 = "49.9999"`，不是四舍五入的 `50.0000`）。

```javascript
const { records, summary } = engine.Allocate.applyCampaign(
  [{ rewardId: "referral", nodeId: "u1", amount: "100" }],
  [{
    campaignId: "dbl11",
    startAt: "2026-11-11T00:00:00+08:00",
    endAt:   "2026-11-12T00:00:00+08:00",   // 左闭右开：11-12 00:00:00 当刻已不在活动内
    multiplier: "2",                        // 倍数：2 = 翻倍
    rewardIds: ["referral"],                // 可选，限定加成范围；省略 = 全部奖励项
  }],
  { occurredAt: "2026-11-11T10:00:00+08:00" }   // 事件发生时刻，宿主提供
);
// records[0].amount === "200"
// records[0].snapshot.campaign = { campaignId, multiplier, originalAmount, boostedAmount, occurredAt, window, rewardIds? }
// summary = { occurredAt, activeCampaignIds, boostedCount, untouchedCount, totalBefore, totalAfter, byCampaign }
```

- **不修改入参**：命中活动的记录返回**新对象**，未命中的记录原样透传（引用不变）。
- `campaignDefs: []`（空数组）表示当前无活动，原样返回且**不需要 `occurredAt`** ——
  活动结束后规则集仍保留 CAMPAIGN 阶段是正常运维状态。漏传（非数组）抛错。
- 活动定义**先整体校验一遍**：配错的活动即使当前不在窗口内也当场暴露，
  而不是等到活动开始那一刻才抛错（最不该出问题的时点）。
- `rewardIds` 省略 = 加成全部奖励项；写**空数组**抛错（空数组语义是「谁都不加成」，与省略相反）。
- 负金额 / `direction: "REVERSAL"` 的记录抛错：放大冲正金额等于从用户账上多扣钱。
- `Allocate.resolveActiveCampaigns(campaignDefs, occurredAt, { rewardId? })` 可单独查询
  某时刻命中的活动（做配置后台的「当前生效活动」展示用），不产生记录。

**⚠️ 一条记录被多个活动同时命中 → 抛错**

多个系数相乘是数倍超发，静默取其一等于悄悄改变发放金额。静态可判的窗口重叠
（`rewardIds` 有交集且窗口相交）已由 `Validation` 在**配置期**拒绝，运行期这条是兜底。
真要并行多个活动，请用 `rewardIds` 把加成范围拆开。

**⚠️ `CAMPAIGN` 阶段必须排在 `DISTRIBUTE` 之后、`CAP` / `OVER` 之前**

加成后的金额才应受封顶约束。排在 `CAP` 之后 = 加成绕过日限额：`limit: "100"` 的日封顶下
先裁到 100 再翻倍会发出 200，日限额形同虚设。这条顺序在三处同时把守：
`Orchestrate.executePipeline` 抛错、`ruleSetConfigSchema` 配置期拒绝、
`Adapters.buildPipelineStages` 的缺省流水线在**存在 `campaignDefs` 时自动插入**
`DISTRIBUTE → CAMPAIGN → CAP`（写了 `pipelineDef` 则按你写的顺序校验）。

```javascript
const result = engine.Orchestrate.executePipeline({
  stages: [
    { id: "d", handler: "DISTRIBUTE", config: { event, directParent, rewardDefs } },
    { id: "camp", handler: "CAMPAIGN", config: { campaignDefs, occurredAt } },
    { id: "cap", handler: "CAP", config: { capDefs } },   // 100 × 2 = 200 → 封顶 150
  ],
});
// result.context.campaignSummary = summary（与 REVERSE 的 reversalSummary 同一口径）
```

一条流水线**最多一个 `CAMPAIGN`**（多个加成没有合并语义），且 `REVERSE` 与 `CAMPAIGN`
互斥（冲正记录不参与加成）。

**规则集生效期 `effective`：过期规则集不再发放**

```javascript
// 规则集 config_json
{
  effective: { startAt: "2026-11-01T00:00:00+08:00", endAt: "2026-12-01T00:00:00+08:00" },
  campaignDefs: [ /* ... */ ],
  rewardDefs: [ /* ... */ ],
}
```

事件发生时刻不落在 `[startAt, endAt)` 内时，`GenericSettlementService.settle()` 返回
`{ success: false, message: "...不在生效期内..." }`，**不开事务、不落任何记录**（少发方向）。
过期规则集若静默按原比例继续发，等于「双十一的翻倍规则一直发到十二月」。

**服务层的 `buildOccurredAt` 钩子**

```javascript
const service = new GenericSettlementService({
  // ...
  // 缺省实现读 businessEvent.occurredAt；字段名不同时指过去即可
  buildOccurredAt: (event) => event.paidAt,   // Date 实例或带偏移量 ISO-8601
});
```

仅当规则集带时间维度（`effective` / 非空 `campaignDefs`）时必需。取不到时结算返回
`{ success: false }` 并在消息里指名 `buildOccurredAt` —— **引擎不会用当前时间兜底**。
时刻或窗口非法（如漏写时区偏移）同样返回 `{ success: false }`，而不是当作
「在生效期」或「不在生效期」的任一方向静默兜底：两个方向都会算错钱。

### Orchestrate — 流水线编排

内置阶段 handler：`DISTRIBUTE`（奖励分配）、`RANK`（等级评估，写入节点 rankRate）、`CAMPAIGN`（活动期加成，见上节）、`CAP`（封顶）、`OVER`（预算兜底）、`SPLIT`（金额拆分）、`REVERSE`（冲正追回，见上节）。阶段按顺序执行，共享 context（封顶水位）；节点为对象引用，前序阶段对节点的就地修改对后续阶段立即可见。

阶段顺序的四条硬约束（均**抛错**，不静默出错）：

- **`RANK` 必须排在 `DISTRIBUTE` 之前**。`RANK` 的输出是空数组，排在 `DISTRIBUTE` 之后会把
  前序收益记录清空导致零发放，因此这种顺序当场报错。
- **第 2 个及以后的 `DISTRIBUTE` 必须声明 `config.merge`**：`"append"`（累加到前序记录，
  多组奖励并存）或 `"replace"`（显式丢弃前序，仅保留本阶段）。没有缺省值 ——
  缺省静默覆盖会让前序 `DISTRIBUTE` 的记录无声消失（配了两组奖励只发一组）。
  单个 `DISTRIBUTE` 的流水线不受影响。
- **`CAMPAIGN` 必须排在 `DISTRIBUTE` 之后、`CAP` / `OVER` 之前**，且一条流水线最多一个。
  排在封顶之后等于让加成金额绕过日限额（详见上节
  [Campaign — 活动期加成](#campaign--活动期加成限时翻倍与规则集生效期)）。
- **`REVERSE` 与 `DISTRIBUTE` 互斥，且一条流水线最多一个 `REVERSE`**（详见上节
  [Reverse — 冲正](#reverse--冲正退款撤单追回)）。冲正记录随后进入 `CAP`/`OVER` 同样抛错。

```javascript
const result = engine.Orchestrate.executePipeline({
  stages: [
    { id: "rank", handler: "RANK", config: { nodes, rankDefs } },
    { id: "d1", handler: "DISTRIBUTE", config: { event, directParent, rewardDefs: groupA } },
    { id: "d2", handler: "DISTRIBUTE", config: { event, ancestors, rewardDefs: groupB, merge: "append" } },
    { id: "cap", handler: "CAP", config: { capDefs } },
  ],
});
```

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
| `parseInstant` | 解析绝对时刻为 epoch 毫秒（只接受 Date / 带偏移量 ISO-8601，见 Campaign 节） |
| `isWithinWindow` | 判定时刻是否落在左闭右开窗口 `[startAt, endAt)` 内 |

### Decimal — 高精度金额

| 导出 | 用途 |
|------|------|
| `Decimal` | decimal.js 实例（工厂模式，支持 `Decimal.pct`、`Decimal.toDisplay` 等扩展方法） |

### Services — 框架服务

框架服务层构建在引擎纯计算核心之上，提供与业务集成（DB、事务、幂等）的通用编排能力。

| 服务 | 用途 | 依赖 |
|------|------|------|
| `GenericSettlementService` | 配置驱动的事件→引擎→DB 结算编排（含退款冲正入口 `reverse()`），80% 重复代码消除 | Sequelize（可选 peer） |

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
  // 规则集带时间维度（effective 生效期 / campaignDefs 活动加成）时必需；缺省读 event.occurredAt。
  // 必须是事件真实发生时刻，且带时区偏移 —— 见上节 Campaign。
  buildOccurredAt: (event) => event.paidAt,
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

#### 跨事件封顶水位（`loadCapState` / `saveCapState`）— 封顶真正生效的前提

引擎的 `CAP` 阶段在**一次 `executePipeline` 调用内**累计水位。若不配置下面这对钩子，
每次结算的水位都从零开始 —— `PLATFORM_DAILY: { limit: "100" }` 下三笔订单会各发 100、当天累计 300，
「平台日封顶」实际只是「单事件封顶」。

周期越长，这个缺口越致命：`_WEEKLY` / `_MONTHLY` / `_TOTAL` 封顶**必须**成对配置这两个钩子，
否则 `_calculate` 直接返回 `{ success: false }` 并指名缺哪一个（`DAILY` 维持历史行为，
未配钩子照旧运行，不破坏既有接入方）。

```javascript
const service = new GenericSettlementService({
  // ...上面的必填配置
  // 结算前读当天已发水位（返回 null/undefined 时引擎自建零水位，等同不配置）
  loadCapState: async () => {
    const row = await CapWaterMarkModel.findOne({ where: { biz_date: today() } });
    if (!row) return null;
    return {
      platformPaid: row.platform_paid,                       // decimal string
      memberPaid: new Map(Object.entries(row.member_paid || {})),  // Map<nodeId, decimal string>
    };
  },
  // 落账之后、同一事务内持久化推进后的水位（任一步失败即整体回滚）
  saveCapState: async (capState, transaction) => {
    await CapWaterMarkModel.upsert({
      biz_date: today(),
      platform_paid: capState.platformPaid,
      member_paid: Object.fromEntries(capState.memberPaid),
    }, { transaction });
  },
});
```

配了周/月/活动总量封顶时，`capState.periods` 也要一起存取（键即周期名，`memberPaid` 还原成 `Map`）：

```javascript
const service = new GenericSettlementService({
  loadCapState: async () => {
    // 一行一个周期桶：biz_date / biz_week / biz_month / campaign_id 各自一行，键决定周期语义
    const rows = await CapWaterMarkModel.findAll({ where: { bucket_key: [dayKey(), monthKey()] } });
    const state = { platformPaid: "0", memberPaid: new Map(), periods: {} };
    for (const row of rows) {
      const bucket = {
        platformPaid: row.platform_paid,
        memberPaid: new Map(Object.entries(row.member_paid || {})),
      };
      // DAILY 只放顶层（唯一存放处），其余周期放 periods
      if (row.period === "DAILY") Object.assign(state, bucket);
      else state.periods[row.period] = bucket;
    }
    return state;
  },
  saveCapState: async (capState, transaction) => {
    const buckets = [["DAILY", dayKey(), capState], ...Object.entries(capState.periods || {})
      .map(([period, b]) => [period, bucketKeyOf(period), b])];
    for (const [period, bucketKey, b] of buckets) {
      await CapWaterMarkModel.upsert({
        bucket_key: bucketKey, period,
        platform_paid: b.platformPaid,
        member_paid: Object.fromEntries(b.memberPaid),
      }, { transaction });
    }
  },
});
```

要点：

- **必须成对配置**。只配 `loadCapState` 不配 `saveCapState`，水位读进来却不落库，下一笔又归零。
- `saveCapState` 在结算事务内调用，与收益记录**原子提交**，不会出现「钱发了、水位没涨」的半截状态。
- `batchSettle` 内部会把上游事件推进后的水位传给下游事件，批量内封顶连续生效。
- 不配置时**日**封顶行为与 3.4.x 完全一致（不破坏既有接入方），但请明确知道：此时日封顶未真正生效；
  非日周期封顶则会被直接拒绝，不允许静默退化。
- 水位表建议按业务日（`biz_date`）分行，跨天自然归零；`memberPaid` 体积随当日活跃节点数增长，
  单用户维度封顶的高并发场景建议改为按 `nodeId` 独立行 + 行锁，避免整表 JSON 的写热点。
- 周期语义由**水位行的键**决定（引擎不认识日期）：

  | 封顶周期 | 水位行键（建议） | 归零方式 |
  |---------|----------------|---------|
  | `DAILY` | `biz_date = 2026-08-20` | 跨天换行，自然归零 |
  | `WEEKLY` | `biz_week = 2026-W34` | 跨周换行 |
  | `MONTHLY` | `biz_month = 2026-08` | 跨月换行 |
  | `TOTAL`（活动总量） | `campaign_id = 1111_dbl11` | 活动期内**不换行**、永不归零 |

  同一次结算可以同时命中多行（如日 + 月 + 活动总量），最终金额取各维度剩余额度的最小值。
  读水位建议加行锁：并发结算各读到过期水位会合计超发（与冲正侧同一类并发风险）。

#### `useBulkCreate`（可选，缺省 `false`）

一次事件产出 N 条收益记录时，缺省逐条 `model.create` 就是 N 次 DB round-trip；
深链路（10~20 层）下这是结算耗时主要来源。置 `true` 改用 `model.bulkCreate` 一次插入。

不默认开启的原因：`bulkCreate` 返回实例的主键回填**依赖数据库方言**，而返回值会经
`data.lines` 与 `postProcess` 暴露给宿主。若你的 `postProcess` 或调用方依赖自增主键，
请先在你的方言上验证再开启。

#### `reversal` 冲正块与 `reverse()`（退款/撤单追回）

配置可选的 `reversal` 块后即可用 `service.reverse(refundEvent)` 一键冲正：读回原始收益记录 →
调 `Reverse.reverseRecords` 计算 → 负金额行落库，全程在**同一事务**内。

```javascript
const service = new GenericSettlementService({
  // ...上面的发放侧必填配置
  reversal: {
    // 1. 还原本次退款对应的原始收益记录（建议在这里加行锁，见下方并发提示）
    loadOriginalRecords: async (e, { transaction }) =>
      RewardModel.findAll({ where: { order_id: e.orderNo, direction: null }, transaction, lock: transaction.LOCK.UPDATE }),
    // 2. DB 行 → 引擎入参（recordId 是「已冲正累计」的查找键，必填）
    buildOriginalRecord: (row) => ({ recordId: row.id, nodeId: row.member_id, amount: row.amount, rewardId: row.reward_id }),
    // 3. 本次冲正比例：{ ratio } 或 { reversalValue, originalEventValue }（没有缺省值）
    resolveReversal: (e) => ({ reversalValue: e.refundAmount, originalEventValue: e.orderAmount, reasonCode: "REFUND" }),
    // 4. 可选但强烈建议：recordId → 已冲正累计（多次部分退款不传会累计超额追回）
    loadReversedMap: async (e, { transaction }) => {
      const rows = await RewardModel.findAll({ where: { order_id: e.orderNo, direction: "REVERSAL" }, transaction });
      const m = new Map();
      for (const r of rows) m.set(r.original_record_id, engine.Decimal.add(m.get(r.original_record_id) || "0", r.reversed_amount));
      return m;
    },
    // 5. 引擎冲正记录 → 落账行（record.amount 为负、reversedAmount 为正）
    buildRecord: (e, record) => ({
      member_id: record.nodeId, amount: record.amount, reversed_amount: record.reversedAmount,
      direction: record.direction, original_record_id: record.originalRecordId,
      order_id: e.orderNo, refund_id: e.refundNo,
    }),
    // 6. 冲正专属幂等键（通常是退款单号，与发放侧的订单号独立）
    idempotency: {
      buildPreReadWhere: (e) => ({ refund_id: e.refundNo }),
      buildFallbackWhere: (e) => ({ refund_id: e.refundNo }),
    },
    // 7. 可选：冲正落账后的钩子（发放侧 postProcess 不会被调用）
    // postProcess: async (e, rows, transaction) => { ... },
  },
});

const r = await service.reverse({ orderNo: "SO123", refundNo: "RF456", refundAmount: "300", orderAmount: "1000" });
// { success: true, data: { lines: [...], summary: { ... } }, idempotent: false }
```

`reverse()` 与 `settle()` 的**三处有意差异**：

1. **计算在事务内**：冲正金额取决于库里的当前值（已发多少、已冲正多少），必须与读取同处一个
   事务。请在 `loadOriginalRecords` 里加行锁 —— 否则两个并发退款回调各自读到过期的
   「已冲正累计」，双方都判定还有余额，合计追回超过原始发放额。
2. **幂等键独立**：用 `reversal.idempotency`（通常按退款单号），不复用发放侧的订单号 ——
   否则同一订单的第二次部分退款会被误判为重复回调而整笔跳过（漏追回）。
3. **不回退封顶水位**：`saveCapState` / `loadCapState` 在冲正路径上完全不参与（回退会释放当日
   预算，「下单发佣 → 退款 → 再下单」即可套出超额佣金）。

行为要点：

- 未配置 `reversal` 时 `reverse()` 返回 `{ success: false, message: "... 未配置 reversal 冲正块 ..." }`，不抛错。
- 配了 `reversal` 却缺子项（`loadOriginalRecords` / `buildOriginalRecord` / `resolveReversal` /
  `buildRecord` / `idempotency`）在**构造期**抛错（fail-fast），不留到退款回调那一刻才发现。
- 幂等预读命中 → `{ success: true, data: { lines }, idempotent: true }`，**不开启事务**、不二次扣款；
  唯一约束冲突走 `buildFallbackWhere` 兜底（需注入 `UniqueConstraintError`）。
- 无原始记录 / 全部已冲正 / `buildRecord` 全部返回 `null` → `{ success: true, data: { skipped: true, lines: [] } }` 并回滚空事务。
- 失败一律返回 `{ success: false, message }`（与 `settle` 的错误契约一致），事务已回滚、零落账。

**settle 流程优化（v3.0）**：
- 计算阶段在**事务外**执行：规则集加载失败 / `buildRecord` 全部过滤时直接返回，不开启事务
- 无落账记录时返回 `{ success: true, data: { skipped: true, lines: [] } }`
- `settleWithTransaction` 在传入事务内做幂等预读，命中返回 `{ idempotent: true }`
- `batchSettle([])` 空数组视为合法空批次，返回 `{ success: true, data: { results: [] } }`
- **`ruleSetCode` 双传参契约**：三个入口 `settle(event, options)` / `settleWithTransaction(event, tx, options)` / `batchSettle(events, options)` 统一由 `options.ruleSetCode` 决定引擎**计算**选用的规则集；事件对象内的 `ruleSetCode` 字段不参与引擎选规则集（仅你的 `buildRecord` 用它落库 `rule_set_code` 审计列）。二者都缺省时退化为构造时 `config.ruleSetCode` 默认值。仅当**事件内 `ruleSetCode` 与本次生效规则集不一致**时 `_calculate` 才打 warn（那是「意图覆盖但传错位置」的确定信号）——正常依赖构造默认值不会产生日志噪音。需要覆盖规则集时务必显式传 `options.ruleSetCode`，并把事件内 `ruleSetCode` 也带上用于落库。

---

## 扩展指南

### 接入一个新客户（场景）

> 📖 更完整的多行业接入指南与 4 个可运行 Demo 场景位于**源码仓库**的 `docs/` 与 `demo/` 目录。
> 为避免内部文档随包分发，npm tarball 只包含 `src/` + `README.md` + `CHANGELOG.md`，
> 因此这两个目录**不在你安装的包里**；本文档已包含全部对外 API 的可运行示例，独立看即可完成接入。

1. **推荐方式：使用 `GenericSettlementService`**（需要 DB 落账的场景）
   - 在 `customer-configs/` 目录下创建客户配置对象（纯数据对象，非类）
   - 实例化 `GenericSettlementService` 传入配置，调用 `settle()` 方法
   - 详见上方 [Services — 框架服务](#services--框架服务) 示例（源码仓库另有 `demo/scenarios/04-full-settle.js`）

2. **纯计算方式：使用 `customerAdapterTemplate`**（无需 DB 的纯计算场景）
   - 复制 `customerAdapterTemplate` 为 `customer-xxx-adapter.js`
   - 实现 `_mapMemberToNode`、`_mapEvent`、`_buildRankDefs`、`_buildRewardDefs`
   - 调用 `executeCustomerIncentive` 执行计算（下方即为完整可运行示例）

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
