// Connect page: copy buttons.
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    const el = document.querySelector(b.dataset.copy);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent.trim());
      b.textContent = 'copied'; b.classList.add('done');
      setTimeout(() => { b.textContent = 'copy'; b.classList.remove('done'); }, 1600);
    } catch { /* clipboard blocked: the text is selectable */ }
  });
}

