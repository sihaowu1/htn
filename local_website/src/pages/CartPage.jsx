import React from 'react';
import { parseCartItemKey, findProduct, formatPrice, getCartItemPrice } from '../products.js';
import { useCart } from '../context/CartContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { ProductThumb } from '../components/ProductCard.jsx';

export function CartPage() {
  const { cart, setCartQty, removeFromCart, cartCount, cartTotal } = useCart();
  const { currentUser } = useAuth();

  const entries = Object.entries(cart).filter(([key]) => parseCartItemKey(key) || findProduct(key));

  const authUrl = (returnTo = 'checkout.html') => `auth.html?returnTo=${encodeURIComponent(returnTo)}`;
  const checkoutHref = currentUser ? 'checkout.html' : authUrl('checkout.html');

  return (
    <main>
      <h1>Your Cart</h1>
      <div id="cart-content">
        {entries.length === 0 ? (
          <div className="empty-state">
            Your cart is empty. <a href="index.html">Continue shopping</a>
          </div>
        ) : (
          <>
            <div>
              {entries.map(([key, qty]) => {
                const item = parseCartItemKey(key) || { product: findProduct(key), variant: null };
                const p = item.product;
                const variant = item.variant;
                const price = getCartItemPrice(p, variant);

                return (
                  <div className="cart-item" key={key} data-testid={`cart-item-${key}`}>
                    <ProductThumb product={p} variant={variant} />
                    <div className="cart-item-info">
                      <div className="product-name">
                        <a href={`product.html?id=${p.id}`}>{p.name}</a>
                      </div>
                      {variant && <div className="cart-variant">Color: {variant.name}</div>}
                      <div className="product-price">{formatPrice(price)}</div>
                      <div className="qty-row">
                        <label htmlFor={`qty-${key}`}>Qty</label>
                        <input
                          type="number"
                          id={`qty-${key}`}
                          min="1"
                          max="10"
                          value={qty}
                          data-id={key}
                          className="qty-input"
                          onChange={(e) => {
                            let newQty = parseInt(e.target.value, 10);
                            if (!Number.isFinite(newQty) || newQty < 1) newQty = 1;
                            setCartQty(key, newQty);
                          }}
                        />
                        <button
                          className="remove-link"
                          data-id={key}
                          type="button"
                          onClick={() => removeFromCart(key)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="cart-summary">
              <div className="summary-row">
                <span>Items ({cartCount})</span>
                <span>{formatPrice(cartTotal)}</span>
              </div>
              <div className="summary-row">
                <span>Shipping</span>
                <span>Free</span>
              </div>
              <div className="summary-row total">
                <span>Total</span>
                <span id="cart-total">{formatPrice(cartTotal)}</span>
              </div>
              <a
                className="btn yellow"
                style={{ display: 'block', textAlign: 'center', marginTop: '1rem' }}
                href={checkoutHref}
              >
                {currentUser ? 'Checkout' : 'Sign in to checkout'}
              </a>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
