// Applies the saved theme before first paint to avoid a flash.
try {
  const saved = localStorage.getItem('lembar.theme');
  const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (_) {
  document.documentElement.dataset.theme = 'light';
}
