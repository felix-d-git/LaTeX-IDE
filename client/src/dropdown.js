// Gemeinsames Dropdown-System für Menüleiste, Projekt-/Layout-/Zoom-Menü und
// die Kontextmenüs im Dateibaum: fester Icon-Slot, Kürzel rechtsbündig,
// Submenü öffnet bei Hover.

const ICON = (name) =>
  `<svg class="ol-icon"><use href="#i-${name}"></use></svg>`;

let current = null; // { menu, anchor, onClose }

function buildItem(item, close) {
  if (item.type === 'divider') {
    const el = document.createElement('div');
    el.className = 'ol-dropdown-divider';
    return el;
  }
  if (item.type === 'header') {
    const el = document.createElement('div');
    el.className = 'ol-dropdown-header';
    el.textContent = item.label;
    return el;
  }

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ol-dropdown-item' + (item.checked ? ' is-selected' : '');

  const icon = document.createElement('span');
  icon.className = 'item-icon';
  // Einträge ohne Icon behalten den 28px-Einzug, damit alle Labels bei 36
  // stehen (R2, Block 3) — der Slot wird also immer gerendert.
  if (item.checked) icon.innerHTML = ICON('check');
  else if (item.icon) icon.innerHTML = ICON(item.icon);
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'item-label';
  label.textContent = item.label;
  row.appendChild(label);

  if (item.submenu) {
    const chev = document.createElement('span');
    chev.className = 'item-chevron';
    chev.innerHTML = ICON('chevron-right');
    row.appendChild(chev);
  } else if (item.shortcut) {
    const trailing = document.createElement('span');
    trailing.className = 'item-trailing';
    trailing.textContent = item.shortcut;
    row.appendChild(trailing);
  }

  if (item.submenu) {
    const wrap = document.createElement('div');
    wrap.className = 'ol-dropend';
    wrap.appendChild(row);
    wrap.appendChild(buildMenu(item.submenu, {}, close));
    const setOpen = (on) => {
      if (on) for (const sib of wrap.parentElement.querySelectorAll(':scope > .ol-dropend.open')) sib.classList.remove('open');
      wrap.classList.toggle('open', on);
    };
    wrap.addEventListener('mouseenter', () => setOpen(true));
    wrap.addEventListener('mouseleave', () => setOpen(false));
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(true);
      wrap.querySelector('.ol-dropdown .ol-dropdown-item')?.focus();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') row.click();
    });
    return wrap;
  }

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (item.disabled) return;
    close();
    if (item.onClick) item.onClick();
  });
  if (item.disabled) row.disabled = true;
  if (item.title) row.title = item.title;
  return row;
}

function buildMenu(items, opts, close) {
  const menu = document.createElement('div');
  menu.className = 'ol-dropdown' + (opts.className ? ' ' + opts.className : '');
  menu.setAttribute('role', 'menu');
  for (const item of items) menu.appendChild(buildItem(item, close));
  return menu;
}

function onDocMouseDown(e) {
  if (!current) return;
  if (current.menu.contains(e.target)) return;
  if (current.anchor && current.anchor.contains(e.target)) return;
  closeDropdown();
}

function onKey(e) {
  if (!current) return;
  // Stufenweise wie Overleaf: erst das innerste offene Submenü schließen.
  const openSubs = current.menu.querySelectorAll('.ol-dropend.open');
  const innermost = openSubs[openSubs.length - 1];
  if (innermost && (e.key === 'Escape' || e.key === 'ArrowLeft')) {
    e.stopPropagation();
    e.preventDefault();
    innermost.classList.remove('open');
    innermost.querySelector(':scope > .ol-dropdown-item').focus();
    return;
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeDropdown();
  }
}

export function closeDropdown() {
  if (!current) return;
  const { menu, anchor, onClose } = current;
  current = null;
  menu.remove();
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('keydown', onKey, true);
  if (onClose) onClose();
}

export function isDropdownOpenFor(anchor) {
  return !!current && current.anchor === anchor;
}

export function anyDropdownOpen() {
  return !!current;
}

function place(menu, { x, y, align, maxRight }) {
  menu.style.position = 'fixed';
  menu.style.top = `${y}px`;
  const width = menu.offsetWidth;
  let left = align === 'right' ? x - width : x;
  const limit = (maxRight ?? window.innerWidth) - 4;
  if (left + width > limit) left = limit - width;
  if (left < 4) left = 4;
  menu.style.left = `${left}px`;
  // Nach unten kippen, wenn das Menü sonst aus dem Fenster liefe
  const height = menu.offsetHeight;
  if (y + height > window.innerHeight - 4) {
    menu.style.top = `${Math.max(4, window.innerHeight - 4 - height)}px`;
  }
}

export function openDropdown(anchor, items, opts = {}) {
  closeDropdown();
  const menu = buildMenu(items, opts, closeDropdown);
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  place(menu, {
    x: opts.align === 'right' ? rect.right : rect.left,
    y: rect.bottom + (opts.offset ?? 2),
    align: opts.align,
  });
  current = { menu, anchor, onClose: opts.onClose };
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKey, true);
  return menu;
}

export function openDropdownAt(x, y, items, opts = {}) {
  closeDropdown();
  const menu = buildMenu(items, opts, closeDropdown);
  document.body.appendChild(menu);
  place(menu, { x, y, align: opts.align });
  current = { menu, anchor: null, onClose: opts.onClose };
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKey, true);
  return menu;
}

export function toggleDropdown(anchor, items, opts = {}) {
  if (isDropdownOpenFor(anchor)) {
    closeDropdown();
    return null;
  }
  return openDropdown(anchor, items, opts);
}
