// Boot only. No task, timer, log, or calendar behaviour yet — this file exists
// to prove modules load, state round-trips through storage, and the layout
// renders before any feature is built on top of it.

import { load, save } from './storage.js';

const state = load();
const persisted = save(state);

document.querySelector('[data-region="status"]').textContent = persisted
  ? `Foundation ready — ${state.items.length} items, ${state.log.length} logged.`
  : 'Foundation ready — storage unavailable, running in memory.';
