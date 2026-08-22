# 变更日志

本文件记录 `@usethink/incentive-engine` 的对外可见变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 3.4.x 及更早版本未维护本文件，其变更请查阅 git 提交历史。

---

## [4.1.0] — 2026-08-22

本版本**不改任何计算结果**，全部变更服务于一个目标：让引擎能被**打包型消费方**
（Cloudflare Workers、esbuild 单文件 ESM）安全使用。计算内核、金额语义、API 形状零改动。

### 背景（真实事故）

包根会 `require("./utils")`，而 `src/utils/version-select.js` 在**模块顶层**
`require("crypto")`。长驻 Node 环境（如 rbb）完全正常，但消费方用 esbuild 打成
单文件 ESM 后，打包器无法静态分析该 require，会替换成动态 require 辅助函数，
进程一加载模块就抛 `Dynamic require of "crypto" is not supported` —— 曾导致
某消费方服务启动即崩。`--platform=browser`（Cloudflare Workers）下更早，
直接在打包期报 `Could not resolve "crypto"`。

### 新增

- **`@usethink/incentive-engine/pure` 子入口** —— 零 Node 内建依赖的纯计算入口。
  导出 7 个子模块：`Distribute` / `Evaluate` / `Allocate` / `Orchestrate` /
  `Model` / `Reverse` / `Decimal`（唯一外部依赖是 `decimal.js`，可被打包器打进产物）。
  **与包根同名、同嵌套**：消费方从包根切到 `/pure` 只需改 import 路径，
  `engine.Distribute.distributeByDefs(...)` 一行都不用动。
  不含 `Utils`（用 crypto）/ `Services`（用 sequelize）/ `Validation`（用 joi）/ `Adapters`
  —— 需要这些请继续用包根。
- **`src/pure.d.ts`** —— `/pure` 的官方类型声明，只声明运行时真实存在的 7 个子模块。
  访问 `engine.Utils` 会在**类型检查期**就报错，而不是运行期拿到 `undefined`。
- **`src/index.d.ts` 新增默认导出声明**（纯增量，具名导出全部保留）。
  此前本文件只有具名导出，`import engine from "@usethink/incentive-engine"` 拿不到类型，
  消费方只能各自手写 `declare module` 兜底 —— 手写声明与真实导出漂移时 TS 不报错，
  错误会潜伏到运行期。现在可以直接用随包类型。
- **`scripts/smoke-pure.js`** —— `/pure` 的守卫脚本，已接入 `npm run smoke` 与
  `prepublishOnly`。断言：导入图 0 个 node 内建（静态遍历，能抓到函数体内的惰性 require）、
  裸包依赖均已在 `dependencies` 声明、与包根形状一致、真实计算结果正确；
  本机能解析到 esbuild 时额外用 `--format=esm --platform=browser` 真实打包复核。
- **`tests/pure-entry.test.js`** —— `/pure` 的形状/最小面契约测试，含灰度分桶回归基线。

### 变更

- **`src/utils/version-select.js`：`require("crypto")` 从模块顶层挪进函数体（惰性）。**
  修掉了上述「模块一加载就崩」的问题。分桶算法未改，A/B 分配结果与 4.0.0 逐键一致
  （已用 2000+ 个 routingKey 对比验证，并在 `tests/pure-entry.test.js` 钉死回归基线）。
  ⚠️ 惰性化**只解决运行期崩溃，不解决 `--platform=browser` 的打包期报错** ——
  打包器同样会静态解析函数体内的 require。Cloudflare Workers 场景必须用 `/pure`。
- **新增 `exports` 映射**，公开子路径为 `"."` / `"./pure"` / `"./package.json"`。
  `main` / `types` 保留，旧解析器（`moduleResolution: node`）行为不变。

### ⚠️ 需要留意（严格 semver 视角）

`exports` 映射会**封印所有未列出的子路径**。此前 `require("@usethink/incentive-engine/src/xxx.js")`
这类深导入是可行的，本版本起会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

这是**有意为之**：深导入曾造成严重事故 —— 消费方为绕开 crypto 而深导入
`src/engine/distribute/index.js`，该文件把 `Distribute` 这一层抹平了，于是
`engine.Distribute` 为 `undefined`，调用抛 `TypeError` 被消费方 try/catch 吞掉，
表现为「奖励全部静默不发放且零报错」。封印深导入 = 让这类错误在解析期就暴露。

已确认本组织内**无任何代码依赖深导入**（唯一的子路径用法是
`require("@usethink/incentive-engine/package.json")`，已显式保留）。
若你的项目存在深导入，请改用包根或 `/pure`。按严格 semver 这属于 breaking change，
如需保守发布可将本次改为 `5.0.0`。

---

## [4.0.0] — 2026-08-20

