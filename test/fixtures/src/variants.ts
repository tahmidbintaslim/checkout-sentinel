/**
 * Product data and theme markup for fixture products with options. The Shopify product
 * copies the parts of Dawn's variant picker and the AJAX product endpoint that
 * checkout-sentinel reads; the WooCommerce product copies the variations form of the default
 * single-product template and the behaviour of wc-add-to-cart-variation.js.
 */

export interface ShopifyFixtureVariant {
  id: number;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  options: string[];
  available: boolean;
}

export interface ShopifyFixtureProduct {
  id: number;
  title: string;
  handle: string;
  /** Option names, in the shape Liquid's `product | json` emits. */
  options: string[];
  variants: ShopifyFixtureVariant[];
}

function shopifyVariant(id: number, values: string[], available: boolean): ShopifyFixtureVariant {
  return {
    id,
    title: values.join(' / '),
    option1: values[0] ?? null,
    option2: values[1] ?? null,
    option3: values[2] ?? null,
    options: values,
    available,
  };
}

/** The single "Default Title" variant every Shopify product without options has. */
export function shopifySingleVariantProduct(): ShopifyFixtureProduct {
  return {
    id: 7000,
    title: 'Demo Tee',
    handle: 'demo-tee',
    options: ['Title'],
    variants: [shopifyVariant(4242, ['Default Title'], true)],
  };
}

/**
 * Size and colour. The variant the theme selects first (S / Black) is sold out, so is
 * M / White; the first available variant is S / White.
 */
export function shopifyOptionsProduct(allSoldOut: boolean): ShopifyFixtureProduct {
  return {
    id: 7001,
    title: 'Demo Tee',
    handle: 'demo-tee',
    options: ['Size', 'Color'],
    variants: [
      shopifyVariant(4301, ['S', 'Black'], false),
      shopifyVariant(4302, ['S', 'White'], !allSoldOut),
      shopifyVariant(4303, ['M', 'Black'], !allSoldOut),
      shopifyVariant(4304, ['M', 'White'], false),
    ],
  };
}

