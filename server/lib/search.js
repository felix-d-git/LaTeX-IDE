const fs = require('fs');
const path = require('path');
const { buildTree, isTextFile } = require('./fsTree');

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
  for (const relPath of files) {
    const abs = path.join(root, relPath);
    const content = fs.readFileSync(abs, 'utf8');
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
  return { totalReplacements, changedFiles };
}

module.exports = { searchProject, replaceInProject };
