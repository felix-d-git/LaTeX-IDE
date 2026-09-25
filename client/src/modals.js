// Gemeinsames Modal-Verhalten wie in Overleaf, ohne jeden Dialog einzeln
// anzufassen: jedes Element mit .modal-backdrop-Kind gilt als Modal. Beim
// Einblenden wandert der Fokus in den Dialog, Tab bleibt darin (Fokusfalle),
// Escape klickt den Schließen-Knopf des obersten Modals (damit läuft dessen
// eigene hide()-Logik), beim Ausblenden kehrt der Fokus zum Auslöser zurück.

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isOpen = (m) => !m.classList.contains('hidden');
// HTMLElement-Check: Icon-<use href> passt auf [href], hat als SVG aber offsetParent undefined.
const focusables = (m) =>
  [...m.querySelectorAll(FOCUSABLE)].filter((el) => el instanceof HTMLElement && el.offsetParent !== null);

export function setupModals() {
  const modals = [...document.querySelectorAll('.modal-backdrop')].map((b) => b.parentElement);
  const triggers = new Map();
  const openStack = [];

  const observer = new MutationObserver(() => {
    for (const m of modals) {
      const idx = openStack.indexOf(m);
      if (isOpen(m) && idx === -1) {
        openStack.push(m);
        triggers.set(m, document.activeElement);
        // Dialoge, die selbst ein Feld fokussieren, tun das per setTimeout(0) - danach prüfen.
        setTimeout(() => {
          if (!m.contains(document.activeElement)) {
            const first = focusables(m).find((el) => !el.classList.contains('dialog-close')) || focusables(m)[0];
            first && first.focus();
          }
        }, 0);
      } else if (!isOpen(m) && idx !== -1) {
        openStack.splice(idx, 1);
        const t = triggers.get(m);
        triggers.delete(m);
        if (t && t.isConnected && t !== document.body) t.focus();
      }
    }
  });
  for (const m of modals) observer.observe(m, { attributes: true, attributeFilter: ['class'] });

  document.addEventListener('keydown', (e) => {
    const top = openStack[openStack.length - 1];
    if (!top || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      const close = top.querySelector('.dialog-close');
      if (close) {
        e.preventDefault();
        close.click();
      }
    } else if (e.key === 'Tab') {
      const list = focusables(top);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const inside = top.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}
