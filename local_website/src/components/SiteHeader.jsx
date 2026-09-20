import React from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useCart } from '../context/CartContext.jsx';

export function SiteHeader({ initialQuery = '' }) {
  const { currentUser } = useAuth();
  const { cartCount } = useCart();

  const authUrl = () => {
    const returnTo = typeof window !== 'undefined' ? window.location.href : 'index.html';
    return `auth.html?returnTo=${encodeURIComponent(returnTo)}`;
  };

  return (
    <header className="site-header" id="site-header">
      <div className="header-row">
        <a className="logo" href="index.html">
          Best<span className="dot">Buy</span> Mock
        </a>
        <form className="search-form" action="index.html" method="get">
          <input
            type="search"
            name="q"
            placeholder="Search products, brands..."
            aria-label="Search"
            defaultValue={initialQuery}
          />
          <button type="submit">Search</button>
        </form>
        {currentUser ? (
          <a className="account-link" href="auth.html">
            <span className="account-label">Hello,</span> <strong>{currentUser.name}</strong>
          </a>
        ) : (
          <a className="account-link" href={authUrl()}>
            Sign in
          </a>
        )}
        <a className="cart-link" href="cart.html">
          Cart <span className="cart-count" id="cart-count">{cartCount}</span>
        </a>
      </div>
    </header>
  );
}
