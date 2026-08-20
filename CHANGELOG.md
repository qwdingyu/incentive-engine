# 变更日志

本文件记录 `@usethink/incentive-engine` 的对外可见变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 3.4.x 及更早版本未维护本文件，其变更请查阅 git 提交历史。

---

## [4.0.0] — 未发布

本版本是一次**资金安全导向的破坏性升级**。全部破坏性变更的方向都是
**fail-closed（宁可少发，不可超发）**：此前若干「配置写错却静默按最宽松口径放行」的路径，
现在改为显式抛错或按最严口径处理。

**升级前必读**：如果你的生产配置正踩在下述任一静默路径上，升级后会从「静默超发」变成
「显式报错」或「金额变小」。请先在预发环境用真实规则集与真实订单跑一遍回归，
核对发放总额，再上生产。

### 破坏性变更（资金行为）

- **`Allocate.applyCaps`：未知封顶 `scope` 从静默放行改为抛错。**
  此前 `scope` 写错（如 `PER_USER_MONTHLY`）会被当作「无此维度封顶」而完全不裁剪，
  直接超发；现在抛 `applyCaps：未知封顶 scope "..."`。合法值仅
  `PLATFORM_DAILY` / `PER_USER_DAILY`。
- **`Allocate.applyCaps`：同一 `scope` 配置多条时改取【最严】（`limit` 最小）。**
  此前取第一条，更严的后续条目被静默忽略（`limit:1000` 在前、`limit:100` 在后时
  实际按 1000 封顶）。
- **`Allocate.splitByTargets`：`targets` 的 `ratio` 之和不等于 100 时抛错。**
  此前按各自比例拆分后由最后一项补差，总和 ≠ 100 的配置会静默少拆或多拆。
  校验层 `allocatorSchema` 同步拦截。
- **`Evaluate.evaluateTier`：`levelIndex > 0` 且无任何晋升门槛时改判为「不满足」。**
  此前既无 `conditions` 也无遗留 `min_*` 门槛的等级会逐项跳过检查而 `return true`，
  导致漏配 `conditions` 时所有节点直接命中最高等级、顶格分成（超发）。
  校验层同步拒绝这类 `rankDefs`。
- **`Decimal.div`：除数为 0 时抛错**，不再返回 `Infinity`/`NaN` 污染后续金额计算。
- **`Allocate.applyCaps`：`onExceed: "ALERT_ONLY"` 的边界判定从 `<` 改为 `<=`。**
  金额恰好用尽剩余额度不再被标记 `alertOnly`（那本就不是超发）。
- **`Utils.addBusinessDays`：修复夏令时切换日的结果偏移。**
  同一输入在 `America/New_York` / `Asia/Shanghai` / `UTC` 下结果现在完全一致。

### 破坏性变更（接口契约）

- **`GenericSettlementService.batchSettle`：落账异常改为返回 `{ success: false, message }`，不再抛出。**
  与该方法其他失败出口及 `settle` 的错误契约统一。事务已回滚、本批零落账，
  调用方只检查 `success` 即可，不会再漏账。若你原来用 `try/catch` 兜批量失败，
  请改为判断返回值。
- **`Validation.createRuleSetValidation`：新增两条拒绝规则** —— `levelIndex > 0` 且无
  `conditions` 的 `rankDefs`、`ratio` 之和 ≠ 100 的 `allocators`。原本能通过校验的
  配置可能开始报错。
- **`Adapters.customerAdapterTemplate` 行为修正**（详见「修复」）：
  `_buildRewardDefs` 的 `accumulateInChain` 缺省由 `true` 改为 `false`，
  `_mapMemberToNode` 不再给无 `rankRate` 的节点兜底写 `"0"`。

### 新增

- **跨事件封顶水位钩子（资金安全，最重要的一项）**：`GenericSettlementService` 新增
  可选配置 `loadCapState(options) => Promise<capState|null>` 与
  `saveCapState(capState, transaction) => Promise<void>`。
  此前每次结算的封顶水位都从零开始，`PLATFORM_DAILY` 实际只在单个事件内生效 ——
  `limit: "100"` 下三笔订单会各发 100、累计 300。成对配置这两个钩子后，
  水位在结算事务内与收益记录原子提交，跨事件、跨批次、跨进程重启都连续累计。
  **未配置时行为与 3.4.x 完全一致**（不破坏现有接入方），但那意味着日封顶并未真正生效，
  强烈建议接入。
  - `batchSettle` 内部也会把上游事件推进后的水位传给下游事件，批量内封顶连续生效。
- **`GenericSettlementService` 新增可选配置 `useBulkCreate`（缺省 `false`）**：
  置 `true` 时用 `model.bulkCreate` 一次插入全部收益记录，把 N 次 DB round-trip 压成 1 次。
  不默认开启的原因是 `bulkCreate` 返回实例的主键回填依赖数据库方言，
  而返回值会经 `data.lines` 与 `postProcess` 暴露给宿主。
- **`tests/fund-invariant.test.js`**：跨事件资金不变量测试，断言「N 个事件累计发放 ≤ 日限额」。

### 修复

- **`Adapters.customerAdapterTemplate` 的四个缺陷**（官方接入模板此前跑不出结果）：
  - `_buildRewardDefs` 传的是 `id` 而非 `rewardId`，产出的 `RewardDef.rewardId` 恒为
    `undefined` —— 落库后无法区分奖励类型、无法对账。
  - `_buildRewardDefs` 把 `accumulateInChain` 硬编码为缺省 `true`（与 `RewardDef` 缺省相反），
    会把「多级固定比例」静默变成「极差」，只有第一层拿到钱。
  - `_buildRankDefs` 丢弃 `rankRate`，所有等级一律 `"0"`，叠加 `skipRankZero`（缺省 `true`）
    后全链零发放。
  - `executeCustomerIncentive` 未对 `rankDefs` 做「顶层优先、`config_json` 回退」的归一，
    规则集为标准形态（`rankDefs` 挂顶层）时 `RANK` 阶段拿到空等级表 → 零发放。
  - 另修正 `_mapMemberToNode`：业务对象无 `rankRate` 时保持字段 `undefined`。
    此前兜底写 `"0"` 会被 `RANK` 阶段判定为「宿主已预计算」而跳过评级，静默零发放。
- **`GenericSettlementService._calculate` 的日志噪音**：`ruleSetCode` 告警此前每笔结算都打
  （依赖构造默认规则集是文档明示的正常用法），百万单量级会刷爆日志并淹没真实告警。
  现在只在**事件内 `ruleSetCode` 与本次生效规则集不一致**时告警 ——
  那才是「意图覆盖却传错位置」的确定信号。

### 文档

- **`docs/` 不再进入 npm tarball**（`files` 白名单收敛为 `src/` + `README.md` + `CHANGELOG.md`）。
  内部审查报告、评估文档不应随包分发。
- README「架构原则」第 1 条不再宣称「零副作用」：`applyCaps` 就地推进封顶水位、
  `RANK` 阶段就地写回节点 `rankRate`/`rankId`，这两处是有意的就地写，
  重放同一批 `state`/节点对象会导致水位重复累计。
- README「扩展指南」补齐 `rankRate` 的两条来路（宿主预计算 / `RANK` 阶段现场评级）
  与完整可运行示例；此前示例跑出来是空数组。
- 清理 `src/` 内 13 处指向不存在文件 `src/adapters/songrong-reward-adapter.js` 的悬空引用，
  以及 6 处指向不存在的内部设计稿的引用；同时移除注释里的具体客户名，
  使公开发布的源码保持领域无关。

