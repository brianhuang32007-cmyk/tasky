// Item capture and the unfinished list.
//
// Items live in memory only for this milestone — persistence, selection,
// deletion, and the timer come later. emptyState() is imported so the item
// shape has one owner rather than being redefined here.

import { emptyState } from './storage.js';

const state = emptyState();

const form = document.querySelector('[data-form="capture"]');
const nameInput = form.elements.name;
const hint = document.querySelector('[data-region="capture-hint"]');
const itemsRegion = document.querySelector('[data-region="items"]');
const statusRegion = document.querySelector('[data-region="status"]');

// randomUUID needs a secure context. file:// qualifies in Chrome, but the
// standalone preview bundle should not break anywhere it does not.
const newId = () =>
  crypto.randomUUID?.() ??
  `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function addItem(name, kind) {
  state.items.push({ id: newId(), name, kind, createdAt: Date.now() });
}

function selectItem(id) {
  state.selectedId = id;
}

function deleteItem(id) {
  state.items = state.items.filter((item) => item.id !== id);

  // Only the deleted item's own selection is cleared; any other selection stands.
  if (state.selectedId === id) state.selectedId = null;
}

// --- rendering -----------------------------------------------------------
// Built with createElement rather than innerHTML: item names are user text and
// must never be parsed as markup.

const CROSS = 'M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5';

function deleteIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', CROSS);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('fill', 'none');

  svg.append(path);
  return svg;
}

function itemRow(item) {
  const li = document.createElement('li');
  li.className = item.id === state.selectedId ? 'item is-selected' : 'item';
  li.dataset.id = item.id;

  // The selectable area and the delete control are siblings, not nested, so a
  // click on delete can never fall through into selection.
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'item-select';
  select.setAttribute('aria-pressed', String(item.id === state.selectedId));

  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;
  name.title = item.name; // full text stays reachable when the row truncates

  const badge = document.createElement('span');
  badge.className = `badge badge-${item.kind}`;
  badge.textContent = item.kind === 'break' ? 'Break' : 'Task';

  select.append(name, badge);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'item-delete';
  remove.setAttribute('aria-label', `Delete ${item.name}`);
  remove.append(deleteIcon());

  li.append(select, remove);
  return li;
}

function emptyMessage() {
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = 'No unfinished tasks yet.';
  return p;
}

function render() {
  if (state.items.length === 0) {
    itemsRegion.replaceChildren(emptyMessage());
  } else {
    const list = document.createElement('ul');
    list.className = 'items';
    list.append(...state.items.map(itemRow));
    itemsRegion.replaceChildren(list);
  }

  const n = state.items.length;
  statusRegion.textContent = `${n} unfinished item${n === 1 ? '' : 's'}`;
}

// --- feedback ------------------------------------------------------------

function showHint(message) {
  hint.textContent = message;
  nameInput.classList.add('is-invalid');
}

function clearHint() {
  hint.textContent = '';
  nameInput.classList.remove('is-invalid');
}

// --- events --------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();
  if (name === '') {
    showHint('Give the item a name first.');
    nameInput.focus();
    return;
  }

  addItem(name, form.elements.kind.value);

  // reset() clears the field and restores Task as the checked default.
  form.reset();
  clearHint();
  render();
  nameInput.focus();
});

nameInput.addEventListener('input', clearHint);

// Delegated, so rows rebuilt by render() need no listeners of their own.
// Delete is tested first: it wins over selection when both could match.
itemsRegion.addEventListener('click', (event) => {
  const row = event.target.closest('.item');
  if (!row) return;

  if (event.target.closest('.item-delete')) {
    deleteItem(row.dataset.id);
    render();
    return;
  }

  if (event.target.closest('.item-select')) {
    selectItem(row.dataset.id);
    render();
  }
});

render();
