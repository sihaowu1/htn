import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import {
  PRODUCTS,
  CATEGORIES,
  findProduct,
  findVariant,
  getCartItemKey,
  parseCartItemKey,
  formatPrice,
} from './products.js';

// Expose legacy helpers on window for backwards compatibility with any automation/tests
if (typeof window !== 'undefined') {
  window.PRODUCTS = PRODUCTS;
  window.CATEGORIES = CATEGORIES;
  window.findProduct = findProduct;
  window.findVariant = findVariant;
  window.getCartItemKey = getCartItemKey;
  window.parseCartItemKey = parseCartItemKey;
  window.formatPrice = formatPrice;

  const CART_KEY = 'bb_mock_cart';
  const USER_KEY = 'bb_mock_user';

  window.getCart = function() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY)) || {};
    } catch {
      return {};
    }
  };

  window.saveCart = function(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    window.dispatchEvent(new Event('cart_updated'));
  };

  window.addToCart = function(id, qty) {
    const cart = window.getCart();
    cart[id] = (cart[id] || 0) + qty;
    window.saveCart(cart);
  };

  window.setCartQty = function(id, qty) {
    const cart = window.getCart();
    if (qty <= 0) {
      delete cart[id];
    } else {
      cart[id] = qty;
    }
    window.saveCart(cart);
  };

  window.removeFromCart = function(id) {
    const cart = window.getCart();
    delete cart[id];
    window.saveCart(cart);
  };

  window.cartCount = function() {
    return Object.values(window.getCart()).reduce((sum, qty) => sum + qty, 0);
  };

  window.cartTotal = function() {
    const cart = window.getCart();
    return Object.entries(cart).reduce((sum, [key, qty]) => {
      const item = parseCartItemKey(key) || { product: findProduct(key), variant: null };
      const price = item.variant?.price || item.product?.price;
      return price ? sum + price * qty : sum;
    }, 0);
  };

  window.getCurrentUser = function() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY)) || null;
    } catch {
      return null;
    }
  };

  window.saveCurrentUser = function(user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    window.dispatchEvent(new Event('auth_updated'));
  };

  window.clearCurrentUser = function() {
    localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new Event('auth_updated'));
  };
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
