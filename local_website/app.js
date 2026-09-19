// Shared cart logic and page chrome for the mock store.
const CART_KEY = "bb_mock_cart";
const USER_KEY = "bb_mock_user";

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

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY)) || null;
  } catch {
    return null;
  }
}

function saveCurrentUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearCurrentUser() {
  localStorage.removeItem(USER_KEY);
}

function authUrl(returnTo = window.location.href) {
  return `auth.html?returnTo=${encodeURIComponent(returnTo)}`;
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
  return Object.entries(cart).reduce((sum, [key, qty]) => {
    const item = parseCartItemKey(key) || { product: findProduct(key), variant: null };
    const price = item.variant?.price || item.product?.price;
    return price ? sum + price * qty : sum;
  }, 0);
}

function formatPrice(n) {
  return "$" + n.toFixed(2);
}

function productThumbHtml(p, extraClass = "", variant = null) {
  const image = variant?.image || p.image;
  const visual = image
    ? `<img src="${image}" alt="${p.name}${variant ? ` in ${variant.name}` : ""}" onerror="this.onerror=null;this.src='${p.image}'" />`
    : p.name;
  const imageClass = image ? "has-image" : "";
  return `<div class="product-thumb ${imageClass} ${extraClass}" style="background:${p.color}">${visual}</div>`;
}

function renderHeader(activeCategory) {
  const header = document.getElementById("site-header");
  const user = getCurrentUser();
  const accountHtml = user
    ? `<a class="account-link" href="auth.html"><span class="account-label">Hello,</span> <strong>${user.name}</strong></a>`
    : `<a class="account-link" href="${authUrl()}">Sign in</a>`;
  header.innerHTML = `
    <div class="header-row">
      <a class="logo" href="index.html">Best<span class="dot">Buy</span> Mock</a>
      <form class="search-form" action="index.html" method="get">
        <input type="search" name="q" placeholder="Search products, brands..." aria-label="Search" />
        <button type="submit">Search</button>
      </form>
      ${accountHtml}
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
