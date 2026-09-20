import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { findProduct, parseCartItemKey } from '../products.js';

const CART_KEY = "bb_mock_cart";
const CartContext = createContext(null);

function readCartFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch {
    return {};
  }
}

function writeCartToStorage(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    window.dispatchEvent(new Event('cart_updated'));
  } catch {
    // ignore
  }
}

export function CartProvider({ children }) {
  const [cart, setCart] = useState(readCartFromStorage);

  const sync = useCallback(() => {
    setCart(readCartFromStorage());
  }, []);

  useEffect(() => {
    const onStorage = (e) => {
      if (!e || e.key === CART_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('cart_updated', sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('cart_updated', sync);
    };
  }, [sync]);

  const addToCart = useCallback((id, qty) => {
    setCart((prev) => {
      const next = { ...prev, [id]: (prev[id] || 0) + qty };
      writeCartToStorage(next);
      return next;
    });
  }, []);

  const setCartQty = useCallback((id, qty) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) {
        delete next[id];
      } else {
        next[id] = qty;
      }
      writeCartToStorage(next);
      return next;
    });
  }, []);

  const removeFromCart = useCallback((id) => {
    setCart((prev) => {
      const next = { ...prev };
      delete next[id];
      writeCartToStorage(next);
      return next;
    });
  }, []);

  const clearCart = useCallback(() => {
    const next = {};
    writeCartToStorage(next);
    setCart(next);
  }, []);

  const cartCount = useMemo(() => {
    return Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  }, [cart]);

  const cartTotal = useMemo(() => {
    return Object.entries(cart).reduce((sum, [key, qty]) => {
      const item = parseCartItemKey(key) || { product: findProduct(key), variant: null };
      const price = item.variant?.price || item.product?.price;
      return price ? sum + price * qty : sum;
    }, 0);
  }, [cart]);

  const value = useMemo(() => ({
    cart,
    addToCart,
    setCartQty,
    removeFromCart,
    clearCart,
    cartCount,
    cartTotal,
  }), [cart, addToCart, setCartQty, removeFromCart, clearCart, cartCount, cartTotal]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used within a CartProvider");
  return context;
}