本版本是一次**资金安全导向的破坏性升级**。全部破坏性变更的方向都是
**fail-closed（宁可少发，不可超发）**：此前若干「配置写错却静默按最宽松口径放行」的路径，
现在改为显式抛错或按最严口径处理。

**升级前必读**：如果你的生产配置正踩在下述任一静默路径上，升级后会从「静默超发」变成
「显式报错」或「金额变小」。请先在预发环境用真实规则集与真实订单跑一遍回归，
核对发放总额，再上生产。

### 破坏性变更（资金行为）

- **`Allocate.applyCaps`：未知封顶 `scope` 从静默放行改为抛错。**
  此前 `scope` 写错（如 `PLATFORM_YEARLY`）会被当作「无此维度封顶」而完全不裁剪，
  直接超发；现在抛 `applyCaps：未知封顶 scope "..."`。合法值见「新增」的多周期封顶条目
  （`Allocate.CAP_SCOPES`，8 个）。
  ⚠️ 其中 `PER_USER_MONTHLY` 这类**非日周期在 3.4.x 是被静默忽略的**（等于没配封顶），
  本版本起真正生效 —— 若你此前写过，升级后发放金额会变小，请先核对总额。
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
- **`Orchestrate.executePipeline`：第 2 个及以后的 `DISTRIBUTE` 阶段必须显式声明 `config.merge`。**
  此前后一个 `DISTRIBUTE` 会**静默覆盖**前一个的全部产出（实测两阶段各产 1 条时
  `final` 只剩后者），配了两组奖励却只发一组，且无任何告警 —— 对账时极难定位。
  现在缺省抛错，必须选 `"append"`（累加，多组奖励并存）或 `"replace"`（显式丢弃前序）。
  单个 `DISTRIBUTE` 的流水线（绝大多数配置）行为完全不变。
- **`Orchestrate.executePipeline`：`RANK` 阶段排在已产出记录的阶段之后时抛错。**
  `RANK` 的输出是空数组，排在 `DISTRIBUTE` 之后会把前序收益记录静默清空 → 零发放。
  `RANK` 的用途本就是在 `DISTRIBUTE` 之前准备 `node.rankRate`，此类顺序是配置错误，
  现在当场报错而非静默零发放。
- **`Allocate.applyCaps`：`onExceed: "ALERT_ONLY"` 的边界判定从 `<` 改为 `<=`。**
  金额恰好用尽剩余额度不再被标记 `alertOnly`（那本就不是超发）。
- **`Utils.addBusinessDays`：修复夏令时切换日的结果偏移。**
  同一输入在 `America/New_York` / `Asia/Shanghai` / `UTC` 下结果现在完全一致。

- **`Allocate.applyCaps` / `Allocate.applyBudgetGuard`：拒绝负金额或 `direction: "REVERSAL"` 的记录（抛错）。**
  此前负金额记录（宿主自行反向记账构造的冲正行）能直接流经封顶/预算阶段，会**反向推进**
  当日封顶水位、释放已用预算，使后续发放突破日限额 —— 「下单发佣 → 退款 → 再下单」
  即可套出超额佣金。现在当场抛 `applyCaps：不接受冲正/负金额记录（nodeId=..., amount=...）`。
  冲正记录本就不应进入 CAP/OVER（封顶水位默认不随冲正回退，见「新增」的冲正原语条目）。

### 破坏性变更（接口契约）

- **`GenericSettlementService.batchSettle`：落账异常改为返回 `{ success: false, message }`，不再抛出。**
  与该方法其他失败出口及 `settle` 的错误契约统一。事务已回滚、本批零落账，
  调用方只检查 `success` 即可，不会再漏账。若你原来用 `try/catch` 兜批量失败，
  请改为判断返回值。
- **`Validation.createRuleSetValidation`：新增两条拒绝规则** —— `levelIndex > 0` 且无
  `conditions` 的 `rankDefs`、`ratio` 之和 ≠ 100 的 `allocators`。原本能通过校验的
  配置可能开始报错。
- **`Validation.createRuleSetValidation`：`rewardDefs.conditions` 由「完全不校验」改为严格校验条件树。**
  此前 schema 是 `Joi.array().items(Joi.object())` —— `field` 拼错、`operator` 写成 `">="`、
  `source` 拼成 `sources` 这类**资金相关**笔误全部能通过校验，直到运行期才表现为
  「门槛永远不满足 → 静默不发」或「门槛被忽略 → 超发」。现在按递归条件树校验
  （`COMPARE` 的 `field`/`operator`/`value` 必填、`operator` 限 6 个枚举值、
  `AND`/`OR`/`NOT` 的 `children` 非空且逐层递归校验），错误定位到
  `conditions[0].children[0].operator` 这样的具体字段。`rankDefs.conditions` 同步收紧
  （只允许 `source: "target"`，写 `"event"` 在配置期即拒绝 —— 等级评估没有事件上下文，
  运行期会抛错）。**已在生产跑通的正确配置不受影响**，但写错过的配置会开始报错。
