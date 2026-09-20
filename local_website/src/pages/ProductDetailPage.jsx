import React, { useState } from 'react';
import { findProduct, findVariant, getCartItemKey, formatPrice, isIpad } from '../products.js';
import { useCart } from '../context/CartContext.jsx';
import { ProductThumb } from '../components/ProductCard.jsx';
import { NotFoundPage } from './NotFoundPage.jsx';

export function ProductDetailPage({ params }) {
  const productId = params.get("id");
  const product = findProduct(productId);
  const { addToCart } = useCart();

  if (!product || isIpad(product)) {
    return (
      <NotFoundPage
        title="404 - Product Not Found"
        message={
          isIpad(product)
            ? "We're sorry, this iPad product could not be found (404 Not Found). This product may have been discontinued or removed."
            : "Product not found. The item you requested does not exist."
        }
      />
    );
  }

  const [selectedVariant, setSelectedVariant] = useState(() => findVariant(product));
  const [qty, setQty] = useState(1);
  const [showConfirmation, setShowConfirmation] = useState(false);

  const handleAddToCart = () => {
    const inputVal = document.getElementById("qty")?.value;
    let parsedQty = parseInt(inputVal !== undefined && inputVal !== "" ? inputVal : qty, 10);
    if (!Number.isFinite(parsedQty) || parsedQty < 1) parsedQty = 1;
    const itemKey = getCartItemKey(product.id, selectedVariant.id);
    addToCart(itemKey, parsedQty);
    setShowConfirmation(true);
  };

  return (
    <main id="main-content">
      <div className="breadcrumb">
        <a href="index.html">Home</a> /{" "}
        <a href={`index.html?category=${encodeURIComponent(product.category)}`}>
          {product.category}
        </a>{" "}
        / {product.name}
      </div>
      <div className="product-detail">
        <div>
          <div id="product-visual">
            <ProductThumb product={product} variant={selectedVariant} />
          </div>
          <div className="variant-panel">
            <div className="variant-heading">
              <strong>Color</strong>
              <span id="selected-color">{selectedVariant.name}</span>
            </div>
            <div className="variant-options" role="radiogroup" aria-label="Choose a color">
              {product.variants.map((variant) => {
                const isSelected = variant.id === selectedVariant.id;
                return (
                  <button
                    key={variant.id}
                    className={`variant-option${isSelected ? " selected" : ""}`}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    data-variant-id={variant.id}
                    title={`${variant.name}${variant.popular ? " - Most popular" : ""}`}
                    onClick={() => setSelectedVariant(variant)}
                  >
                    <span className="color-swatch" style={{ background: variant.hex }} />
                    <span>{variant.name}</span>
                    {variant.popular && <small>Most popular</small>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div>
          <h1>{product.name}</h1>
          <div className="product-rating">★ {product.rating.toFixed(1)} rating</div>
          <p>{product.blurb}</p>
          <div className="product-price" id="unit-price">
            {formatPrice(selectedVariant.price)}
          </div>

          <div className="qty-row">
            <label htmlFor="qty">Qty</label>
            <input
              type="number"
              id="qty"
              value={qty}
              min="1"
              max="10"
              onChange={(e) => setQty(e.target.value)}
            />
            <button className="btn" id="add-to-cart-btn" onClick={handleAddToCart}>
              Add to Cart
            </button>
          </div>
          <div
            id="add-confirmation"
            style={{ display: showConfirmation ? "block" : "none", color: "#1a7a1a", fontWeight: 600 }}
          >
            Added to cart.
          </div>

          <a className="btn secondary" href="cart.html" style={{ marginTop: "1rem", display: "inline-block" }}>
            View Cart
          </a>
        </div>
      </div>
    </main>
  );
}
