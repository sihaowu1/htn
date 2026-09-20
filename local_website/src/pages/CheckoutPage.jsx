import React, { useState } from 'react';
import { parseCartItemKey, findProduct, formatPrice } from '../products.js';
import { useCart } from '../context/CartContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export function CheckoutPage() {
  const { cart, clearCart, cartTotal } = useCart();
  const { currentUser } = useAuth();

  const [orderConfirmed, setOrderConfirmed] = useState(null);

  const entries = Object.entries(cart).filter(([key]) => parseCartItemKey(key) || findProduct(key));

  const authUrl = (returnTo = 'checkout.html') => `auth.html?returnTo=${encodeURIComponent(returnTo)}`;

  if (entries.length === 0 && !orderConfirmed) {
    return (
      <main>
        <h1>Checkout</h1>
        <div id="checkout-content">
          <div className="empty-state">
            Your cart is empty. <a href="index.html">Continue shopping</a>
          </div>
        </div>
      </main>
    );
  }

  if (!currentUser && !orderConfirmed) {
    return (
      <main>
        <h1>Checkout</h1>
        <div id="checkout-content">
          <div className="auth-required">
            <h2>Sign in to continue</h2>
            <p>Your cart is saved. Sign in or create an account before checkout.</p>
            <a className="btn yellow" href={authUrl('checkout.html')}>
              Sign in or create an account
            </a>
          </div>
        </div>
      </main>
    );
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fullname = form.get('fullname');
    const email = form.get('email');
    const orderId = 'BB-' + Math.floor(100000 + Math.random() * 900000);
    clearCart();
    setOrderConfirmed({ fullname, email, orderId });
  };

  return (
    <main>
      <h1>Checkout</h1>
      <div id="checkout-content">
        {orderConfirmed ? (
          <div className="confirmation-card">
            <h2>Order Confirmed!</h2>
            <p>
              Thank you, <strong>{orderConfirmed.fullname}</strong>! Your order <code>#{orderConfirmed.orderId}</code> has been placed.
            </p>
            <p>
              A confirmation email has been sent to <strong>{orderConfirmed.email}</strong>.
            </p>
            <a className="btn yellow" href="index.html" style={{ marginTop: '1rem', display: 'inline-block' }}>
              Continue shopping
            </a>
          </div>
        ) : (
          <div className="checkout-grid">
            <div className="form-card">
              <h2>Shipping Information</h2>
              <form id="checkout-form" onSubmit={handleSubmit}>
                <div className="form-row">
                  <label htmlFor="fullname">Full name</label>
                  <input type="text" id="fullname" name="fullname" defaultValue={currentUser?.name || ''} required />
                </div>
                <div className="form-row">
                  <label htmlFor="email">Email</label>
                  <input type="email" id="email" name="email" defaultValue={currentUser?.email || ''} required />
                </div>
                <div className="form-row">
                  <label htmlFor="address">Address</label>
                  <input type="text" id="address" name="address" required />
                </div>
                <div className="form-row-pair">
                  <div className="form-row">
                    <label htmlFor="city">City</label>
                    <input type="text" id="city" name="city" required />
                  </div>
                  <div className="form-row">
                    <label htmlFor="zip">ZIP code</label>
                    <input type="text" id="zip" name="zip" required />
                  </div>
                </div>
                <h2>Payment</h2>
                <div className="form-row">
                  <label htmlFor="cardnum">Card number</label>
                  <input type="text" id="cardnum" name="cardnum" placeholder="4242 4242 4242 4242" required />
                </div>
                <div className="form-row-pair">
                  <div className="form-row">
                    <label htmlFor="expiry">Expiry</label>
                    <input type="text" id="expiry" name="expiry" placeholder="MM/YY" required />
                  </div>
                  <div className="form-row">
                    <label htmlFor="cvc">CVC</label>
                    <input type="text" id="cvc" name="cvc" placeholder="123" required />
                  </div>
                </div>
                <button type="submit" className="btn yellow" id="place-order-btn">
                  Place Order
                </button>
              </form>
            </div>
            <div className="cart-summary">
              <h2>Order Summary</h2>
              {entries.map(([key, qty]) => {
                const item = parseCartItemKey(key) || { product: findProduct(key), variant: null };
                const p = item.product;
                const variant = item.variant;
                const price = variant?.price || p.price;
                return (
                  <div className="summary-row" key={key}>
                    <span>
                      {p.name}
                      {variant ? ` (${variant.name})` : ''} × {qty}
                    </span>
                    <span>{formatPrice(price * qty)}</span>
                  </div>
                );
              })}
              <div className="summary-row total" style={{ marginTop: '1rem' }}>
                <span>Total</span>
                <span>{formatPrice(cartTotal)}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
