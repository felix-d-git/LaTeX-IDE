const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'workspace.json');

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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(ws, null, 2), 'utf8');
}

const workspace = loadWorkspace();
if (!workspace.settingsByRoot) workspace.settingsByRoot = {};
if (!workspace.mainFileByRoot) workspace.mainFileByRoot = {};
if (!workspace.activeRootByUser) workspace.activeRootByUser = {};
if (!workspace.recentRootsByUser) workspace.recentRootsByUser = {};

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

const DEFAULT_PROJECT_SETTINGS = { compiler: 'pdflatex', stopOnFirstError: false, autocompile: false };

function getProjectSettings(root) {
  return { ...DEFAULT_PROJECT_SETTINGS, ...(workspace.settingsByRoot[root] || {}) };
}

function setProjectSettings(root, partial) {
  workspace.settingsByRoot[root] = { ...getProjectSettings(root), ...partial };
  saveWorkspace(workspace);
  return workspace.settingsByRoot[root];
}

// Tracks hashes of content this server itself just wrote, so the
// file watcher can tell "external edit" (e.g. Claude Code) apart from
// our own save round-trip and only flash-highlight real external changes.
const selfWrittenHashes = new Map();

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
  selfWrittenHashes,
};