- **`Validation` 自定义校验的错误信息位置变更**：修好「顶层 `error.message` 为空」这个缺陷
  （详见「修复」）的代价是 —— 自定义提示不再出现在 `error.details[0].context.message`，
  而是出现在 `error.message`（以及 `details[0].message`、`details[0].context.msg`）。
  若你曾为绕过该缺陷而直接读 `context.message`，请改读 `error.message`。
- **`Adapters.customerAdapterTemplate` 行为修正**（详见「修复」）：
  `_buildRewardDefs` 的 `accumulateInChain` 缺省由 `true` 改为 `false`，
  `_mapMemberToNode` 不再给无 `rankRate` 的节点兜底写 `"0"`。

### 新增

- **封顶周期扩展到 `WEEKLY` / `MONTHLY` / `TOTAL`（8 个 scope 全组合）+ `Allocate.CAP_SCOPES` 常量。**
  此前只有 `PLATFORM_DAILY` / `PER_USER_DAILY`，「活动预算月上限 5 万」「单用户活动期总共最多拿 800」
  这类长周期预算控制只能由宿主在引擎外自建水位 —— 而那等于把资金裁剪逻辑搬出引擎，各家口径必然分叉。
  现在 `scope` 是 `<维度>_<周期>` 的全组合：`PLATFORM` / `PER_USER` × `DAILY` / `WEEKLY` / `MONTHLY` / `TOTAL`。
  - ⚠️ **引擎不认识日期**：`PLATFORM_DAILY` 之所以是「日」封顶，靠的是宿主那行水位按业务日存、
    跨天自然归零。引擎侧四个周期的唯一差别是**水位分桶的键**，周期边界仍由宿主决定
    （按 `biz_week` / `biz_month` / `campaign_id` 分行即得周/月/活动总量口径）。
    「活动总量封顶」因此**不是**单独的 scope 名，而是 `PLATFORM_TOTAL` / `PER_USER_TOTAL`
    加一行活动期内不归零的水位 —— 保持引擎领域无关。
  - 水位 `state` 向后兼容：`DAILY` 仍复用顶层 `platformPaid` / `memberPaid`（**唯一存放处**，
    不重复写进 `periods`；重复状态只被宿主存了一半时，失败方向是超发），其余周期落在
    `state.periods[周期]`，且只在该周期真的配了封顶时才创建 —— `saveCapState` 不会收到
    宿主没准备好存的桶。
  - 最终金额 = `min(原金额, 各生效维度剩余额度)`；遍历顺序固定为 `CAP_SCOPES`，
    `snapshot.payoutCaps` 新增 `limits`（每个生效 scope 的额度）、`boundBy`（实际裁剪它的那个 scope）、
    `alertOnlyScopes`，legacy 字段（`dailyPlatformPayoutCap` / `memberDailyYieldCap` /
    `originalAmount` / `cappedAmount` / `alertOnly` / `onExceed`）**一位不改**，老宿主对账口径不破。
  - fail-closed：配了 `PER_USER_*` 封顶但水位里缺可用的 `memberPaid` Map 时**抛错**，
    绝不按 0 起算（按 0 起算等于把用户额度重新打开 = 超发）。
  - **`GenericSettlementService`：非 `_DAILY` 周期封顶必须成对配置 `loadCapState` / `saveCapState`**，
    否则 `_calculate` 直接返回 `{ success: false }` 并指名缺哪一个。原因：没有水位钩子时每次结算
    从 0 起算，「月封顶 5 万」实际退化成「单事件封顶 5 万」，跑 100 单就发 500 万 ——
    那是比不配封顶更危险的**虚假保障**。`DAILY` 维持历史行为（未配钩子照旧运行），既有接入方零影响。
    宿主需连同 `capState.periods` 一起持久化/还原（`memberPaid` 还原成 `Map`）。
  - `Validation` 的 `capDefSchema.scope` 直接 `valid(...CAP_SCOPES)`，校验层与计算层**同源**，
    枚举不会漂移；`src/index.d.ts` 新增 `CapDimension` / `CapPeriod` / `CapScope`（模板字面量类型）/
    `CapPeriodBucket` / `CapState.periods`。

