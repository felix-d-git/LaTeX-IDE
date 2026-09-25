const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']);

export function fileKind(relPath) {
  const dot = relPath.lastIndexOf('.');
  const ext = dot >= 0 ? relPath.slice(dot).toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'text';
}

export function createPreviewManager(container) {
  const tabs = new Set();
  let activePath = null;

  function render(path, kind) {
    container.innerHTML = '';
    const url = `/api/raw?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'file-preview-image';
      img.src = url;
      container.appendChild(img);
    } else {
      const iframe = document.createElement('iframe');
      iframe.className = 'file-preview-pdf';
      iframe.src = url;
      container.appendChild(iframe);
    }
  }

  function openFile(path, kind) {
    tabs.add(path);
    activePath = path;
    render(path, kind);
  }

  function closeTab(path) {
    tabs.delete(path);
    if (activePath === path) {
      activePath = null;
      container.innerHTML = '';
    }
  }

  function getActivePath() {
    return activePath;
  }

  function getTabs() {
    return [...tabs];
  }

  function isOpen(path) {
    return tabs.has(path);
  }

  return { openFile, closeTab, getActivePath, getTabs, isOpen };
}
