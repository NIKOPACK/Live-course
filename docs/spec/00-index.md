# LiveCourse 规格索引

开发以本目录为准。[作品简介](../LiveCourse_作品简介.md) 是对外叙事；[产品设计完整版](../LiveCourse_产品设计_完整版.md) 是迁入对照，不再当工作规格。

产品只服务**自主学习**：学习者说明要学什么，Agent 老师把一堂课教完。没有人类教师，也没有改课。

## 读哪一份

| 要做的事 | 先读 |
|---|---|
| 规定用户怎么走、有几条路径 | [01-user-journeys.md](01-user-journeys.md) |
| 每一步的交互模式、反馈、恢复、迁移与记忆读写 | [01-user-journeys.md](01-user-journeys.md) 的「每步交互契约」；每步固定六列：步骤 / 状态、用户输入方式、系统可见反馈、跳过或失败恢复、完成后状态迁移、W / C / L 读写 |
| 某个画面允许或不允许什么 | [02-product-manual.md](02-product-manual.md) |
| 产品分几层、主通道是什么 | [03-product-design.md](03-product-design.md) |
| 记忆分几层、什么能跨课程 | [01-user-journeys.md](01-user-journeys.md) 的 J1/J4/J5 + [03-product-design.md](03-product-design.md) 的「记忆作用域」+ [04-detailed-design.md](04-detailed-design.md) §6 |
| 改哪个模块、沿用还是改角色 | [04-detailed-design.md](04-detailed-design.md) |
| 这一期减什么、加什么、怎样算完 | [05-development-plan.md](05-development-plan.md) |
| 怎么拆 subagent、改动必须引用哪一节 | [06-agent-protocol.md](06-agent-protocol.md) |

根目录 [AGENTS.md](../../AGENTS.md) 只放指针。打开一份规格后按它的完成标准做事，不要把本目录一次读完。

## 权威顺序

旅程决定手册，手册决定设计，设计决定开发计划。规格与代码冲突时先改规格，再用实现跟上。没有规格章节的功能不准做。
