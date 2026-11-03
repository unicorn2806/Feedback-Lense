// Report preview for the dashboard. A sandboxed page (manifest "sandbox"): its
// own opaque origin and no extension APIs, so the report – including what it
// quotes from the tested page – runs exactly as the exported file would, with
// its own scripts, but cannot reach the extension. The dashboard sends the HTML.
let shown = false;
window.addEventListener('message', (e) => {
  if (shown || e.source !== window.parent || typeof e.data?.html !== 'string') return;
  shown = true;
  document.open();
  document.write(e.data.html);
  document.close();
  // Esc closes the preview – unless the report used it (e.g. to close a large picture)
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.defaultPrevented) window.parent.postMessage({ type: 'fl:preview-close' }, '*');
  });
});
