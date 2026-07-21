import { effect } from '@dominator/core';
import * as stateModule from '../state';

export const renderRalph = () => {
  const state = stateModule;
  const { fps, getNodes, mode } = state;

  const v1 = document.createElement("div");
  v1.setAttribute("class", "ralph-container");
  const v2 = document.createElement("div");
  v2.setAttribute("class", "status-overlay");
  const v3 = document.createElement("div");
  v3.setAttribute("class", "mode-indicator");
  const v4 = document.createTextNode('');
  effect(() => { v4.textContent = String(mode().toUpperCase()); });
  v3.appendChild(v4);
  v2.appendChild(v3);
  v1.appendChild(v2);
  const v5 = document.createElement("div");
  v5.setAttribute("class", "viewport");
  const v6 = document.createDocumentFragment();
  effect(() => {
      v6.textContent = '';
      const v6_a = getNodes() || [];
      for (let v6_i = 0; v6_i < v6_a.length; v6_i++) {
          const n = v6_a[v6_i];
          const v7 = document.createElement("div");
          v7.setAttribute("class", "node");
          effect(() => { v7.style.transform = n.transform(); });
          effect(() => { v7.style.backgroundColor = n.color(); });
          v6.appendChild(v7);
      }
  });
  v5.appendChild(v6);
  v1.appendChild(v5);
  const v8 = document.createElement("div");
  v8.setAttribute("class", "dashboard");
  const v9 = document.createElement("div");
  v9.setAttribute("class", "metric");
  const v10 = document.createElement("span");
  v10.setAttribute("class", "value");
  const v11 = document.createTextNode('');
  effect(() => { v11.textContent = String(fps()); });
  v10.appendChild(v11);
  v9.appendChild(v10);
  const v12 = document.createElement("label");
  const v13 = document.createTextNode("FPS");
  v12.appendChild(v13);
  v9.appendChild(v12);
  v8.appendChild(v9);
  v1.appendChild(v8);
  return v1;
};