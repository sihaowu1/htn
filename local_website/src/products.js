// Mock product catalog for the disposable test store.
export const PRODUCTS = [
  { id: "p1", name: "Vantage 55\" 4K OLED TV", category: "TVs", searchTerms: ["television"], image: "images_for_mock_up/tv_image.jpg", price: 1299.99, rating: 4.6, color: "#0b1f3a", blurb: "Stunning 4K OLED picture with smart streaming built in." },
  { id: "p2", name: "Crestline 65\" QLED TV", category: "TVs", searchTerms: ["television"], image: "images_for_mock_up/tv_qled.svg", price: 899.99, rating: 4.3, color: "#123a5c", blurb: "Bright, vivid QLED colors for movie night." },
  { id: "p3", name: "Aperture 43\" LED TV", category: "TVs", searchTerms: ["television"], image: "images_for_mock_up/tv_led.svg", price: 329.99, rating: 4.0, color: "#1c5177", blurb: "Affordable everyday TV with crisp HD detail." },
  { id: "p4", name: "Nimbus 14 Ultralight Laptop", category: "Laptops", image: "images_for_mock_up/laptop_image.jpg", price: 1099.0, rating: 4.5, color: "#3a2b5c", blurb: "Featherweight laptop with all-day battery life." },
  { id: "p5", name: "Forge 16 Pro Laptop", category: "Laptops", image: "images_for_mock_up/laptop_forge.svg", price: 1699.0, rating: 4.7, color: "#4a3474", blurb: "High-performance laptop for creators and gamers." },
  { id: "p6", name: "Meadow 11 Chromebook", category: "Laptops", image: "images_for_mock_up/laptop_chromebook.svg", price: 249.0, rating: 4.1, color: "#5a3f8e", blurb: "Simple, fast, and budget-friendly for everyday tasks." },
  { id: "p7", name: "Halo X12 Smartphone", category: "Phones", image: "images_for_mock_up/phone_halo_x12.svg", price: 799.0, rating: 4.4, color: "#7a1f3a", blurb: "Flagship camera and all-day battery in a sleek body." },
  { id: "p8", name: "Halo SE Smartphone", category: "Phones", image: "images_for_mock_up/phone_halo_se.svg", price: 449.0, rating: 4.2, color: "#8f2a49", blurb: "Great value with the features you actually use." },
  { id: "p9", name: "Orbit Buds Pro", category: "Audio", searchTerms: ["airpods", "earbuds"], image: "images_for_mock_up/airpods_image.jpg", price: 179.99, rating: 4.5, color: "#8a5a12", blurb: "Wireless earbuds with active noise cancellation." },
  { id: "p10", name: "Resonate Soundbar 3.1", category: "Audio", image: "images_for_mock_up/soundbar_resonate.svg", price: 229.99, rating: 4.3, color: "#a3690f", blurb: "Fill the room with theater-quality sound." },
  { id: "p11", name: "Pulsewave Over-Ear Headphones", category: "Audio", image: "images_for_mock_up/headphones_pulsewave.svg", price: 149.99, rating: 4.4, color: "#b8790f", blurb: "Comfortable over-ear headphones with deep bass." },
  { id: "p12", name: "Vertex RTX Gaming Desktop", category: "Gaming", image: "images_for_mock_up/gaming_desktop_vertex.svg", price: 1899.0, rating: 4.8, color: "#1f5c3a", blurb: "Ray-traced gaming performance for competitive play." },
  { id: "p13", name: "Wanderer Handheld Console", category: "Gaming", image: "images_for_mock_up/console_wanderer.svg", price: 349.0, rating: 4.6, color: "#2a7548", blurb: "Take your library with you, anywhere." },
  { id: "p14", name: "GripPro Wireless Controller", category: "Gaming", image: "images_for_mock_up/controller_grippro.svg", price: 59.99, rating: 4.2, color: "#348a56", blurb: "Precision controls with a comfortable grip." },
  { id: "p15", name: "TidyHome Robot Vacuum", category: "Home", image: "images_for_mock_up/robot_vacuum_tidyhome.svg", price: 299.99, rating: 4.1, color: "#5c4a1f", blurb: "Automatic cleaning that maps your whole home." },
  { id: "p16", name: "ChillZone Mini Fridge", category: "Home", image: "images_for_mock_up/fridge_chillzone.svg", price: 129.99, rating: 3.9, color: "#705a26", blurb: "Compact fridge perfect for dorms and offices." },
  { id: "p17", name: "AeroPad Air 11", category: "Tablets", searchTerms: ["ipad", "tablet"], image: "images_for_mock_up/ipad_image.webp", price: 599.0, rating: 4.7, color: "#2463a5", blurb: "A bright, lightweight tablet for streaming, notes, and everyday creativity." },
  { id: "p18", name: "AeroPad Pro 12.9", category: "Tablets", searchTerms: ["ipad", "tablet"], image: "images_for_mock_up/ipad_pro.svg", price: 999.0, rating: 4.8, color: "#183d68", blurb: "A powerful large-format tablet with a vivid display for demanding work." },
  { id: "p19", name: "AeroPad Mini", category: "Tablets", searchTerms: ["ipad", "tablet"], image: "images_for_mock_up/ipad_mini.svg", price: 449.0, rating: 4.5, color: "#8d526d", blurb: "A compact tablet that fits comfortably into every kind of day." },
];

export const CATEGORIES = ["All", "TVs", "Laptops", "Tablets", "Phones", "Audio", "Gaming", "Home"];

export const VARIANT_PALETTE = {
  blue: "#2563eb",
  grey: "#6b7280",
  black: "#171717",
  yellow: "#eab308",
  purple: "#7c3aed",
  green: "#16a34a",
};

export const PRODUCT_COLOR_SETS = {
  TVs: ["black", "grey", "blue"],
  Laptops: ["grey", "black", "purple"],
  Tablets: ["blue", "grey", "purple"],
  Phones: ["black", "blue", "green"],
  Audio: ["black", "grey", "blue"],
  Gaming: ["black", "green", "purple"],
  Home: ["grey", "black", "green"],
};

export function variantImagePath(product, color) {
  return `images_for_mock_up/${product.id}-${color}.png`;
}

PRODUCTS.forEach((product) => {
  const colors = (PRODUCT_COLOR_SETS[product.category] || ["blue", "grey", "black"]).filter(
    (color) => VARIANT_PALETTE[color]
  );
  product.variants = colors.map((color, index) => ({
    id: color,
    name: color[0].toUpperCase() + color.slice(1),
    hex: VARIANT_PALETTE[color],
    image: variantImagePath(product, color),
    price: Number((product.price + (index - 1) * 10).toFixed(2)),
    popular: index === 0,
  }));
});

export function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}

export function findVariant(product, variantId) {
  return product?.variants?.find((variant) => variant.id === variantId) || product?.variants?.[0];
}

export function getCartItemKey(productId, variantId) {
  return `${productId}::${variantId}`;
}

export function parseCartItemKey(key) {
  const [productId, variantId] = key.split("::");
  const product = findProduct(productId);
  return product ? { product, variant: findVariant(product, variantId) } : null;
}

export function formatPrice(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

export function isWirelessController(product) {
  if (!product) return false;
  const name = (product.name || "").toLowerCase();
  return name.includes("wireless controller") || product.id === "p14";
}

export function getCartItemPrice(product, variant) {
  const basePrice = variant?.price ?? product?.price ?? 0;
  // Bug: Wireless controllers cost 10x the amount listed
  if (isWirelessController(product)) {
    return Number((basePrice * 10).toFixed(2));
  }
  return basePrice;
}