/** The `/products/<handle>.js` body: option objects with values, as the AJAX API returns them. */
export function shopifyProductJs(product: ShopifyFixtureProduct): Record<string, unknown> {
  return {
    ...product,
    options: product.options.map((name, index) => ({
      name,
      position: index + 1,
      values: [...new Set(product.variants.map((variant) => variant.options[index] ?? ''))],
    })),
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const VISUALLY_HIDDEN =
  '.visually-hidden { position: absolute !important; overflow: hidden; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; clip: rect(0 0 0 0); }';

export type ShopifyPickerStyle = 'theme' | 'custom';

/**
 * The product form and its variant picker. `theme` follows Dawn: the size is a select with no
 * default and the colour is a set of visually hidden radios behind their labels, both outside
 * the form; theme JS keeps the form's hidden `id` in step and disables the button until the
 * chosen variant is available. `custom` draws the options as plain elements a theme script
 * listens to, and leaves the button enabled, so the server is the one that refuses a sold out
 * variant.
 */
export function shopifyOptionsMarkup(
  product: ShopifyFixtureProduct,
  pickers: ShopifyPickerStyle,
): { head: string; body: string } {
  const first = product.variants[0];
  const values = (index: number) => [
    ...new Set(product.variants.map((variant) => variant.options[index] ?? '')),
  ];
  const head = `<style>${VISUALLY_HIDDEN}
.swatch { display: inline-block; padding: 8px 16px; border: 1px solid #333; border-radius: 20px; cursor: pointer; }
input[type="radio"]:checked + label.swatch, .swatch.is-selected { background: #333; color: #fff; }</style>`;

  const themePicker = `<variant-selects class="product__variants">
  <div class="product-form__input product-form__input--dropdown">
    <label class="form__label" for="Option-main-0">Size</label>
    <select id="Option-main-0" name="options[Size]" form="product-form">
      <option value="" disabled selected>Choose a size</option>
      ${values(0)
        .map((v) => `<option value="${escapeAttribute(v)}">${v}</option>`)
        .join('\n      ')}
    </select>
  </div>
  <fieldset class="product-form__input product-form__input--pill">
    <legend class="form__label">Color</legend>
    ${values(1)
      .map(
        (v, i) =>
          `<input type="radio" id="main-1-${i}" name="Color-1" value="${escapeAttribute(v)}" form="product-form" class="visually-hidden"${i === 0 ? ' checked' : ''}>
    <label class="swatch" for="main-1-${i}">${v}</label>`,
      )
      .join('\n    ')}
  </fieldset>
</variant-selects>`;

  const customPicker = `<div class="custom-options">
  ${product.options
    .map(
      (name, index) => `<div class="custom-option" data-option-index="${index}">
    <span class="custom-option__name">${name}</span>
    ${values(index)
      .map(
        (v, i) =>
          `<span class="swatch${i === 0 ? ' is-selected' : ''}" data-value="${escapeAttribute(v)}" tabindex="0">${v}</span>`,
      )
      .join('\n    ')}
  </div>`,
    )
    .join('\n  ')}
</div>`;

  const button =
    pickers === 'theme'
      ? '<button type="submit" name="add" class="product-form__submit" disabled>Choose a size</button>'
      : '<button type="submit" name="add" class="product-form__submit">Add to cart</button>';

  const themeScript = `<script>
(() => {
  const product = JSON.parse(document.getElementById('ProductJson-demo-tee').textContent);
  const form = document.getElementById('product-form');
  const idInput = form.querySelector('input[name="id"]');
  const button = form.querySelector('[name="add"]');
  const size = document.getElementById('Option-main-0');
  const colors = [...document.querySelectorAll('input[name="Color-1"]')];
  const update = () => {
    const color = colors.find((radio) => radio.checked);
    if (!size.value || !color) {
      button.disabled = true;
      button.textContent = 'Choose a size';
      return;
    }
    const variant = product.variants.find((v) => v.options[0] === size.value && v.options[1] === color.value);
    if (!variant) {
      button.disabled = true;
      button.textContent = 'Unavailable';
      return;
    }
    idInput.value = String(variant.id);
    history.replaceState(null, '', location.pathname + '?variant=' + variant.id);
    button.disabled = !variant.available;
    button.textContent = variant.available ? 'Add to cart' : 'Sold out';
  };
  size.addEventListener('change', update);
  for (const radio of colors) radio.addEventListener('change', update);
})();
</script>`;

  const customScript = `<script>
(() => {
  const product = JSON.parse(document.getElementById('ProductJson-demo-tee').textContent);
  const idInput = document.querySelector('#product-form input[name="id"]');
  for (const group of document.querySelectorAll('.custom-option')) {
    group.addEventListener('click', (event) => {
      const swatch = event.target.closest('.swatch');
      if (!swatch) return;
      for (const other of group.querySelectorAll('.swatch')) other.classList.remove('is-selected');
      swatch.classList.add('is-selected');
      const chosen = [...document.querySelectorAll('.custom-option')].map(
        (g) => g.querySelector('.swatch.is-selected')?.dataset.value,
      );
      const variant = product.variants.find((v) => v.options.every((value, i) => value === chosen[i]));
      if (variant) idInput.value = String(variant.id);
    });
  }
})();
</script>`;

  const body = `<main>
<h1>Demo Tee</h1>
<p>$25.00</p>
${pickers === 'theme' ? themePicker : customPicker}
<form method="post" action="/cart/add" id="product-form" class="form">
  <input type="hidden" name="id" value="${first?.id ?? ''}">
  <input type="number" name="quantity" value="1" min="1">
  ${button}
</form>
</main>
<script type="application/json" id="ProductJson-demo-tee">${jsonScript(product)}</script>
${pickers === 'theme' ? themeScript : customScript}`;
  return { head, body };
}

export interface WooFixtureVariation {
  variation_id: number;
  attributes: Record<string, string>;
  is_in_stock: boolean;
  is_purchasable: boolean;
  variation_is_active: boolean;
  variation_is_visible: boolean;
  display_price: number;
  availability_html: string;
}

export const WOO_ATTRIBUTES: ReadonlyArray<{
  name: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}> = [
  {
    name: 'attribute_pa_size',
    label: 'Size',
    options: [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
    ],
  },
  {
    name: 'attribute_pa_color',
    label: 'Color',
    options: [
      { value: 'blue', label: 'Blue' },
      { value: 'grey', label: 'Grey' },
    ],
  },
];

function wooVariation(
  id: number,
  size: string,
  color: string,
  inStock: boolean,
): WooFixtureVariation {
  return {
    variation_id: id,
    attributes: { attribute_pa_size: size, attribute_pa_color: color },
    is_in_stock: inStock,
    is_purchasable: true,
    variation_is_active: true,
    variation_is_visible: true,
    display_price: 45,
    availability_html: inStock
      ? '<p class="stock in-stock">In stock</p>'
      : '<p class="stock out-of-stock">Out of stock</p>',
  };
}

/**
 * Small / Blue is out of stock, Small / Grey is the first variation in stock, and Medium comes
 * in any colour (an empty attribute value means "any" to WooCommerce).
 */
export function wooVariations(allSoldOut: boolean): WooFixtureVariation[] {
  return [
    wooVariation(101, 'small', 'blue', false),
    wooVariation(102, 'small', 'grey', !allSoldOut),
    wooVariation(103, 'medium', '', !allSoldOut),
  ];
}

/** The variation matching the chosen attributes, the way WooCommerce matches them. */
export function matchWooVariation(
  variations: readonly WooFixtureVariation[],
  chosen: Record<string, unknown>,
): WooFixtureVariation | undefined {
  return variations.find((variation) =>
    Object.entries(variation.attributes).every(
      ([name, value]) => value === '' || chosen[name] === value,
    ),
  );
}

/**
 * The variations form. With `ajax`, `data-product_variations` is "false" and the script asks
 * the store for each combination (`?wc-ajax=get_variation`), as WooCommerce does for products
 * with more variations than its AJAX threshold.
 */
export function wooVariationsForm(
  productPath: string,
  variations: readonly WooFixtureVariation[],
  ajax: boolean,
): string {
  const data = ajax ? 'false' : escapeAttribute(JSON.stringify(variations));
  const rows = WOO_ATTRIBUTES.map((attribute) => {
    const id = attribute.name.replace(/^attribute_/, '');
    return `<tr>
      <th class="label"><label for="${id}">${attribute.label}</label></th>
      <td class="value">
        <select id="${id}" name="${attribute.name}" data-attribute_name="${attribute.name}" data-show_option_none="yes">
          <option value="">Choose an option</option>
          ${attribute.options.map((o) => `<option value="${o.value}" class="attached enabled">${o.label}</option>`).join('\n          ')}
        </select>
      </td>
    </tr>`;
  }).join('\n    ');

  return `<form class="variations_form cart" action="${productPath}" method="post" enctype="application/x-www-form-urlencoded" data-product_id="42" data-product_variations="${data}">
  <table class="variations" cellspacing="0" role="presentation"><tbody>
    ${rows}
  </tbody></table>
  <a class="reset_variations" href="#">Clear</a>
  <div class="single_variation_wrap">
    <div class="woocommerce-variation single_variation"></div>
    <div class="woocommerce-variation-add-to-cart variations_button woocommerce-variation-add-to-cart-disabled">
      <div class="quantity"><input type="number" name="quantity" value="1" min="1"></div>
      <button type="submit" class="single_add_to_cart_button button alt disabled wc-variation-selection-needed">Add to cart</button>
      <input type="hidden" name="add-to-cart" value="42">
      <input type="hidden" name="product_id" value="42">
      <input type="hidden" name="variation_id" class="variation_id" value="0">
    </div>
  </div>
</form>
<script>
(() => {
  const form = document.querySelector('form.variations_form');
  const raw = form.getAttribute('data-product_variations');
  const variations = raw === 'false' ? null : JSON.parse(raw);
  const selects = [...form.querySelectorAll('select[name^="attribute_"]')];
  const idInput = form.querySelector('input.variation_id');
  const button = form.querySelector('.single_add_to_cart_button');
  const info = form.querySelector('.single_variation');
  const wrap = form.querySelector('.variations_button');
  const disable = (reason) => {
    button.classList.add('disabled', reason);
    button.classList.remove(reason === 'wc-variation-is-unavailable' ? 'wc-variation-selection-needed' : 'wc-variation-is-unavailable');
    wrap.classList.add('woocommerce-variation-add-to-cart-disabled');
  };
  const found = (variation) => {
    idInput.value = String(variation.variation_id);
    info.innerHTML = variation.availability_html;
    if (variation.is_in_stock && variation.is_purchasable && variation.variation_is_visible) {
      button.classList.remove('disabled', 'wc-variation-selection-needed', 'wc-variation-is-unavailable');
      wrap.classList.remove('woocommerce-variation-add-to-cart-disabled');
    } else {
      disable('wc-variation-is-unavailable');
    }
  };
  const noMatch = () => {
    disable('wc-variation-is-unavailable');
    info.insertAdjacentHTML('afterend', '<p class="wc-no-matching-variations woocommerce-info">Sorry, no products matched your selection. Please choose a different combination.</p>');
  };
  let pending = null;
  const onChange = () => {
    pending?.abort();
    pending = null;
    idInput.value = '';
    info.innerHTML = '';
    form.querySelector('.wc-no-matching-variations')?.remove();
    if (selects.some((select) => !select.value)) {
      disable('wc-variation-selection-needed');
      return;
    }
    const chosen = Object.fromEntries(selects.map((select) => [select.name, select.value]));
    if (variations === null) {
      const body = new URLSearchParams({ ...chosen, product_id: '42' });
      // WooCommerce aborts the previous lookup, so only the latest combination resolves.
      const controller = new AbortController();
      pending = controller;
      fetch('/?wc-ajax=get_variation', { method: 'POST', body, signal: controller.signal })
        .then((response) => response.json())
        .then((variation) => (variation ? found(variation) : noMatch()))
        .catch(() => undefined);
      return;
    }
    const variation = variations.find((v) =>
      Object.entries(v.attributes).every(([name, value]) => value === '' || chosen[name] === value),
    );
    if (variation) found(variation);
    else noMatch();
  };
  for (const select of selects) select.addEventListener('change', onChange);
  button.addEventListener('click', (event) => {
    if (!button.classList.contains('disabled')) return;
    event.preventDefault();
    window.alert(
      button.classList.contains('wc-variation-is-unavailable')
        ? 'Sorry, this product is unavailable. Please choose a different combination.'
        : 'Please select some product options before adding this product to your cart.',
    );
  });
})();
</script>`;
}
