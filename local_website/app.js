// Shared cart logic and page chrome for the mock store.
const CART_KEY = "bb_mock_cart";

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function addToCart(id, qty) {
  const cart = getCart();
  cart[id] = (cart[id] || 0) + qty;
  saveCart(cart);
}

function setCartQty(id, qty) {
  const cart = getCart();
  if (qty <= 0) {
    delete cart[id];
  } else {
    cart[id] = qty;
  }
  saveCart(cart);
}

function removeFromCart(id) {
  const cart = getCart();
  delete cart[id];
  saveCart(cart);
}

function cartCount() {
  return Object.values(getCart()).reduce((sum, qty) => sum + qty, 0);
}

function cartTotal() {
  const cart = getCart();
  return Object.entries(cart).reduce((sum, [id, qty]) => {
    const p = findProduct(id);
    return p ? sum + p.price * qty : sum;
  }, 0);
}

function formatPrice(n) {
  return "$" + n.toFixed(2);
}

function productThumbHtml(p, extraClass = "") {
  return `<div class="product-thumb ${extraClass}" style="background:${p.color}">${p.name}</div>`;
}

function renderHeader(activeCategory) {
  const header = document.getElementById("site-header");
  header.innerHTML = `
    <div class="header-row">
      <a class="logo" href="index.html">Best<span class="dot">Buy</span> Mock</a>
      <form class="search-form" action="index.html" method="get">
        <input type="search" name="q" placeholder="Search products, brands..." aria-label="Search" />
        <button type="submit">Search</button>
      </form>
      <a class="cart-link" href="cart.html">
        Cart <span class="cart-count" id="cart-count">0</span>
      </a>
    </div>
  `;

  const nav = document.getElementById("category-nav");
  nav.innerHTML = `
    <div class="cat-row">
      ${CATEGORIES.map(
        (c) =>
          `<a href="index.html?category=${encodeURIComponent(c)}" class="${c === activeCategory ? "active" : ""}">${c}</a>`
      ).join("")}
    </div>
  `;

  document.getElementById("cart-count").textContent = cartCount();
}

function renderFooter() {
  const footer = document.getElementById("site-footer");
  footer.innerHTML = `<p>This is a disposable mock store for testing purposes only. Not a real retailer.</p>`;
}

document.addEventListener("DOMContentLoaded", () => {
  renderFooter();
});
