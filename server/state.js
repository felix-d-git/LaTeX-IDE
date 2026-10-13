const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'workspace.json');

function loadWorkspace() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      // fall through to default
    }
  }
  return { activeRootByUser: {}, recentRootsByUser: {}, mainFileByRoot: {}, settingsByRoot: {} };
}

function saveWorkspace(ws) {
  fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(ws, null, 2), 'utf8');
  fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
}

const workspace = loadWorkspace();
if (!workspace.settingsByRoot) workspace.settingsByRoot = {};
if (!workspace.mainFileByRoot) workspace.mainFileByRoot = {};
if (!workspace.activeRootByUser) workspace.activeRootByUser = {};
if (!workspace.recentRootsByUser) workspace.recentRootsByUser = {};
if (!workspace.sharesByRoot) workspace.sharesByRoot = {};
if (!workspace.rolesByRoot) workspace.rolesByRoot = {}; // root -> { userId: 'reviewer' }, absent = editor
if (!workspace.shareLinksByRoot) workspace.shareLinksByRoot = {}; // root -> { editor?: link, reviewer?: link }, siehe getShareLinks
if (!workspace.labelsByUser) workspace.labelsByUser = {};
if (!workspace.compileTimesByRoot) workspace.compileTimesByRoot = {}; // root -> [{ ms, at, estimateMs? }], letzte 10 Läufe

// One-time migration: pre-auth workspace.json had a single global
// activeRoot/recentRoots (single-user tool). Once the admin account exists,
// server/index.js calls this once so the admin keeps their previously
// active project instead of starting with an empty dashboard.
function migrateLegacyGlobalState(adminUserId) {
  if (workspace.activeRoot === undefined && workspace.recentRoots === undefined) return;
  if (!workspace.activeRootByUser[adminUserId] && workspace.activeRoot) {
    workspace.activeRootByUser[adminUserId] = workspace.activeRoot;
  }
  if (!workspace.recentRootsByUser[adminUserId] && Array.isArray(workspace.recentRoots)) {
    workspace.recentRootsByUser[adminUserId] = workspace.recentRoots;
  }
  delete workspace.activeRoot;
  delete workspace.recentRoots;
  saveWorkspace(workspace);
}

function setActiveRoot(userId, root) {
  workspace.activeRootByUser[userId] = root;
  const recent = workspace.recentRootsByUser[userId] || [];
  workspace.recentRootsByUser[userId] = [root, ...recent.filter((r) => r !== root)].slice(0, 10);
  saveWorkspace(workspace);
}

function getActiveRoot(userId) {
  return workspace.activeRootByUser[userId] || null;
}

function getRecentRoots(userId) {
  return workspace.recentRootsByUser[userId] || [];
}

function setMainFile(root, relPath) {
  workspace.mainFileByRoot[root] = relPath;
  saveWorkspace(workspace);
}

function getMainFile(root) {
  return workspace.mainFileByRoot[root] || null;
}

// Dauer jedes Compile-Laufs (Web + MCP): Basis der Schätzung und des Vergleichs Schätzung/Ist.
function addCompileTime(root, entry) {
  workspace.compileTimesByRoot[root] = [...(workspace.compileTimesByRoot[root] || []), entry].slice(-10);
  saveWorkspace(workspace);
}

function getCompileTimes(root) {
  return workspace.compileTimesByRoot[root] || [];
}

const DEFAULT_PROJECT_SETTINGS = { compiler: 'pdflatex', stopOnFirstError: false, autocompile: false };

function getProjectSettings(root) {
  return { ...DEFAULT_PROJECT_SETTINGS, ...(workspace.settingsByRoot[root] || {}) };
}

function setProjectSettings(root, partial) {
  workspace.settingsByRoot[root] = { ...getProjectSettings(root), ...partial };
  saveWorkspace(workspace);
  return workspace.settingsByRoot[root];
}

// --- Sharing: root -> [userId] of members besides the owner ---

function getShares(root) {
  return workspace.sharesByRoot[root] || [];
}

function setShares(root, userIds) {
  if (userIds.length) workspace.sharesByRoot[root] = userIds;
  else delete workspace.sharesByRoot[root];
  saveWorkspace(workspace);
}

function getRole(root, userId) {
  return (workspace.rolesByRoot[root] || {})[userId] || 'editor';
}

function setRole(root, userId, role) {
  const m = { ...(workspace.rolesByRoot[root] || {}) };
  if (role === 'reviewer') m[userId] = role;
  else delete m[userId];
  if (Object.keys(m).length) workspace.rolesByRoot[root] = m;
  else delete workspace.rolesByRoot[root];
  saveWorkspace(workspace);
}

// Link je Rolle: { token, maxUses (0 = unbegrenzt), uses }. Alte Einträge waren nur der Token-String.
function getShareLinks(root) {
  const m = {};
  for (const [role, l] of Object.entries(workspace.shareLinksByRoot[root] || {})) {
    m[role] = typeof l === 'string' ? { token: l, maxUses: 0, uses: 0 } : l;
  }
  return m;
}

function setShareLink(root, role, link) {
  const m = { ...getShareLinks(root) };
  if (link) m[role] = link;
  else delete m[role];
  if (Object.keys(m).length) workspace.shareLinksByRoot[root] = m;
  else delete workspace.shareLinksByRoot[root];
  saveWorkspace(workspace);
}

function findShareLink(token) {
  for (const [root, m] of Object.entries(workspace.shareLinksByRoot)) {
    for (const role of ['editor', 'reviewer']) {
      const l = getShareLinks(root)[role];
      if (l && l.token === token) return { root, role, ...l };
    }
  }
  return null;
}

