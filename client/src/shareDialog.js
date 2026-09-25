export function setupShareDialog() {
  const modal = document.getElementById('share-dialog');
  const btnOpen = document.getElementById('btn-share');
  const btnClose = document.getElementById('btn-close-share');

  function show() {
    modal.classList.remove('hidden');
  }

  function hide() {
    modal.classList.add('hidden');
  }

  function toggle() {
    modal.classList.contains('hidden') ? show() : hide();
  }

  function isOpen() {
    return !modal.classList.contains('hidden');
  }

  btnOpen.addEventListener('click', show);
  btnClose.addEventListener('click', hide);

  return { show, hide, toggle, isOpen };
}
