function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

async function req(method, url, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
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
  deleteAccount: (password) => req('POST', '/api/auth/delete-account', { password }),
  desktopRelease: () => req('GET', '/api/desktop/release'),
};

export const shareApi = {
  get: () => req('GET', '/api/share'),
  add: (login) => req('POST', '/api/share', { login }),
  remove: (userId) => req('DELETE', `/api/share/${encodeURIComponent(userId)}`),
};

export const adminApi = {
  createInvite: () => req('POST', '/api/admin/invites'),
  listInvites: () => req('GET', '/api/admin/invites'),
  revokeInvite: (token) => req('DELETE', `/api/admin/invites/${encodeURIComponent(token)}`),
  updateStatus: () => req('GET', '/api/admin/update'),
  requestUpdate: () => req('POST', '/api/admin/update'),
};

export const api = {
  listProjects: () => req('GET', '/api/projects/list'),
  openProject: (root) => req('POST', '/api/projects/open', { root }),
  createProject: (name) => req('POST', '/api/projects/create', { name }),
  renameProject: (oldName, newName) => req('POST', '/api/projects/rename', { oldName, newName }),
  copyProject: (name, newName) => req('POST', '/api/projects/copy', { name, newName }),
  archiveProject: (name) => req('POST', '/api/projects/archive', { name }),
  unarchiveProject: (name) => req('POST', '/api/projects/unarchive', { name }),
  trashProject: (name) => req('POST', '/api/projects/trash', { name }),
  restoreProject: (name) => req('POST', '/api/projects/restore', { name }),
  deleteProjectPermanently: (name) => req('DELETE', `/api/projects/trash/${encodeURIComponent(name)}`),
  projectZipUrl: (name) => `/api/projects/${encodeURIComponent(name)}/download/zip`,
  projectPdfUrl: (name) => `/api/projects/${encodeURIComponent(name)}/download/pdf`,
  getTree: () => req('GET', '/api/tree'),
  getFile: (relPath) => req('GET', `/api/file?path=${encodeURIComponent(relPath)}`),
  saveFile: (relPath, content) => req('PUT', '/api/file', { path: relPath, content }),
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
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ path: relPath, targetDir, overwrite: !!overwrite }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.conflict) return { conflict: true };
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  },
  deletePath: (relPath) => req('DELETE', `/api/tree?path=${encodeURIComponent(relPath)}`),
  uploadFile: (dir, name, contentBase64) => req('POST', '/api/tree/upload', { dir, name, content: contentBase64 }),
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
  search: (q, opts) => {
    const params = new URLSearchParams({
      q,
      regex: !!opts.regex,
      caseSensitive: !!opts.caseSensitive,
      wholeWord: !!opts.wholeWord,
    });
    return req('GET', `/api/search?${params.toString()}`);
  },
  replaceAll: (query, replacement, opts) =>
    req('POST', '/api/replace', { query, replacement, ...opts }),
};
