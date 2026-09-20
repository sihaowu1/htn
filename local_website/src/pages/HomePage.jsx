import React, { useMemo } from 'react';
import { PRODUCTS } from '../products.js';
import { DealRail } from '../components/DealRail.jsx';
import { ProductCard } from '../components/ProductCard.jsx';

function editDistance(left, right) {
  const distances = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = distances[0];
    distances[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = distances[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      distances[rightIndex] = Math.min(
        distances[rightIndex] + 1,
        distances[rightIndex - 1] + 1,
        diagonal + cost
      );
      diagonal = above;
    }
  }
  return distances[right.length];
}

function searchableTerms(product) {
  return [product.name, product.category, ...(product.searchTerms || [])].map((term) =>
    term.toLowerCase()
  );
}

function findSuggestion(query) {
  const terms = [...new Set(PRODUCTS.flatMap(searchableTerms))];
  const maxDistance = query.length < 5 ? 1 : 2;
  return terms
    .map((term) => ({ term, distance: editDistance(query, term) }))
    .filter(({ term, distance }) => distance <= maxDistance && term !== query)
    .sort((left, right) => left.distance - right.distance || left.term.length - right.term.length)[0]?.term;
}

export function HomePage({ params }) {
  const q = (params.get("q") || "").trim().toLowerCase();
  const category = params.get("category") || "All";

  const { results, correctedQuery } = useMemo(() => {
    let filtered = PRODUCTS.filter((p) => category === "All" || p.category === category);
    if (q) {
      filtered = filtered.filter((p) => searchableTerms(p).some((term) => term.includes(q)));
    }

    const suggestion = !filtered.length && q ? findSuggestion(q) : "";
    if (suggestion) {
      filtered = PRODUCTS.filter((p) => category === "All" || p.category === category).filter(
        (p) => searchableTerms(p).some((term) => term.includes(suggestion))
      );
    }
    return { results: filtered, correctedQuery: suggestion };
  }, [category, q]);

  const showDealRail = !q && category === "All";

  const resultsLabel = q
    ? `Search results for "${correctedQuery || q}" (${results.length})`
    : `${category} (${results.length})`;

  return (
    <main>
      <DealRail hidden={!showDealRail} />
      <div className="breadcrumb" id="results-label">
        {resultsLabel}
      </div>
      <div
        className="search-suggestion"
        id="search-suggestion"
        hidden={!correctedQuery}
      >
        {correctedQuery ? `Did you mean "${correctedQuery}"?` : ""}
      </div>
      <div className="product-grid" id="product-grid">
        {results.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
      <div
        className="empty-state"
        id="empty-state"
        hidden={results.length > 0}
      >
        No products found. Try a different search or category.
      </div>
    </main>
  );
}
