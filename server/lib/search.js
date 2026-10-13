const fs = require('fs');
const path = require('path');
const { buildTree, isTextFile, readUtf8OrNull } = require('./fsTree');

function flattenFiles(nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'dir') flattenFiles(n.children, out);
    else if (isTextFile(n.path)) out.push(n.path);
  }
  return out;
}

function toRegex(query, { regex, caseSensitive, wholeWord }) {
  let pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) pattern = `\\b${pattern}\\b`;
  return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
}

function searchProject(root, query, opts = {}) {
  if (!query) return [];
  const re = toRegex(query, opts);
  const files = flattenFiles(buildTree(root));
  const results = [];
  for (const relPath of files) {
    const abs = path.join(root, relPath);
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split('\n');
    lines.forEach((lineText, idx) => {
      re.lastIndex = 0;
      let match;
      const matches = [];
      while ((match = re.exec(lineText)) !== null) {
        matches.push({ col: match.index, length: match[0].length });
        if (match[0].length === 0) re.lastIndex++;
      }
      if (matches.length) {
        results.push({ file: relPath, line: idx + 1, lineText, matches });
      }
    });
  }
  return results;
}

function replaceInProject(root, query, replacement, opts = {}) {
  const re = toRegex(query, opts);
  const files = flattenFiles(buildTree(root));
  let totalReplacements = 0;
  const changedFiles = [];
  const skippedFiles = [];
  for (const relPath of files) {
    const abs = path.join(root, relPath);
    // Decoding Latin-1 as UTF-8 and writing it back would destroy every umlaut.
    const content = readUtf8OrNull(abs);
    if (content === null) {
      if (re.test(fs.readFileSync(abs, 'latin1'))) skippedFiles.push(relPath);
      re.lastIndex = 0;
      continue;
    }
    let count = 0;
    const newContent = content.replace(re, (...args) => {
      count++;
      return replacement;
    });
    if (count > 0) {
      fs.writeFileSync(abs, newContent, 'utf8');
      totalReplacements += count;
      changedFiles.push({ file: relPath, count });
    }
  }
  return { totalReplacements, changedFiles, skippedFiles };
}

// Labels aus .tex und Bib-Keys aus .bib für \ref{}/\cite{}-Vorschläge und
// Insert > Citation/Cross reference.
function collectRefs(root) {
  const labels = new Set();
  const bibKeys = new Map();
  for (const relPath of flattenFiles(buildTree(root))) {
    const ext = path.extname(relPath).toLowerCase();
    if (ext !== '.tex' && ext !== '.bib') continue;
    const content = fs.readFileSync(path.join(root, relPath), 'utf8');
    if (ext === '.tex') {
      for (const m of content.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]);
    } else {
      for (const m of content.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g)) {
        if (/^(comment|string|preamble)$/i.test(m[1])) continue;
        // Titel mit einer Ebene verschachtelter Klammern ("{JEDEC} Standard"), Klammern danach entfernen.
        const title = (m[3].match(/\btitle\s*=\s*[{"]((?:[^{}"]|\{[^{}]*\})*)/i) || [])[1] || '';
        const author = (m[3].match(/\bauthor\s*=\s*[{"]((?:[^{}"]|\{[^{}]*\})*)/i) || [])[1] || '';
        bibKeys.set(m[2], { title: title.replace(/[{}]/g, '').trim(), author: author.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim(), file: relPath });
      }
    }
  }
  return {
    labels: [...labels].sort(),
    bibKeys: [...bibKeys].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

module.exports = { searchProject, replaceInProject, collectRefs };