- **`Reverse` 冲正原语（`Reverse.reverseRecords`）：已发放收益按比例反向追回，补上通用分佣最后一块致命缺口。**
  此前引擎没有「负事件」概念，退款/撤单只能由宿主各自反向记账 —— 而部分退款按订单比例还是
  按剩余额度、四舍五入方向、重复回调是否二次扣款这三类口径分叉，出错方向都是**超额扣款**
  （直接从用户账上多扣钱）。现在由引擎统一提供：
  - 输入宿主从自己库里还原的**原始收益记录** + 本次冲正比例，输出对应的负金额冲正记录
    （`amount` 为负数 → 宿主 `SUM(amount)` 即净发放额；`reversedAmount` 为正数绝对值；
    `direction: "REVERSAL"`、`originalRecordId`、`snapshot.reversal` 完整对账快照）。
    引擎不查库、不认识订单/退款/佣金 —— 「哪些记录属于这笔退款」「已冲正多少」全由宿主入参提供。
  - fail-closed 方向与发放侧相反但同源 —— **「宁可少追回，不可超额追回」**：
    金额一律 `ROUND_DOWN` 截断到 4 位（`33.3333 × 30%` = `"9.9999"`，不是四舍五入的 `10.0000`）；
    **冲正比例没有缺省值**（`ratio` 与 `reversalValue + originalEventValue` 二选一且必须恰好一种，
    都不传直接抛错，绝不默认 100% 全额追回）；累计冲正额**永不超过原始发放额**
    （`reversedMap` 提供已冲正累计，超出时 `onExceed: "CLAMP"` 缺省裁剪到剩余额度并标记
    `snapshot.reversal.clamped`，`"REJECT"` 抛错）；已全额冲正的记录不再产出第二条（重复退款
    回调的计算侧幂等）；传入负金额 / `direction: "REVERSAL"` 的记录**抛错**
    （对冲正记录再冲正会得到正金额「反向发钱」，最危险的一类静默错误）。
  - `Orchestrate.executePipeline` 新增 `REVERSE` 阶段（`context.reversalSummary` 输出冲正汇总）：
    与 `DISTRIBUTE` **在同一条流水线内互斥**（两个顺序都抛错，正负记录混批会污染封顶水位与
    对账口径）、一条流水线最多一个 `REVERSE`、必须是第一个产出记录的阶段。
  - `REVERSE` **故意不在 `ruleSetConfigSchema` 的 handler 白名单内**：冲正需要运行期的原始收益
    记录，静态规则集声明出来必然缺 `originalRecords` 而在计算期抛错；schema 给出指向三个运行期
    入口的可执行错误信息。
- **`GenericSettlementService` 新增可选 `reversal` 配置块与 `reverse(refundEvent, options)` 入口**：
  读回原始收益记录 → 冲正计算 → 负金额行落库，全程同一事务。与 `settle()` 的三处**有意差异**：
  ① 计算在**事务内**（冲正金额取决于库里当前值，请在 `loadOriginalRecords` 里加行锁，否则并发
  退款回调各读到过期的已冲正累计而合计超额追回）；② 幂等键**独立**（`reversal.idempotency`，
  通常按退款单号 —— 复用订单号会把同一订单的第二次部分退款误判为重复回调而漏追回）；
  ③ **不回退封顶水位**（`loadCapState`/`saveCapState` 不参与），且只调用 `reversal.postProcess`
  而非发放侧 `postProcess`（后者会把冲正行当作新发放二次计入）。
  配了 `reversal` 却缺子项在**构造期**抛错，不留到退款回调那一刻才发现。

