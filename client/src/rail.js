// R4/R7: Die Rail schaltet den Inhalt der Sidebar-Spalte inline um — es gibt
// keine schwebenden Panels mehr. Die Panel-Module (search/review/comments)
// blenden sich weiterhin selbst über .hidden ein/aus; die Rail beobachtet das
// und sorgt dafür, dass immer höchstens ein Panel sichtbar ist und die
// Spalte einklappt, sobald keines mehr offen ist.

export function setupRail() {
  const sidebar = document.getElementById('sidebar');
  const tabs = Array.from(document.querySelectorAll('#rail .rail-tab[data-pane]'));
  const panes = new Map(tabs.map((t) => [t.dataset.pane, document.getElementById(t.dataset.pane)]));
  let syncing = false;

  function isVisible(el) {
    return !el.classList.contains('hidden');
  }

  function updateTabs() {
    const collapsed = sidebar.classList.contains('is-collapsed');
    for (const tab of tabs) {
      const pane = panes.get(tab.dataset.pane);
      tab.classList.toggle('is-active', !collapsed && isVisible(pane));
    }
  }

  function enforceSingle(opened) {
    syncing = true;
    if (opened) {
      for (const pane of panes.values()) if (pane !== opened) pane.classList.add('hidden');
      sidebar.classList.remove('is-collapsed');
    } else if (![...panes.values()].some(isVisible)) {
      sidebar.classList.add('is-collapsed');
    }
    updateTabs();
    syncing = false;
  }

  const observer = new MutationObserver((records) => {
    if (syncing) return;
    let opened = null;
    for (const r of records) if (isVisible(r.target)) opened = r.target;
    enforceSingle(opened);
  });
  for (const pane of panes.values()) {
    observer.observe(pane, { attributes: true, attributeFilter: ['class'] });
  }

  function activate(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;
    pane.classList.remove('hidden');
    enforceSingle(pane);
  }

  function collapse() {
    for (const pane of panes.values()) pane.classList.add('hidden');
    sidebar.classList.add('is-collapsed');
    updateTabs();
  }

  function toggle(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;
    if (isVisible(pane) && !sidebar.classList.contains('is-collapsed')) collapse();
    else activate(paneId);
  }

  // Der Dateibaum-Tab hat kein eigenes Panel-Modul, deshalb hier direkt.
  const filesTab = document.getElementById('btn-rail-files');
  if (filesTab) filesTab.addEventListener('click', () => toggle('pane-files'));

  const closeBtn = document.getElementById('btn-tree-close');
  if (closeBtn) closeBtn.addEventListener('click', collapse);

  // Ein-/Ausklappen von Baum und Gliederung über die jeweiligen Chevrons
  const filesPane = document.getElementById('pane-files');
  const treeToggle = document.querySelector('.file-tree-expand-collapse');
  if (treeToggle) {
    treeToggle.addEventListener('click', () => {
      filesPane.classList.toggle('tree-collapsed');
      rotate(treeToggle, filesPane.classList.contains('tree-collapsed'));
    });
  }
  const outlineToggle = document.querySelector('.outline-toggle');
  if (outlineToggle) {
    outlineToggle.addEventListener('click', () => {
      filesPane.classList.toggle('outline-collapsed');
      rotate(outlineToggle, filesPane.classList.contains('outline-collapsed'));
    });
  }

  function rotate(btn, collapsed) {
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href', collapsed ? '#i-chevron-right' : '#i-chevron-down');
  }

  updateTabs();
  return { activate, collapse, toggle, isCollapsed: () => sidebar.classList.contains('is-collapsed') };
}
