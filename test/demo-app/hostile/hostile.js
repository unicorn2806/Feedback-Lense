document.getElementById('api').addEventListener('click', async () => {
  await fetch('/api/checkout?apiKey=supersecret', { method: 'POST' }).catch(() => {});
  try {
    document.getElementById('lead').innerHTML = '<b>blocked by trusted types</b>';
  } catch (e) {
    console.error('Trusted Types blocked innerHTML:', e.message);
  }
});