- **时间维度原语：`campaignDefs` 活动期加成 + `effective` 规则集生效期（`Allocate.applyCampaign` / `CAMPAIGN` 阶段 / `Utils.parseInstant` / `Utils.isWithinWindow`）。**
  此前引擎**没有任何时间概念**：`campaignDefs` / `effective` 是未识别字段（`ruleSetConfigSchema` 直接拒绝），
  「双十一佣金翻倍」「开业首周 1.5 倍」「这套规则只在活动期内生效」只能由宿主在调用引擎前
  自己乘系数、自己判过期 —— 而那三件事的出错方向全是**超发**：加成乘在封顶**之后**（日限额形同虚设）、
  两个活动窗口重叠时相乘（数倍超发）、过期规则集静默按原比例继续发（双十一的翻倍一直发到十二月）。
  现在由引擎统一提供：
  - `Allocate.applyCampaign(records, campaignDefs, { occurredAt })` → `{ records, summary }`
    （与 `reverseRecords` 同形）：命中活动的记录是**新对象**（`amount` 已加成、
    `snapshot.campaign` 带完整对账快照），未命中的原样透传；流水线 `CAMPAIGN` 阶段把汇总写入
    `context.campaignSummary`（与 `REVERSE` 的 `reversalSummary` 同一口径）。
    另有 `Allocate.resolveActiveCampaigns(defs, occurredAt, { rewardId? })` 供配置后台展示
    「当前生效活动」，以及 `Allocate.CAMPAIGN_MULTIPLIER_MAX`（= 10）。
  - **引擎只认「绝对时刻」，绝不调用 `Date.now()`**：时刻由宿主显式提供，且只接受 `Date` 实例
    或**带显式偏移量**的 ISO-8601（`"2026-11-11T00:00:00+08:00"`）。显式拒绝三类静默算错时刻的输入 ——
    `"2026-11-11T00:00:00"`（无偏移量，V8 按**进程本地时区**解析）、`"2026-11-11"`（纯日期，
    V8 按 **UTC** 解析，与前者口径相反）、数字时间戳（秒与毫秒无法区分，传秒会落到 1970 年 →
    窗口永不命中）。不用「当前时刻」兜底是因为结算重试、补跑昨天的单、对账重算都在活动窗口之外执行。
  - 窗口一律**左闭右开 `[startAt, endAt)`**，两端都必填（开口窗口 = 永久翻倍 = 持续超发）。
  - `multiplier` 是**倍数不是百分比**，约束 `0 < multiplier <= 10`：把「100%（即不加成）」
    误写成 `multiplier: 100` 会被当场拒绝，而不是把发放额放大 100 倍。加成金额一律 `ROUND_DOWN`
    截断到 4 位（`33.3333 × 1.5` = `"49.9999"`，不是四舍五入的 `50.0000`）。
  - **`CAMPAIGN` 必须排在 `DISTRIBUTE` 之后、`CAP` / `OVER` 之前**，一条流水线最多一个 ——
    三处同时把守：`Orchestrate.executePipeline` 抛错、`ruleSetConfigSchema` 配置期拒绝
    （含「配了 `campaignDefs` 却没有 `CAMPAIGN` 阶段」这类静默失效）、`Adapters.buildPipelineStages`
    的缺省流水线在**存在 `campaignDefs` 时自动插入** `DISTRIBUTE → CAMPAIGN → CAP`。
    排在 `CAP` 之后会让「日限额 100」被 2 倍活动放大成 200。
  - 一条记录被**多个活动同时命中 → 抛错**（相乘是数倍超发，静默取一条等于悄悄改钱）；
    静态可判的窗口重叠（`rewardIds` 有交集且窗口相交）在**配置期**即被 `Validation` 拒绝。
    `rewardIds` 省略 = 加成全部奖励项，写**空数组**抛错（语义与省略相反）。
  - 负金额 / `direction: "REVERSAL"` 的记录进入加成**抛错**（放大追回金额 = 多扣用户的钱）。
  - **`GenericSettlementService` 新增可选钩子 `buildOccurredAt(event)`**（缺省读
    `businessEvent.occurredAt`）：仅当规则集带时间维度时必需，取不到时结算返回
    `{ success: false }` 并在消息里指名该钩子；事件时刻不在 `effective` 内时返回
    `{ success: false }` 且**不开事务、不落任何记录**；时刻或窗口非法（如漏写时区偏移）
    同样拒绝结算，而不是按「在/不在生效期」任一方向静默兜底。
  - `Validation` 新增 `campaignDefs` / `effective` 校验（`campaignId` 唯一性、窗口重叠、
    与 `pipelineDef` 的顺序交叉校验），`CONFIG_FIELD_KEYS` 补入
    `CAMPAIGN_DEFS` / `EFFECTIVE` / `CAMPAIGN_ID` / `MULTIPLIER` / `START_AT` / `END_AT`；
    `src/index.d.ts` 新增 `Instant` / `TimeWindow` / `CampaignDefLike` / `CampaignSummary`
    与 `RuleSetStageHandler` 的 `"CAMPAIGN"`。
  - **纯新增能力**：未配置 `campaignDefs` / `effective` 的既有规则集行为零变化
    （不需要 `occurredAt`，也不会新增任何时间校验）。
- **活动加成与生效期的测试与冒烟覆盖**：`tests/engine-core.test.js` 新增 `Campaign` 用例组
  （35 例：截断方向、快照与汇总、入参不可变、左闭右开边界、三类非法时刻、`multiplier` 边界、
  多活动命中抛错、`rewardIds` 限定、流水线四种非法顺序、适配层自动插入、校验层接受/拒绝矩阵、
  `Utils.isWithinWindow` 边界）；`tests/generic-settlement.test.js` 新增 8 例
  （在生效期内成功并把 `occurredAt` 传到适配层、过期与右开边界拒绝且不开事务不落库、
  缺时刻拒绝且指名 `buildOccurredAt`、自定义钩子读 `paid_at`、无偏移量窗口拒绝、
  无时间维度规则集不调钩子）；`scripts/smoke-business.js` 新增第 7 段端到端链路
  （**故意不写 `pipelineDef`**，验证适配层自动装配 `DISTRIBUTE → CAMPAIGN → CAP`：
  100 → 翻倍 200 → 封顶 150，落库行带 `campaignId=dbl11`；窗口外发 100 且无活动快照；
  过期规则集零落库；缺时刻指名钩子；无偏移量时刻被拒）。全量测试 397 → 440。
