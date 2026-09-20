import React from 'react';
import { CATEGORIES } from '../products.js';

export function CategoryNav({ activeCategory = 'All' }) {
  return (
    <nav className="category-nav" id="category-nav">
      <div className="cat-row">
        {CATEGORIES.map((c) => (
          <a
            key={c}
            href={`index.html?category=${encodeURIComponent(c)}`}
            className={c === activeCategory ? "active" : ""}
          >
            {c}
          </a>
        ))}
      </div>
    </nav>
  );
}
