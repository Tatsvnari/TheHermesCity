// The contract address bar: click anywhere on it to copy the address.
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-ca]'); if (!el) return;
  const btn = el.querySelector('.ca-copy');
  try { await navigator.clipboard.writeText(el.dataset.ca); } catch { return; }
  if (btn) { btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1600); }
});
