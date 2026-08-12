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

// --- rendering -----------------------------------------------------------
// Built with createElement rather than innerHTML: item names are user text and
// must never be parsed as markup.

function itemRow(item) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.id = item.id;

  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;

  const badge = document.createElement('span');
  badge.className = `badge badge-${item.kind}`;
  badge.textContent = item.kind === 'break' ? 'Break' : 'Task';

  li.append(name, badge);
  return li;
}

function emptyMessage() {
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = 'Nothing yet — add your first item above.';
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

render();
