import React from 'react';

export function DealRail({ hidden = false }) {
  return (
    <section className="deal-rail" id="deal-rail" aria-label="Featured deals" hidden={hidden}>
      <a className="deal-tile deal-tile-dark" href="product.html?id=p1">
        <img src="images_for_mock_up/vantage-tv.png" alt="Vantage 55 inch 4K OLED TV" />
      </a>
      <a className="deal-tile deal-tile-lilac" href="product.html?id=p17">
        <img src="images_for_mock_up/aeropad-air.png" alt="AeroPad Air 11 tablet" />
      </a>
      <a className="deal-tile deal-tile-lilac" href="product.html?id=p9">
        <img src="images_for_mock_up/orbit-buds.png" alt="Orbit Buds Pro wireless earbuds" />
      </a>
      <a className="deal-tile deal-tile-green" href="product.html?id=p15">
        <img src="images_for_mock_up/tidyhome-vacuum.png" alt="TidyHome robot vacuum" />
      </a>
    </section>
  );
}
