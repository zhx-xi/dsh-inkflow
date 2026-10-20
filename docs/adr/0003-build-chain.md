# ADR-0003：P0 用 esbuild 单工具链（偏离 tsdown）

- 状态：已采纳（P0）；P1 复评
- 日期：2026-10-21

## 背景

原始 P0 计划写的是「tsdown 构建链」（参考 dsh-better-sidebar 的 TS 双半构建）。实际动手前先确认了一个硬约束：

Client 半**必须**是下面这个字节形状，否则 DSH 的模块加载器不会认：

```js
window.__ModuleLoader__.load({
  id: '<package name>',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    /* bundle，其中 require('react') 等由 DSH 平台模块表解析 */
    return module.exports;
  },
});
```

这要求 CJS 产物外面套 banner/footer，且平台模块必须 `external`。同时 Host 半只是普通 ESM bundle。

## 决策

P0 用 **esbuild 一个工具链**同时产出两半：

- Host：`src/host/index.ts` → `lib/index.js`，`format: 'esm'`、`platform: 'node'`、`target: 'node22'`；
- Client：`src/client/index.tsx` → `lib/client.js`，`format: 'cjs'`、`platform: 'browser'`、`jsx: 'automatic'`、平台模块列在 `external`、banner/footer 包住 loader 调用。

理由：
1. Client 半无论如何都需要 banner/footer 这种"非标准输出"，esbuild 支持得最直接且已被 shipped 插件（dsh-memory-evolve）验证；
2. 两个工具链 = 两处配置漂移与两套失败模式，P0 的目标是减少风险而不是增加构建层次；
3. Host 半本期不需要 `.d.ts` 产出（没有库消费者）。

## 后果

- 偏离了用户建议的 tsdown；已在 P0 汇报中列为偏离点。
- 构建脚本 `scripts/build.mjs` 只有 80 行，替换成本低。
- **P1 复评触发条件**：①需要为外部消费者产出类型声明；②需要多入口代码分割；③esbuild 的 tree-shaking/体积成为问题。满足任一条就把 Host 半换 tsdown，Client 半保持 esbuild（loader 包装仍需要）。

## 验证

P0 实测：`pnpm run build` 产出 `lib/index.js`（17 KB ESM）与 `lib/client.js`（13 KB，首行为 loader 调用、末行 `return module.exports; } });`），`node --check` 通过，`import('../lib/index.js')` 导出 `{apply, inject, name}`。
