// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// Project this window shows: the server resolves every request against it (not the user's last opened one).
let projectId = null;
export function setProjectId(id) {
  projectId = id || null;
}
export function getProjectId() {
  return projectId;
}
// For plain URLs (downloads, <img>, iframes) that can't carry the header.
export function withPid(url) {
  return projectId ? `${url}${url.includes('?') ? '&' : '?'}pid=${encodeURIComponent(projectId)}` : url;
}
const pidHeader = () => (projectId ? { 'X-Project-Id': projectId } : {});
const goneCheck = (data) => data && data.projectGone && window.dispatchEvent(new CustomEvent('lide-project-gone'));

async function req(method, url, body) {
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...pidHeader() };
  if (MUTATING.has(method)) {
    const csrf = getCookie('csrfToken');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Desktop app: answers from cache/local copy (or none at all) mean the server is unreachable.
  window.dispatchEvent(new CustomEvent('lide-offline', { detail: res.headers.get('X-Offline') === '1' || !!data.offline }));
  goneCheck(data);
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

export const authApi = {
  me: () => req('GET', '/api/auth/me'),
  register: (token, username, email, password) => req('POST', '/api/auth/register', { token, username, email, password }),
  login: (login, password, rememberMe) => req('POST', '/api/auth/login', { login, password, rememberMe }),
  logout: () => req('POST', '/api/auth/logout'),
  forgotPassword: (login) => req('POST', '/api/auth/forgot-password', { login }),
  resetPassword: (token, password) => req('POST', '/api/auth/reset-password', { token, password }),
  verify: (token) => req('POST', '/api/auth/verify', { token }),
  resendVerification: (login) => req('POST', '/api/auth/resend-verification', { login }),
  changePassword: (currentPassword, newPassword) => req('POST', '/api/auth/change-password', { currentPassword, newPassword }),
  createDesktopToken: (label) => req('POST', '/api/auth/desktop-token', { label }),
  listDesktopTokens: () => req('GET', '/api/auth/desktop-tokens'),
  revokeDesktopToken: (id) => req('DELETE', `/api/auth/desktop-tokens/${encodeURIComponent(id)}`),
  createMcpToken: (name, perms, projects) => req('POST', '/api/auth/mcp-token', { name, perms, projects }),
  updateMcpToken: (id, { perms, projects }) => req('PATCH', `/api/auth/mcp-tokens/${encodeURIComponent(id)}`, { perms, projects }),
  listMcpTokens: () => req('GET', '/api/auth/mcp-tokens'),
  revokeMcpToken: (id) => req('DELETE', `/api/auth/mcp-tokens/${encodeURIComponent(id)}`),
  deleteAccount: (password) => req('POST', '/api/auth/delete-account', { password }),
  desktopRelease: () => req('GET', '/api/desktop/release'),
};

export const shareApi = {
  get: () => req('GET', '/api/share'),
  add: (login, role) => req('POST', '/api/share', { login, role }),
  remove: (userId) => req('DELETE', `/api/share/${encodeURIComponent(userId)}`),
  setRole: (userId, role) => req('POST', '/api/share/role', { userId, role }),
  createLink: (role, maxUses) => req('POST', '/api/share/link', { role, maxUses }),
  revokeLink: (role) => req('DELETE', `/api/share/link/${encodeURIComponent(role)}`),
  join: (token) => req('POST', '/api/share/join', { token }),
};

export const adminApi = {
  createInvite: () => req('POST', '/api/admin/invites'),
  listInvites: () => req('GET', '/api/admin/invites'),
  revokeInvite: (token) => req('DELETE', `/api/admin/invites/${encodeURIComponent(token)}`),
  updateStatus: () => req('GET', '/api/admin/update'),
  requestUpdate: () => req('POST', '/api/admin/update'),
  listUsers: () => req('GET', '/api/admin/users'),
  deleteUser: (id) => req('DELETE', `/api/admin/users/${encodeURIComponent(id)}`),
  verifyUser: (id) => req('POST', `/api/admin/users/${encodeURIComponent(id)}/verify`),
  getMail: () => req('GET', '/api/admin/mail'),
  saveMail: (body) => req('PUT', '/api/admin/mail', body),
  testMail: () => req('POST', '/api/admin/mail/test'),
};

export const api = {
  listProjects: () => req('GET', '/api/projects/list'),
  openProject: (root) => req('POST', '/api/projects/open', { root }),
  createProject: (name) => req('POST', '/api/projects/create', { name }),
  renameProject: (oldName, newName) => req('POST', '/api/projects/rename', { oldName, newName }),
  copyProject: (name, newName) => req('POST', '/api/projects/copy', { name, newName }),
  archiveProject: (name) => req('POST', '/api/projects/archive', { name }),
  unarchiveProject: (name) => req('POST', '/api/projects/unarchive', { name }),
  trashProject: (name, from) => req('POST', '/api/projects/trash', { name, from }),
  restoreProject: (name) => req('POST', '/api/projects/restore', { name }),
  deleteProjectPermanently: (name) => req('DELETE', `/api/projects/trash/${encodeURIComponent(name)}`),
  projectZipUrl: (name) => `/api/projects/${encodeURIComponent(name)}/download/zip`,
  projectPdfUrl: (name) => `/api/projects/${encodeURIComponent(name)}/download/pdf`,
  // items: eigene Projekte = Ordnername, geteilte = Root-Pfad
  projectsZipUrl: (items) => `/api/projects/download/zip?items=${encodeURIComponent(JSON.stringify(items))}`,
  // XMLHttpRequest statt fetch: nur so gibt es Upload-Fortschritt (onProgress(0..100)).
  uploadZip: (file, onProgress) => new Promise((resolve, reject) => {
    const csrf = getCookie('csrfToken');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/upload-zip?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new Error('Netzwerkfehler'));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* keine JSON-Antwort */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `${xhr.status} ${xhr.statusText}`));
    };
    xhr.send(file);
  }),
  addLabel: (name, color) => req('POST', '/api/labels', { name, color }),
  updateLabel: (id, patch) => req('PUT', `/api/labels/${encodeURIComponent(id)}`, patch),
  deleteLabel: (id) => req('DELETE', `/api/labels/${encodeURIComponent(id)}`),
  assignLabel: (keys, labelId, on) => req('POST', '/api/labels/assign', { keys, labelId, on }),
  getTree: () => req('GET', '/api/tree'),
  getFile: (relPath) => req('GET', `/api/file?path=${encodeURIComponent(relPath)}`),
  convertUtf8: (relPath) => req('POST', '/api/file/convert-utf8', { path: relPath }),
  setMainFile: (relPath) => req('POST', '/api/main-file', { path: relPath }),
  createFolder: (relPath) => req('POST', '/api/tree/folder', { path: relPath }),
  createFile: (relPath) => req('POST', '/api/tree/file', { path: relPath }),
  renamePath: (relPath, newName) => req('POST', '/api/tree/rename', { path: relPath, newName }),
  // Distinct from the generic req() helper: a 409 means "name conflict at the
  // destination" (not a real error) - the caller decides whether to ask the
  // user to overwrite, so it's returned as data instead of being thrown.
  movePath: async (relPath, targetDir, overwrite) => {
    const csrf = getCookie('csrfToken');
    const res = await fetch('/api/tree/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...pidHeader() },
      body: JSON.stringify({ path: relPath, targetDir, overwrite: !!overwrite }),
    });
    const data = await res.json().catch(() => ({}));
    goneCheck(data);
    if (res.status === 409 && data.conflict) return { conflict: true };
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  },
  deletePath: (relPath) => req('DELETE', `/api/tree?path=${encodeURIComponent(relPath)}`),
  uploadFile: (dir, name, contentBase64, overwrite = false) =>
    req('POST', '/api/tree/upload', { dir, name, content: contentBase64, overwrite }),
  collabEpoch: (relPath) => req('GET', `/api/collab/epoch?path=${encodeURIComponent(relPath)}`),
  compile: (overrides) => req('POST', '/api/compile', overrides ? { overrides } : undefined),
  clearCache: () => req('POST', '/api/compile/clear-cache'),
  getComments: () => req('GET', '/api/comments'),
  addComment: (relPath, from, to, anchorText, text) =>
    req('POST', '/api/comments', { path: relPath, from, to, anchorText, text }),
  deleteComment: (relPath, id) => req('DELETE', `/api/comments/${encodeURIComponent(id)}?path=${encodeURIComponent(relPath)}`),
  editComment: (relPath, id, text) => req('PATCH', `/api/comments/${encodeURIComponent(id)}`, { path: relPath, text }),
  addReply: (relPath, id, text) => req('POST', `/api/comments/${encodeURIComponent(id)}/replies`, { path: relPath, text }),
  editReply: (relPath, id, rid, text) =>
    req('PATCH', `/api/comments/${encodeURIComponent(id)}/replies/${encodeURIComponent(rid)}`, { path: relPath, text }),
  deleteReply: (relPath, id, rid) =>
    req('DELETE', `/api/comments/${encodeURIComponent(id)}/replies/${encodeURIComponent(rid)}?path=${encodeURIComponent(relPath)}`),
  restoreHistoryFile: (id, file) => req('POST', '/api/history/restore', { id, file }),
  forwardSync: (relPath, line) => req('GET', `/api/synctex/forward?file=${encodeURIComponent(relPath)}&line=${line}`),
  inverseSync: (page, x, y) => req('GET', `/api/synctex/inverse?page=${page}&x=${x}&y=${y}`),
  getWordCount: () => req('GET', '/api/wordcount'),
  getSettings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('POST', '/api/settings', patch),
  getHistory: () => req('GET', '/api/history'),
  addHistoryLabel: (id, name) => req('POST', '/api/history/label', { id, name }),
  getHistoryDiff: (id, to, file) =>
    req('GET', `/api/history/diff?id=${encodeURIComponent(id)}&to=${encodeURIComponent(to)}&file=${encodeURIComponent(file)}`),
  refs: () => req('GET', '/api/refs'),
  languageToolStatus: () => req('GET', '/api/languagetool'),
  languageTool: (data, language) => req('POST', '/api/languagetool', { data, language }),
  languageToolLocal: (url, data, language) => req('POST', '/api/languagetool-local', { url, data, language }),
  importProjects: () => req('GET', '/api/import/projects'),
  importFiles: (project) => req('GET', `/api/import/files?project=${encodeURIComponent(project)}`),
  importProjectFile: (project, filePath, dir, name) => req('POST', '/api/import/project-file', { project, path: filePath, dir, name }),
  importUrl: (url, dir, name) => req('POST', '/api/import/url', { url, dir, name }),
  importDoi: (doi, dir, name) => req('POST', '/api/import/doi', { doi, dir, name }),
  importZotero: (dir, name, format) => req('POST', '/api/import/zotero', { dir, name, format }),
  getZotero: () => req('GET', '/api/zotero'),
  saveZotero: (cfg) => req('POST', '/api/zotero', cfg),
  getDictionary: () => req('GET', '/api/dictionary'),
  saveDictionary: (words) => req('POST', '/api/dictionary', { words }),
  search: (q, opts) => {
    const params = new URLSearchParams({
      q,
      regex: !!opts.regex,
      caseSensitive: !!opts.caseSensitive,
      wholeWord: !!opts.wholeWord,
    });
    return req('GET', `/api/search?${params.toString()}`);
  },
};

// Öffentliche Basis-URL für Links, die andere nutzen sollen (Freigabe, MCP): in der
// Desktop-App ist location.origin nur der lokale Server, der Remote-Server steht in /api/desktop/info.
let publicOriginValue = typeof location === 'undefined' ? '' : location.origin;
export const publicOrigin = () => publicOriginValue;
if (typeof location !== 'undefined') fetch('/api/desktop/info')
  .then((r) => (r.ok ? r.json() : null))
  .then((i) => { if (i && i.desktop && /^https?:\/\//.test(i.remote || '')) publicOriginValue = i.remote.replace(/\/+$/, ''); })
  .catch(() => {});