// Nach einem Beitritt hochzählen; Limit erreicht → Link ungültig.
function useShareLink(root, role) {
  const l = getShareLinks(root)[role];
  if (!l) return;
  const uses = l.uses + 1;
  setShareLink(root, role, l.maxUses && uses >= l.maxUses ? null : { ...l, uses });
}

function sharedRootsFor(userId) {
  return Object.keys(workspace.sharesByRoot).filter((r) => workspace.sharesByRoot[r].includes(userId));
}

// Project renamed: carry its per-root settings/main file/shares over.
function moveRoot(oldRoot, newRoot) {
  for (const k of ['sharesByRoot', 'mainFileByRoot', 'settingsByRoot', 'rolesByRoot', 'shareLinksByRoot', 'compileTimesByRoot']) {
    if (workspace[k][oldRoot] === undefined) continue;
    workspace[k][newRoot] = workspace[k][oldRoot];
    delete workspace[k][oldRoot];
  }
  saveWorkspace(workspace);
}

// Account deleted: drop the user's own state, their memberships, and every
// per-root entry for projects below ownDir (the deleted projects folder).
function purgeUser(userId, ownDir) {
  delete workspace.activeRootByUser[userId];
  delete workspace.recentRootsByUser[userId];
  delete workspace.labelsByUser[userId];
  const own = (r) => r === ownDir || r.startsWith(ownDir + require('path').sep);
  for (const k of ['sharesByRoot', 'mainFileByRoot', 'settingsByRoot', 'rolesByRoot', 'shareLinksByRoot', 'compileTimesByRoot']) {
    for (const r of Object.keys(workspace[k])) if (own(r)) delete workspace[k][r];
  }
  for (const m of Object.values(workspace.rolesByRoot)) delete m[userId];
  for (const r of Object.keys(workspace.sharesByRoot)) {
    workspace.sharesByRoot[r] = workspace.sharesByRoot[r].filter((id) => id !== userId);
    if (!workspace.sharesByRoot[r].length) delete workspace.sharesByRoot[r];
  }
  saveWorkspace(workspace);
}

// --- Labels: pro Nutzer privat. assign: Projektschlüssel (eigene: Ordnername, geteilte: Root-Pfad) -> [labelId] ---

const LABEL_COLORS = ['#c0392b', '#e67e22', '#d4ac0d', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#7f8c8d'];

function labelData(userId) {
  return (workspace.labelsByUser[userId] ||= { labels: [], assign: {} });
}

function getLabels(userId) {
  return labelData(userId);
}

function addLabel(userId, name, color) {
  const l = { id: require('crypto').randomUUID(), name, color };
  labelData(userId).labels.push(l);
  saveWorkspace(workspace);
  return l;
}

function updateLabel(userId, id, patch) {
  const l = labelData(userId).labels.find((x) => x.id === id);
  if (!l) return null;
  Object.assign(l, patch);
  saveWorkspace(workspace);
  return l;
}

function deleteLabel(userId, id) {
  const d = labelData(userId);
  d.labels = d.labels.filter((l) => l.id !== id);
  for (const k of Object.keys(d.assign)) {
    d.assign[k] = d.assign[k].filter((x) => x !== id);
    if (!d.assign[k].length) delete d.assign[k];
  }
  saveWorkspace(workspace);
}

function assignLabel(userId, keys, id, on) {
  const d = labelData(userId);
  if (!d.labels.some((l) => l.id === id)) return false;
  for (const k of keys) {
    const cur = (d.assign[k] || []).filter((x) => x !== id);
    if (on) cur.push(id);
    if (cur.length) d.assign[k] = cur;
    else delete d.assign[k];
  }
  saveWorkspace(workspace);
  return true;
}

// Projekt umbenannt/endgültig gelöscht: Zuweisung mitnehmen bzw. verwerfen.
function moveLabelKey(userId, oldKey, newKey) {
  const d = labelData(userId);
  if (d.assign[oldKey] === undefined) return;
  if (newKey) d.assign[newKey] = d.assign[oldKey];
  delete d.assign[oldKey];
  saveWorkspace(workspace);
}

// Tracks hashes of content this server itself just wrote, so the
// file watcher can tell "external edit" (e.g. Claude Code) apart from
// our own save round-trip and only flash-highlight real external changes.
// Keyed by absolute path: every new project has a main.tex, a relative key collides across projects.
const selfWrites = new Map(); // path.resolve(abs) -> { hash, at }
const SELF_WRITE_TTL_MS = 10000; // entries without a watcher echo (binary, no watcher) expire

function markSelfWrite(abs, content) {
  selfWrites.set(path.resolve(abs), { hash: require('crypto').createHash('sha1').update(content).digest('hex'), at: Date.now() });
}

// true = this change is the echo of our own write (entry consumed).
function takeSelfWrite(abs, hash) {
  const k = path.resolve(abs);
  const e = selfWrites.get(k);
  if (!e) return false;
  if (Date.now() - e.at > SELF_WRITE_TTL_MS) { selfWrites.delete(k); return false; }
  if (e.hash !== hash) return false;
  selfWrites.delete(k);
  return true;
}

module.exports = {
  workspace,
  migrateLegacyGlobalState,
  setActiveRoot,
  getActiveRoot,
  getRecentRoots,
  setMainFile,
  getMainFile,
  getProjectSettings,
  setProjectSettings,
  addCompileTime,
  getCompileTimes,
  markSelfWrite,
  takeSelfWrite,
  getShares,
  setShares,
  sharedRootsFor,
  getRole,
  setRole,
  getShareLinks,
  setShareLink,
  findShareLink,
  useShareLink,
  moveRoot,
  purgeUser,
  LABEL_COLORS,
  getLabels,
  addLabel,
  updateLabel,
  deleteLabel,
  assignLabel,
  moveLabelKey,
};
