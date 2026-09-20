import React from 'react';
import { formatPrice } from '../products.js';

export function ProductThumb({ product, extraClass = "", variant = null }) {
  const image = variant?.image || product.image;
  const imageClass = image ? "has-image" : "";
  const visual = image ? (
    <img
      src={image}
      alt={`${product.name}${variant ? ` in ${variant.name}` : ""}`}
      onError={(e) => {
        e.currentTarget.onerror = null;
        if (product.image && e.currentTarget.src !== product.image) {
          e.currentTarget.src = product.image;
        }
      }}
    />
  ) : (
    product.name
  );

  return (
    <div
      className={`product-thumb ${imageClass} ${extraClass}`.trim()}
      style={{ background: product.color }}
    >
      {visual}
    </div>
  );
}

export function ProductCard({ product }) {
  return (
    <a
      className="product-card"
      href={`product.html?id=${product.id}`}
      data-testid={`product-card-${product.id}`}
    >
      <ProductThumb product={product} />
      <div className="product-name">{product.name}</div>
      <div className="product-rating">★ {product.rating.toFixed(1)}</div>
      <div className="product-price">{formatPrice(product.price)}</div>
    </a>
  );
}
