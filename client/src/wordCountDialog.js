import { api } from './api.js';

export function setupWordCountDialog() {
  const modal = document.getElementById('word-count-dialog');
  const body = document.getElementById('word-count-body');
  const btnClose = document.getElementById('btn-close-word-count');

  async function show() {
    modal.classList.remove('hidden');
    body.textContent = 'Loading…';
    try {
      const stats = await api.getWordCount();
      body.innerHTML = '';
      const rows = [
        ['Total Words', stats.words],
        ['Headers', stats.headers],
        ['Math Inline', stats.mathInline],
        ['Math Display', stats.mathDisplay],
      ];
      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'word-count-row';
        const l = document.createElement('span');
        l.textContent = label;
        const v = document.createElement('span');
        v.textContent = value;
        row.appendChild(l);
        row.appendChild(v);
        body.appendChild(row);
      }
    } catch (e) {
      body.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'word-count-error';
      p.textContent = 'File not found or not readable. Bitte zuerst „Kompilieren" drücken.';
      body.appendChild(p);
    }
  }

  function hide() {
    modal.classList.add('hidden');
  }

  btnClose.addEventListener('click', hide);
  return { show, hide };
}