- **`conditions` 支持 `source: "event" | "target"`：发放门槛可读【受益节点】而非只能读事件。**
  此前 `rewardDefs.conditions` 的数据源被硬编码为事件对象，「只给 V2 以上的上级发佣」
  「上级团队业绩满 5 万才发」「上级本月已达上限则跳过」这三类**通用分佣最常见**的
  受益人侧门槛完全无法表达 —— 宿主只能在调用引擎前自己过滤祖先链，而那会同时改变
  LEVEL 的水位口径与层号。现在条件上写 `source: "target"` 即读受益节点
  （`attrs` 优先、回退顶层字段，与 `rank-evaluator` 同一口径），`source: "event"` 显式读事件，
  **不写 `source` 时数据源仍是事件**（既有配置逐位不变）。
  - 事件侧与受益人侧条件可混在同一棵 `AND`/`OR`/`NOT` 树里，逐条按各自 `source` 求值。
  - `DIRECT`/`FIXED`/`CUSTOM` 按目标节点求值一次；`LEVEL` 沿祖先链**逐层**求值 ——
    被门槛拦下的层不发放、**不推进水位**、也不改变其余层的层号，与 `diffRate<=0`
    跳过完全同一口径（`calculateLevelChain` 新增 `nodeFilter` 参数）。
  - fail-closed 约束：未知 `source`、或声明了 `source` 但该数据源缺失，一律**抛错**，
    绝不静默回退到另一个数据源（那会把「拦住」翻成「放行」= 超发）。
    `target: "SOURCE"` + 受益人侧条件时引擎只有 `event.sourceNodeId`、没有节点对象，
    抛错提示传入 `sourceNode`；`PARENT`/`ANCESTOR` 节点不存在（无上级 / 链长不足）
    属运行期网络结构，静默不发、不抛错。
  - `sourceNode`（事件来源节点对象）已贯穿各层可选参数：`Distribute.distributeByDefs`
    → `Orchestrate.executePipeline` 的 `DISTRIBUTE` 阶段 config →
    `Adapters.buildPipelineStages` → `GenericSettlementService` 新增可选钩子
    `buildSourceNode(event)`；`Validation.engineEventPreviewSchema` 的
    `sourceNode`/`directParent`/`ancestors` 同步补上 `attrs`，否则节点侧门槛无法预览试算。
    **不参与 `RANK` 阶段评级**（那会开始给事件来源节点写 `rankRate`，改变既有行为）。
  - `ComparisonOperator` 补入 `"NE"`（此前实现已支持、类型声明与校验枚举漏列）。
  - 顺带修复：复合条件的 `children` 未写 `type` 时此前被判为「不满足」而静默少发
    （调用方只在 `conditions` 数组顶层补 `type: "COMPARE"`），现在按 `field` 存在
    推断为 `COMPARE`，与校验层接受的形状一致；`{}` 这类无字段对象仍判 `false`。
  - **纯新增能力**：未使用 `source` 的既有规则集行为零变化。

- **`target: "ANCESTOR"` + `RewardDef.ancestorLevel`：定点单层发放（只给第 n 层这一个人发）。**
  此前 `target` 只有 `SOURCE` / `PARENT`，「只给祖先链第 3 层这一个节点发 3%」这类
  **定点单层**结构无法表达（写 `ANCESTOR` 直接抛「未知 target」）。宿主只能用
  `levelRates: ["0","0","3"]` 近似，但那语义上仍是链式遍历。现在
  `{ type: "DIRECT", target: "ANCESTOR", ancestorLevel: 3, rate: "3" }` 即从
  `ancestors[ancestorLevel - 1]` 取目标节点、只产出**一条**记录；`DIRECT` / `FIXED` / `CUSTOM`
  三种类型都支持，层号口径（`1` = 最近的祖先）与 `maxDepth` / `levelRates` 完全一致。
  fail-closed 约束：`ancestorLevel` 缺失或非法（`0` / 负数 / 小数 / 非数字）一律**抛错**，
  绝不兜底取第 1 层（配错层号等于把钱发给错误的人）；`ruleSetConfigSchema` 同步在配置期拦截，
  并拒绝把 `ancestorLevel` 挂在 `SOURCE` / `PARENT` 上、拒绝 `type: "LEVEL"` 配 `target: "ANCESTOR"`
  （LEVEL 本就遍历整链，配了不会生效）。祖先链长度不足该层时不产生记录且不抛错
  （运行期网络结构，非配置错误，方向上属于少发）。记录的 `snapshot` 带
  `target: "ANCESTOR"` 与 `ancestorLevel` / `depth`（层号，与 LEVEL 记录同名同义），便于统一对账。
  ⚠️ 与 `PARENT` 一样受 `skipRankZero`（**缺省 `true`**）约束 —— 定点发放的比例挂在规则上、
  与目标等级无关，通常应显式写 `skipRankZero: false`，否则未评级节点会被静默跳过。
  **纯新增能力**：未使用 `ANCESTOR` 的既有规则集行为零变化。

