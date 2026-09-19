// Mock product catalog for the disposable test store.
const PRODUCTS = [
  { id: "p1", name: "Vantage 55\" 4K OLED TV", category: "TVs", price: 1299.99, rating: 4.6, color: "#0b1f3a", blurb: "Stunning 4K OLED picture with smart streaming built in." },
  { id: "p2", name: "Crestline 65\" QLED TV", category: "TVs", price: 899.99, rating: 4.3, color: "#123a5c", blurb: "Bright, vivid QLED colors for movie night." },
  { id: "p3", name: "Aperture 43\" LED TV", category: "TVs", price: 329.99, rating: 4.0, color: "#1c5177", blurb: "Affordable everyday TV with crisp HD detail." },
  { id: "p4", name: "Nimbus 14 Ultralight Laptop", category: "Laptops", price: 1099.0, rating: 4.5, color: "#3a2b5c", blurb: "Featherweight laptop with all-day battery life." },
  { id: "p5", name: "Forge 16 Pro Laptop", category: "Laptops", price: 1699.0, rating: 4.7, color: "#4a3474", blurb: "High-performance laptop for creators and gamers." },
  { id: "p6", name: "Meadow 11 Chromebook", category: "Laptops", price: 249.0, rating: 4.1, color: "#5a3f8e", blurb: "Simple, fast, and budget-friendly for everyday tasks." },
  { id: "p7", name: "Halo X12 Smartphone", category: "Phones", price: 799.0, rating: 4.4, color: "#7a1f3a", blurb: "Flagship camera and all-day battery in a sleek body." },
  { id: "p8", name: "Halo SE Smartphone", category: "Phones", price: 449.0, rating: 4.2, color: "#8f2a49", blurb: "Great value with the features you actually use." },
  { id: "p9", name: "Orbit Buds Pro", category: "Audio", price: 179.99, rating: 4.5, color: "#8a5a12", blurb: "Wireless earbuds with active noise cancellation." },
  { id: "p10", name: "Resonate Soundbar 3.1", category: "Audio", price: 229.99, rating: 4.3, color: "#a3690f", blurb: "Fill the room with theater-quality sound." },
  { id: "p11", name: "Pulsewave Over-Ear Headphones", category: "Audio", price: 149.99, rating: 4.4, color: "#b8790f", blurb: "Comfortable over-ear headphones with deep bass." },
  { id: "p12", name: "Vertex RTX Gaming Desktop", category: "Gaming", price: 1899.0, rating: 4.8, color: "#1f5c3a", blurb: "Ray-traced gaming performance for competitive play." },
  { id: "p13", name: "Wanderer Handheld Console", category: "Gaming", price: 349.0, rating: 4.6, color: "#2a7548", blurb: "Take your library with you, anywhere." },
  { id: "p14", name: "GripPro Wireless Controller", category: "Gaming", price: 59.99, rating: 4.2, color: "#348a56", blurb: "Precision controls with a comfortable grip." },
  { id: "p15", name: "TidyHome Robot Vacuum", category: "Home", price: 299.99, rating: 4.1, color: "#5c4a1f", blurb: "Automatic cleaning that maps your whole home." },
  { id: "p16", name: "ChillZone Mini Fridge", category: "Home", price: 129.99, rating: 3.9, color: "#705a26", blurb: "Compact fridge perfect for dorms and offices." },
];

const CATEGORIES = ["All", "TVs", "Laptops", "Phones", "Audio", "Gaming", "Home"];

function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}
