
# Dominator

 minimal VDOM-AOT compiler for the web. Designed for maximum performance, hot-path optimization, and SSA-powered updates. Fully incremental, minimal footprint, and production-ready. Supports dynamic DOM updates, arena memory pooling, batch DOM operations, and hybrid WASM/JS codegen. Examples included for stress testing and interactive nested components.

## Features

* Minimal VDOM core: VNode definitions, mount engine, event handling
* Runtime: batch updates, memory pooling, hot-path detection
* Compiler: JSX/TinyLang → AST → SSA → optimized JS/WASM
* Full examples: stressTest and interactive demos
* Incremental, ultra-fast, zero-overhead updates
* Production-ready folder structure and build pipeline

## Folder Structure

```
src/
│  ├─ core/
│  │  ├─ vnode.ts
│  │  ├─ mount.ts
│  │  └─ events.ts
│  │
│  ├─ compiler/
│  │  ├─ parser.ts
│  │  ├─ ssa.ts
│  │  └─ codegen.ts
│  │
│  ├─ runtime/
│  │  ├─ hotpath.ts
│  │  ├─ batch.ts
│  │  └─ memoryPool.ts
│  │
│  ├─ examples/
│  │  ├─ stressTest.ts
│  │  └─ interactive.ts
│  │
│  └─ index.ts
dist/
scripts/
│  └─ build.ts
package.json
tsconfig.json
README.md
LICENSE
```

## Installation

```bash
git clone https://github.com/pavanscales/dominator.git
cd dominator
yarn install
yarn build
```

## Usage

```ts
import Dominator from './dist/index.js';

Dominator.initDominator(document.getElementById('app'));

const v = Dominator.h('div', { id: 'hello' }, 'Hello Dominator!');
Dominator.mount(v, document.getElementById('app'));
```

## Development

```bash
yarn dev
yarn example:stress
yarn example:interactive
```

## License

MIT