- **`RewardDef.levelRates`：LEVEL 按层固定比例（多级固定比例分销）。**
  此前 LEVEL 只有一种口径 —— 按节点 `rankRate` 做水位差（极差）。发放比例取决于
  节点自身等级，而非它离事件源的**距离**，因此「一级 10%、二级 5%、三级 3%」这类
  最常见的多级分销结构无法配置化表达，只能由宿主为每个等级凑 `rankRate`（等级与层数
  一旦不是一一对应就凑不出来）。现在 `levelRates: ["10", "5", "3"]` 即第 n 层拿
  `levelRates[n-1]`：不读 `rankRate`、不推进水位、各层独立；比例表长度即隐式深度上限，
  与 `maxDepth` 并存取更严的一方；比例为 `0` 的层不发放但仍占一层（层号不前移）。
  fail-closed 约束：与 `accumulateInChain: true` **互斥并抛错**（两套口径发放总额不同，
  静默择一等于悄悄改钱），空数组 / 含非法元素 / 全为 `0` 一律抛错而非静默零发放，
  `ruleSetConfigSchema` 拒绝把 `levelRates` 挂在非 `LEVEL` 类型上。
  记录带 `snapshot.mode === "LEVEL_RATES"` 便于对账辨识；两套口径都满足
  `amount = eventValue × diffRate`。**纯新增能力**：未配置 `levelRates` 的既有规则集行为零变化。
- **`Validation.CONFIG_FIELD_KEYS` 补入 `MAX_DEPTH` / `LEVEL_RATES` / `ANCESTOR_LEVEL`**，与新增字段对齐。

- **`RewardDef.maxDepth`：LEVEL 链式发放的层数上限（深度风控）。**
  此前 `maxDepth` 是**未识别字段、被静默忽略** —— 实测 8 层递增 `rankRate` 的祖先链在
  `maxDepth: 2` 与不传时产出完全一致（8 条、金额相同），配了深度上限却毫无作用，
  链路多深就发多深。现在：按祖先链位置截断（`1` = 最近的祖先，被 `diffRate<=0`
  跳过的层同样占一层），超出层完全不参与计算、也不推进链式水位；缺省不限层数
  （与 3.4.x 一致）；非法值（`0` / 负数 / 小数 / 非数字）抛错而非静默忽略；
  `ruleSetConfigSchema` 拒绝把 `maxDepth` 挂在非 `LEVEL` 类型上（那不会生效）。
  每条 LEVEL 记录的 `snapshot.depth` 新增层号，便于对账与深度回溯。
  ⚠️ 若你此前误传过 `maxDepth`（当时无效），升级后该层数上限会真正生效、发放金额变小 ——
  这是它本该有的行为，但请先核对总额。

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
- **多周期封顶的测试与冒烟覆盖**：`tests/engine-core.test.js` 新增 11 例 `applyCaps` 多周期用例
  （`periods` 分桶不重复计 DAILY、多周期并存取最严一维 + `boundBy`、`PER_USER_TOTAL` 跨调用累计、
  缺 `memberPaid` Map 抛错、legacy 快照字段不变）与 2 例校验用例（8 个 scope 全通过、
  `CAMPAIGN_TOTAL` / `PLATFORM_YEARLY` 在配置期被拒）；`tests/generic-settlement.test.js` 新增 4 例
  （缺钩子拒绝且不开事务、只配一个钩子仍拒绝并指名、成对配置后 `periods` 在事务内交给 `saveCapState`、
  仅日封顶未配钩子仍放行）；`scripts/smoke-business.js` 新增月封顶端到端链路
  （四单每单 100、月限 250 → 累计恰好 250，水位落在 `periods.MONTHLY`；缺钩子直接拒绝）。
  全量测试 380 → 397。
- **冲正的测试与冒烟覆盖**：`tests/engine-core.test.js` 新增 `Reverse` 用例组、
  `tests/generic-settlement.test.js` 新增 `reverse` 用例组；`scripts/smoke-business.js`
  新增冲正端到端链路（发放 100 → 30% 退款净 70 → 同一退款单重复回调幂等 → 二次「全额」退款
  按剩余裁剪至净 0 → 第三次退款 `skipped`），用内存 Model 真跑账。全量测试 337 → 380。
