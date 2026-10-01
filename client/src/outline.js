// R4: „File outline" unter dem Dateibaum — Gliederung der aktiven .tex-Datei
// aus den Sectioning-Befehlen, 28px-Zeilen, 24px Einzug je Ebene, genau eine
// Zeile trägt die Hervorhebung (die Sektion an der Cursorposition).

const LEVELS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
const SECTION_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;

function parseOutline(doc) {
  const items = [];
  const lines = doc.toString().split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i]);
    if (!m) continue;
    const title = extractBraces(lines[i], lines[i].indexOf('{', m[0].length - 1));
    items.push({ level: LEVELS.indexOf(m[1]), title: title || m[1], line: i + 1 });
  }
  return items;
}

// Titel bis zur passenden schließenden Klammer lesen (verschachtelte Makros
// wie \emph{...} im Titel würden ein simples /\{(.+?)\}/ zerlegen).
function extractBraces(text, openIdx) {
  if (openIdx < 0) return '';
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i).replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').trim();
    }
  }
  return text.slice(openIdx + 1).trim();
}

export function setupOutline({ editorMgr, getActivePath }) {
  const body = document.getElementById('outline-body');
  const crumbsEl = document.getElementById('editor-breadcrumbs');
  let items = [];

  // Breadcrumbs: Ordner › Datei › übergeordnete Abschnitte › aktueller Abschnitt.
  function renderCrumbs(path, activeIdx) {
    const parts = path ? path.split('/') : [];
    if (activeIdx >= 0) {
      const chain = [];
      let level = Infinity;
      for (let i = activeIdx; i >= 0; i--) {
        if (items[i].level < level) {
          chain.unshift(items[i].title);
          level = items[i].level;
        }
      }
      parts.push(...chain);
    }
    crumbsEl.replaceChildren(
      ...parts.flatMap((p, i) => [
        ...(i ? [Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '›' })] : []),
        Object.assign(document.createElement('span'), { textContent: p }),
      ])
    );
  }

  function currentLine() {
    const view = editorMgr.view;
    if (!view) return 1;
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  }

  function render() {
    const path = getActivePath && getActivePath();
    body.innerHTML = '';
    if (!path || !/\.(tex|ltx|sty|cls)$/i.test(path)) {
      items = [];
      body.innerHTML = '<div class="outline-empty">Keine .tex-Datei geöffnet.</div>';
      renderCrumbs(path, -1);
      return;
    }
    items = parseOutline(editorMgr.view.state.doc);
    if (items.length === 0) {
      body.innerHTML = '<div class="outline-empty">Keine Gliederungsebenen gefunden.</div>';
      renderCrumbs(path, -1);
      return;
    }
    const minLevel = Math.min(...items.map((i) => i.level));
    const cur = currentLine();
    // Genau eine Zeile ist hervorgehoben: die letzte Sektion vor dem Cursor.
    let activeIdx = 0; // vor der ersten Sektion gilt die erste als aktuell
    for (let i = 0; i < items.length; i++) if (items[i].line <= cur) activeIdx = i;
    renderCrumbs(path, items[0].line <= cur ? activeIdx : -1);

    items.forEach((item, idx) => {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'outline-item-link' + (idx === activeIdx ? ' is-current' : '');
      link.style.paddingLeft = `${4 + (item.level - minLevel) * 24}px`;
      link.textContent = item.title;
      link.title = item.title;
      link.addEventListener('click', () => {
        const view = editorMgr.view;
        const doc = view.state.doc;
        const ln = Math.min(item.line, doc.lines);
        const pos = doc.line(ln).from;
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
        render();
      });
      body.appendChild(link);
    });
  }

  return { render };
}
