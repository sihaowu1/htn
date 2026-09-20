import React, { useState, useEffect } from 'react';
import { AuthProvider } from './context/AuthContext.jsx';
import { CartProvider } from './context/CartContext.jsx';
import { SiteHeader } from './components/SiteHeader.jsx';
import { CategoryNav } from './components/CategoryNav.jsx';
import { SiteFooter } from './components/SiteFooter.jsx';
import { HomePage } from './pages/HomePage.jsx';
import { ProductDetailPage } from './pages/ProductDetailPage.jsx';
import { CartPage } from './pages/CartPage.jsx';
import { CheckoutPage } from './pages/CheckoutPage.jsx';
import { AuthPage } from './pages/AuthPage.jsx';
import {
  PRODUCTS,
  CATEGORIES,
  findProduct,
  findVariant,
  getCartItemKey,
  parseCartItemKey,
  formatPrice,
} from './products.js';

function getRoute(pathname) {
  const p = (pathname || '').toLowerCase();
  if (p.endsWith('product.html')) return 'product';
  if (p.endsWith('cart.html')) return 'cart';
  if (p.endsWith('checkout.html')) return 'checkout';
  if (p.endsWith('auth.html')) return 'auth';
  return 'home';
}

export function App() {
  const [pathname, setPathname] = useState(() => (typeof window !== 'undefined' ? window.location.pathname : '/'));
  const [search, setSearch] = useState(() => (typeof window !== 'undefined' ? window.location.search : ''));

  useEffect(() => {
    const handlePopState = () => {
      setPathname(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const route = getRoute(pathname);
  const params = new URLSearchParams(search);

  let activeCategory = 'All';
  if (route === 'home') {
    activeCategory = params.get('category') || 'All';
  } else if (route === 'product') {
    const prod = findProduct(params.get('id'));
    activeCategory = prod ? prod.category : 'All';
  }

  const initialQuery = params.get('q') || '';

  return (
    <AuthProvider>
      <CartProvider>
        <SiteHeader initialQuery={initialQuery} />
        <CategoryNav activeCategory={activeCategory} />
        {route === 'home' && <HomePage params={params} />}
        {route === 'product' && <ProductDetailPage params={params} />}
        {route === 'cart' && <CartPage />}
        {route === 'checkout' && <CheckoutPage />}
        {route === 'auth' && <AuthPage params={params} />}
        <SiteFooter />
      </CartProvider>
    </AuthProvider>
  );
}