- **TypeScript 类型声明 `src/index.d.ts`**（`package.json` 新增 `types` 字段）：
  手写声明，覆盖 11 个命名空间（含 `Reverse`）的全部对外 API。类型上显式标注了两处易错点 ——
  `NodeLike.rankRate` 未评级时必须保持 `undefined`、`CapState` 是会被就地推进的可变对象。
- **`scripts/verify-pack.js` 增强**：必备文件清单补入 `CHANGELOG.md` 与 `src/index.d.ts`，
  并新增禁发路径断言（`docs/` / `demo/` / `tests/` / `scripts/` 混入 tarball 即阻止发布）。

### 修复

- **`Validation` 全部自定义校验的错误信息此前在 `error.message` 上是空的**（24 处）。
  根因是 `helpers.error("any.custom", { message })`：Joi 的模板变量是 `{{#error.message}}`，
  自定义的 `message` 只落在 `error.details[0].context.message`，顶层 `error.message` 退化成
  `` `"rewardDefs" failed custom validation because ` `` —— 宿主打日志、配置后台弹提示拿到的
  正是顶层 message，于是「哪一项资金配置写错了」这句可执行提示**全部丢失**。
  改为统一失败出口 `helpers.message({ custom: "{{#msg}}" }, { msg })`，
  并顺带修掉另一类：消息里出现 `{`（如示例片段 `{ handler: "CAMPAIGN" }`、
  `JSON.stringify` 出来的对象）会被 Joi 当模板解析成
  `Invalid template variable ... Formula missing expected operator`，把可执行提示替换成
  一句看不懂的模板语法错误。现在任意字符原样出现在 `error.message` 里。
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
- **`src/index.d.ts` 两处与实现不符的类型声明**（严格模式下的正确配置反而报错 / 错误配置被放过）：
  - `Allocate.resolveActiveCampaigns` 此前声明返回归一化副本
    （`multiplier` 收窄为 `DecimalString`），实现返回的是**入参里的原始定义对象**
    （同一引用，`multiplier` 保持宿主传入的原类型）。TS 用户据此把返回值当字符串用会在运行期出错。
  - `RankDefLike.id` 此前是**必填 `string`**，而 `ruleSetConfigSchema` 的 `rankDefs`
    根本不接受 `id`（未知键直接拒绝），`Model.RankDef` 又接受 `number | string`：
    规则集里合法的 `{ rankId, levelIndex, rankRate }` 在 `--strict` 下无法通过类型检查。
    改为 `id?: string | number`（纯放宽，既有 TS 用户不受影响）。

### 文档

- README 新增「Campaign — 活动期加成（限时翻倍）与规则集生效期」小节
  （只认绝对时刻的三条理由与被拒输入对照表、左闭右开窗口、`multiplier` 是倍数不是百分比、
  `CAMPAIGN` 必须在 `CAP` 之前的 `100 × 2 = 200` 论证、多活动命中抛错与配置期重叠拦截、
  `rewardIds` 限定范围、`snapshot.campaign` / `context.campaignSummary` 对账字段、
  `effective` 过期不发放与 `buildOccurredAt` 钩子）；`Allocate` / `Utils` 函数表补入
  `applyCampaign` / `resolveActiveCampaigns` / `CAMPAIGN_MULTIPLIER_MAX` / `parseInstant` /
  `isWithinWindow`；Orchestrate 的 handler 列表与阶段顺序硬约束由三条补为四条；
  Services 配置示例补上 `buildOccurredAt`。
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
- README 新增「Reverse — 冲正（退款/撤单追回）」小节（两种比例口径、`ROUND_DOWN` 截断、
  `reversedMap` 必配场景、CLAMP/REJECT、不得流经 CAP/OVER、`REVERSE` 不可写进规则集）
  与「`reversal` 冲正块与 `reverse()`」小节（完整配置示例 + 与 `settle` 的三处有意差异）。
- README 新增「跨事件封顶水位」小节（`loadCapState`/`saveCapState` 完整示例 + 成对配置警告 +
  水位表设计建议）与 `useBulkCreate` 小节；安装章节补充 TypeScript 类型声明说明与 4.0.0 升级提示。
- 修正若干与实现不符的 JSDoc：`applyCaps` 的 `onExceed`（不再声称「一期仅支持 REJECT」，
  补上 `ALERT_ONLY` 语义、未知 scope 抛错、同 scope 取最严）、`executePipeline` 的
  `handler` 列表（补上实际已实现的 `RANK` / `OVER`）、`RewardDef.rewardId` 的字段说明。
- README「接入一个新客户」不再链接 `docs/` 与 `demo/`（两者已不在 tarball 内，
  在 npmjs 页面上会渲染成死链）；改为说明它们位于源码仓库，README 自身即包含完整可运行示例。

