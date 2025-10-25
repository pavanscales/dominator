// --------------------------
// src/index.ts
// --------------------------

// ----------- VNode & Core -----------
export {
  VNode,
  VNodeType,
  VNodeProps,
  h,
  createTextVNode,
  fragment,
  isVNode,
  cloneVNode,
  markStatic,
  isSameVNodeType,
} from './core/vnode';

import { h } from './core/vnode';
import { mount, patch, unmount } from './core/mount';
import { setupEventDelegation } from './core/events';
import { startAutoTrim } from './runtime/memoryPool';

// ----------- Core Mount & Events -----------
export {
  mount,
  patch,
  unmount,
} from './core/mount';

export {
  setupEventDelegation,
  addEventListener,
  removeEventListener,
  removeAllEventListeners,
  patchEventListeners,
  normalizeEventName,
} from './core/events';

// ----------- Runtime & Batch Updates -----------
export {
  scheduleUpdate,
  flushUpdates,
  cancelUpdate,
  hasPendingUpdates,
  getPendingUpdateCount,
  clearAllUpdates,
  batchUpdates,
  deferredUpdate,
  immediateUpdate,
} from './runtime/batch';

export {
  trackUpdate,
  isHotPath,
  getUpdatePriority,
  getNodeStats,
  clearHotPathStats,
  getAllHotPathStats,
  getHotNodes,
  setHotThreshold,
  optimizeVNode,
} from './runtime/hotpath';

export {
  acquireVNode,
  releaseVNode,
  acquireArray,
  releaseArray,
  acquireObject,
  releaseObject,
  getPoolStats,
  trimPools,
  startAutoTrim,
  stopAutoTrim,
} from './runtime/memoryPool';

// ----------- Compiler -----------
export {
  ASTNode,
  ASTNodeType,
  SourceLocation,
  Parser,
  parse,
  isStaticNode,
} from './compiler/parser';

export {
  SSAInstruction,
  SSAOpType,
  SSABasicBlock,
  SSAIR,
  buildSSA,
  printSSA,
  analyzeSSA,
} from './compiler/ssa';

export {
  CodeGenOptions,
  generateCode,
  generateOptimizedCode,
  generateDebugCode,
  compile,
  compileWithOptions,
} from './compiler/codegen';

// ----------- Examples -----------
export {
  StressTest,
  runStressTest,
  runBenchmark,
  comparativeTest,
} from './examples/stressTest';

export {
  InteractiveApp,
  runInteractiveDemo,
} from './examples/interactive';

// ----------- Initialization -----------
export function initDominator(root?: HTMLElement): void {
  setupEventDelegation(root);
  startAutoTrim(30000); 
  console.log('Dominator initialized');
}

// ----------- Version Info -----------
export const version = '1.0.0';

// ----------- Default Export (all in one) -----------
const Dominator = {
  version,
  initDominator,
  h,
  mount,
  patch,
  unmount,
  compile,
  runStressTest,
  runInteractiveDemo,
};

export default Dominator;
