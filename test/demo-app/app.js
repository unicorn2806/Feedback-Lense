// Tiny SPA with deliberate flaws for exercising Feedback Lens.
const routes = { '/': ['tpl-cart', 'Warenkorb'], '/lieferung': ['tpl-delivery', 'Lieferung'], '/konto': ['tpl-account', 'Konto'] };

function render() {
  const [tpl, title] = routes[location.pathname] || routes['/'];
  document.title = `Bestellportal – ${title}`;
  const view = document.getElementById('view');
  view.replaceChildren(document.getElementById(tpl).content.cloneNode(true));
  bind();
}

function go(path) {
  history.pushState({}, '', path);
  render();
}

// Simulate what React attaches in development builds, so the component
// lookup can be tested without bundling React.
function fakeReact(el, chain, source) {
  let fiber = null;
  for (const name of chain.slice().reverse()) {
    const type = { [name]: function () {} }[name];
    fiber = { type, return: fiber, _debugOwner: null, _debugSource: name === chain[0] ? source : undefined };
  }
  el['__reactFiber$demo123'] = fiber;
}

function bind() {
  const next = document.getElementById('btn-next');
  if (next) {
    fakeReact(next, ['CheckoutButton', 'CartActions', 'CartPage', 'App'], { fileName: 'src/cart/CheckoutButton.jsx', lineNumber: 14 });
    next.addEventListener('click', async () => {
      next.textContent = 'Lädt …';
      try {
        const res = await fetch('/api/checkout?step=1&token=geheim123', { method: 'POST' });
        if (!res.ok) console.error('Checkout fehlgeschlagen', { status: res.status });
      } finally {
        setTimeout(() => go('/lieferung'), 2500); // deliberately slow
      }
    });
  }
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    document.querySelector('.items').innerHTML = '';
  });
  document.getElementById('coupon')?.addEventListener('click', () => {
    const value = document.querySelector('.code').value;
    value.trim().toUpperCase().foo.bar; // TypeError on purpose
  });
  document.getElementById('address')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = document.getElementById('error');
    err.hidden = false;
    err.textContent = 'Fehler 0x8004: Validierung fehlgeschlagen.';
  });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-route]');
  if (!a) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', render);
document.getElementById('btn-help').addEventListener('click', () => document.getElementById('help-dialog').showModal());
document.getElementById('help-close').addEventListener('click', () => document.getElementById('help-dialog').close());

// A JS modal with a typical focus trap: focus that leaves the modal is pulled back.
const news = document.getElementById('news-modal');
document.getElementById('btn-news').addEventListener('click', () => {
  news.hidden = false;
  document.getElementById('news-mail').focus();
});
document.getElementById('news-close').addEventListener('click', () => (news.hidden = true));
document.addEventListener('focusin', (e) => {
  if (!news.hidden && !news.contains(e.target)) document.getElementById('news-mail').focus();
}, true);

customElements.define('promo-banner', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box { max-width: 760px; margin: 0 auto; padding: 14px 20px; border-radius: 6px; background: linear-gradient(90deg,#ffe8a3,#ffd36b); display: flex; align-items: center; justify-content: space-between; font-family: Arial, sans-serif; }
        button { background: #ffb300; border: 0; padding: 8px 14px; border-radius: 4px; font-weight: bold; }
      </style>
      <div class="box"><span>🔥 Nur heute: 10 % auf Bürostühle!</span><button class="promo-cta">Jetzt sichern</button></div>`;
  }
});

render();
