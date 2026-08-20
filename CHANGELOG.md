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
