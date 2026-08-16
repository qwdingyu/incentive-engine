# incentive-engine-demo — 多行业集成 Demo

> 基于 `@usethink/incentive-engine` 的四个可运行示例，演示如何用引擎快速接入
> **电商 / 内容平台 / 游戏 / 跨境电商** 四种典型业务。
> 每个 demo 末尾带**期望值断言**，可作为集成冒烟测试（失败时进程退出码非 0）。

## 快速开始

```bash
npm install    # 安装引擎（file: 引用上级目录的本地包）

npm run demo:ecommerce   # 电商分销佣金：DIRECT + LEVEL + OVER + SPLIT
npm run demo:content     # 内容平台创作者激励：等级评估 + 条件评估 + 预算兜底 + REJECT
npm run demo:gaming      # 游戏平台推广激励：多级奖励 + 单用户日封顶
npm run demo:settle      # 跨境电商完整落账：GenericSettlementService + 幂等三层防护
npm run demo:all         # 一次运行全部 4 个示例（任一断言失败即中断）
npm run check            # 全部 demo 源码语法检查（node --check）
npm run verify           # check + demo:all（建议 CI 使用）
```

## 场景对照

| 文件 | 行业 | 演示的引擎能力 | 接入路径 |
|------|------|---------------|---------|
| `01-ecommerce.js` | 电商分销 | DIRECT(SOURCE/PARENT) + LEVEL 链式极差（含 attrs.rankRate 回退）+ OVER 预算 + CAP + SPLIT 拆分 | 纯计算（规则集适配器组装） |
| `02-content-platform.js` | 内容平台 | rankDefs 等级评估 + 复合条件 + 预算兜底 CAP + onExceed=REJECT | 纯计算 |
| `03-gaming.js` | 游戏推广 | 条件评估 + LEVEL 多级 + PER_USER_DAILY 封顶 | 纯计算 |
| `04-full-settle.js` | 跨境电商 | GenericSettlementService 全流程 + 幂等三层防护 + 边界行为 | 框架服务 |

## 目录结构

```
demo/
  scenarios/                 # 4 个可运行场景（每个含断言）
  mocks/                     # 内存 mock 基础设施（Model / sequelize / ruleSetService）
  utils/print.js             # 统一输出工具
  shared/ecommerce-rules.js  # 电商规则配置（01 与 04 共享）
```

## 改造成生产

1. **纯计算示例**（01-03）：把规则配置移入 DB / 配置文件，用
   `engine.Adapters.buildPipelineStages()` 组装流水线（01 已演示该路径）
2. **框架服务示例**（04）：把 `demo/mocks/*` 换成真实 Model / sequelize / ruleSetService，
   参考 `docs/006_多行业快速集成指南_2026-08-16.md` 的「生产化清单」；
   真实表必须为落账行建唯一索引（04 中 `uniqueKeys` 对应）

## 文档

完整集成指南见 `docs/006_多行业快速集成指南_2026-08-16.md`。

