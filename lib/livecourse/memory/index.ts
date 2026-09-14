/**
 * LiveCourse A6 — 多层记忆闭环（docs/spec/04-detailed-design.md §6，
 * docs/spec/05-development-plan.md A6）。
 *
 * 三种作用域、三套 schema、三个 repository，经确定性 policy 写 L，
 * 经固定优先级 context 组装教师上下文。模型可以提出 learner-only
 * candidate，但不能选择 namespace、伪造 UI 成功事件或直接写 W/C/L。
 */
export * from './schemas';
export * from './namespaces';
export * from './repository';
export * from './policy';
export * from './context';
export * from './generation';
export * from './lifecycle';
