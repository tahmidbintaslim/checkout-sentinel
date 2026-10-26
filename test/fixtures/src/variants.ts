/**
 * Product data and theme markup for fixture products with options. The Shopify product
 * copies the parts of Dawn's variant picker and the AJAX product endpoint that
 * checkout-sentinel reads; the WooCommerce product copies the variations form of the default
 * single-product template and the behaviour of add-to-cart-variation.js as of WooCommerce 9.8
 * (written here, not copied: WooCommerce is GPL and this repository is MIT).
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

/** Options and variants a test chooses, for a product with handle `demo-tee`. */
export interface ShopifyFixtureVariants {
  options: string[];
  variants: ReadonlyArray<{ id: number; values: string[]; available: boolean }>;
}

export function shopifyCustomProduct(spec: ShopifyFixtureVariants): ShopifyFixtureProduct {
  return {
    id: 7002,
    title: 'Demo Tee',
    handle: 'demo-tee',
    options: spec.options,
    variants: spec.variants.map((v) => shopifyVariant(v.id, v.values, v.available)),
  };
}

/**
 * The product a header mega menu features, with a quick-add form and product JSON that come
 * before the main product's in the page. The menu is closed, so its button is not visible.
 */
export function shopifyFeaturedProduct(): ShopifyFixtureProduct {
  return {
    id: 7100,
    title: 'Demo Cap',
    handle: 'demo-cap',
    options: ['Color'],
    variants: [shopifyVariant(5101, ['Black'], true), shopifyVariant(5102, ['White'], true)],
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

export type ShopifyPickerStyle = 'theme' | 'custom' | 'unsynced';

export type ShopifyQuantityPicker = 'number' | 'radios';

export interface ShopifyMarkupOptions {
  pickers: ShopifyPickerStyle;
  quantity: ShopifyQuantityPicker;
  /** The variant in the URL's `?variant=`, which the theme renders as selected. */
  selectedId?: number;
}

function quantityField(quantity: ShopifyQuantityPicker): string {
  if (quantity === 'number') return '<input type="number" name="quantity" value="1" min="1">';
  // Quantity-break apps draw the quantity as radios that share numeric values with options.
  return `<fieldset class="quantity-breaks">
    <legend>Bundle and save</legend>
    <label><input type="radio" name="quantity" value="1" checked> Buy 1</label>
    <label><input type="radio" name="quantity" value="2"> Buy 2, save 10%</label>
    <label><input type="radio" name="quantity" value="3"> Buy 3, save 15%</label>
  </fieldset>`;
}

/**
 * A closed mega menu in the header featuring another product: a quick-add form and its product
 * JSON, both before the main product's, as Dawn's featured product cards render them.
 */
function megaMenu(): string {
  const featured = shopifyFeaturedProduct();
  return `<header>
<details class="mega-menu">
  <summary>Shop</summary>
  <div class="mega-menu__content">
    <a href="/products/${featured.handle}">${featured.title}</a>
    <form method="post" action="/cart/add" id="quick-add-${featured.handle}" class="form">
      <input type="hidden" name="id" value="${featured.variants[0]?.id ?? ''}">
      <input type="hidden" name="quantity" value="1">
      <button type="submit" name="add">Add to cart</button>
    </form>
    <script type="application/json" id="ProductJson-${featured.handle}">${jsonScript(featured)}</script>
  </div>
</details>
</header>`;
}

/**
 * The product form and its variant picker. `theme` follows Dawn: the first option is a select
 * with no default and the others are sets of visually hidden radios behind their labels, all
 * outside the form; theme JS keeps the form's hidden `id` in step and disables the button until
 * the chosen variant is available. A `?variant=` in the URL renders that variant as selected.
 * `unsynced` is the same markup with no theme script, as when the script failed to load: the
 * inputs change, the form's `id` does not, and the button stays enabled. `custom` draws the
 * options as plain elements a theme script listens to, and leaves the button enabled. With
 * `unsynced` and `custom` the server is the one that refuses a sold out variant.
 */
export function shopifyOptionsMarkup(
  product: ShopifyFixtureProduct,
  options: ShopifyMarkupOptions,
): { head: string; body: string } {
  const { pickers } = options;
  const selected = product.variants.find((variant) => variant.id === options.selectedId);
  const formVariant = selected ?? product.variants[0];
  const values = (index: number) => [
    ...new Set(product.variants.map((variant) => variant.options[index] ?? '')),
  ];
  const head = `<style>${VISUALLY_HIDDEN}
.swatch { display: inline-block; padding: 8px 16px; border: 1px solid #333; border-radius: 20px; cursor: pointer; }
input[type="radio"]:checked + label.swatch, .swatch.is-selected { background: #333; color: #fff; }</style>`;

  const firstName = product.options[0] ?? 'Option';
  const themePicker = `<variant-selects class="product__variants">
  <div class="product-form__input product-form__input--dropdown">
    <label class="form__label" for="Option-main-0">${firstName}</label>
    <select id="Option-main-0" name="options[${escapeAttribute(firstName)}]" form="product-form">
      <option value="" disabled${selected ? '' : ' selected'}>Choose a ${firstName.toLowerCase()}</option>
      ${values(0)
        .map(
          (v) =>
            `<option value="${escapeAttribute(v)}"${selected?.options[0] === v ? ' selected' : ''}>${v}</option>`,
        )
        .join('\n      ')}
    </select>
  </div>
  ${product.options
    .slice(1)
    .map((name, offset) => {
      const index = offset + 1;
      return `<fieldset class="product-form__input product-form__input--pill">
    <legend class="form__label">${name}</legend>
    ${values(index)
      .map((v, i) => {
        const checked = selected ? selected.options[index] === v : i === 0;
        return `<input type="radio" id="main-${index}-${i}" name="${escapeAttribute(name)}-${index}" value="${escapeAttribute(v)}" form="product-form" class="visually-hidden"${checked ? ' checked' : ''}>
    <label class="swatch" for="main-${index}-${i}">${v}</label>`;
      })
      .join('\n    ')}
  </fieldset>`;
    })
    .join('\n  ')}
</variant-selects>`;

  const customPicker = `<div class="custom-options">
  ${product.options
    .map(
      (name, index) => `<div class="custom-option" data-option-index="${index}">
    <span class="custom-option__name">${name}</span>
    ${values(index)
      .map((v, i) => {
        const chosen = selected ? selected.options[index] === v : i === 0;
        return `<span class="swatch${chosen ? ' is-selected' : ''}" data-value="${escapeAttribute(v)}" tabindex="0">${v}</span>`;
      })
      .join('\n    ')}
  </div>`,
    )
    .join('\n  ')}
</div>`;

  let button = '<button type="submit" name="add" class="product-form__submit">Add to cart</button>';
  if (pickers === 'theme' && !selected) {
    button = `<button type="submit" name="add" class="product-form__submit" disabled>Choose a ${firstName.toLowerCase()}</button>`;
  } else if (pickers === 'theme' && !selected?.available) {
    button =
      '<button type="submit" name="add" class="product-form__submit" disabled>Sold out</button>';
  }

  const themeScript = `<script>
(() => {
  const product = JSON.parse(document.getElementById('ProductJson-demo-tee').textContent);
  const form = document.getElementById('product-form');
  const idInput = form.querySelector('input[name="id"]');
  const button = form.querySelector('[name="add"]');
  const first = document.getElementById('Option-main-0');
  const groups = product.options
    .slice(1)
    .map((name, i) => [...document.querySelectorAll('input[name="' + CSS.escape(name + '-' + (i + 1)) + '"]')]);
  const update = () => {
    const chosen = [first.value, ...groups.map((radios) => radios.find((radio) => radio.checked)?.value)];
    if (chosen.some((value) => !value)) {
      button.disabled = true;
      button.textContent = 'Choose a ' + product.options[0].toLowerCase();
      return;
    }
    const variant = product.variants.find((v) => v.options.every((value, i) => value === chosen[i]));
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
  first.addEventListener('change', update);
  for (const radio of groups.flat()) radio.addEventListener('change', update);
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

  const scripts: Record<ShopifyPickerStyle, string> = {
    theme: themeScript,
    unsynced: '',
    custom: customScript,
  };
  const body = `${megaMenu()}
<main>
<h1>Demo Tee</h1>
<p>$25.00</p>
${pickers === 'custom' ? customPicker : themePicker}
<form method="post" action="/cart/add" id="product-form" class="form">
  <input type="hidden" name="id" value="${formVariant?.id ?? ''}">
  ${quantityField(options.quantity)}
  ${button}
</form>
</main>
<script type="application/json" id="ProductJson-demo-tee">${jsonScript(product)}</script>
${scripts[pickers]}`;
  return { head, body };
}

/**
 * The page of a product with a single variant ("Default Title"): no picker, and the button is
 * disabled with "Sold out" when that variant is.
 */
export function shopifySingleVariantMarkup(
  product: ShopifyFixtureProduct,
  quantity: ShopifyQuantityPicker,
  button: string,
): string {
  const variant = product.variants[0];
  const control = variant?.available
    ? button
    : '<button type="submit" name="add" class="product-form__submit" disabled>Sold out</button>';
  return `<main>
<h1>Demo Tee</h1>
<p>$25.00</p>
<form method="post" action="/cart/add" id="product-form" class="form">
  <input type="hidden" name="id" value="${variant?.id ?? ''}">
  ${quantityField(quantity)}
  ${control}
</form>
</main>`;
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
 * in any colour (an empty attribute value means "any" to WooCommerce). `inStock` lists the
 * variation ids in stock instead.
 */
export function wooVariations(
  allSoldOut: boolean,
  inStock?: readonly number[],
): WooFixtureVariation[] {
  const stocked = (id: number) => (inStock ? inStock.includes(id) : !allSoldOut && id !== 101);
  return [
    wooVariation(101, 'small', 'blue', stocked(101)),
    wooVariation(102, 'small', 'grey', stocked(102)),
    wooVariation(103, 'medium', '', stocked(103)),
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

/** Where the fixture serves jQuery, as WordPress does. */
export const JQUERY_PATH = '/wp-includes/js/jquery/jquery.min.js';

/**
 * `woocommerce`: a jQuery stand-in for add-to-cart-variation.js that announces each variation
 * with the `show_variation` and `hide_variation` events and registers
 * `jQuery.fn.wc_variation_form`, as WooCommerce does. `theme`: a theme's own script without
 * jQuery and without those events.
 */
export type WooVariationScript = 'woocommerce' | 'theme';

export interface WooFormOptions {
  /** `data-product_variations` is "false" and the script asks the store for each combination. */
  ajax: boolean;
  script: WooVariationScript;
  /** Attribute values the form preselects, as a product's default attributes do. */
  defaults: Readonly<Record<string, string>>;
  /** Draw the attributes as radio buttons (always with the `theme` script). */
  attributeInputs: 'select' | 'radio';
  /** A plugin keeps the add-to-cart button disabled after each variation is shown. */
  locked: boolean;
}

/**
 * The variations form. With `ajax`, `data-product_variations` is "false" and the script asks
 * the store for each combination (`?wc-ajax=get_variation`), as WooCommerce does for products
 * with more variations than its AJAX threshold.
 *
 * Both scripts behave like WooCommerce 9.8 and later: a change clears `variation_id`, a match
 * sets it at once, and the button is updated 300 ms later (WooCommerce waits so that screen
 * readers pick up the change). Until then the button still shows the previous variation.
 */
export function wooVariationsForm(
  productPath: string,
  variations: readonly WooFixtureVariation[],
  options: WooFormOptions,
): string {
  const script: WooVariationScript = options.attributeInputs === 'radio' ? 'theme' : options.script;
  const data = options.ajax ? 'false' : escapeAttribute(JSON.stringify(variations));
  const rows = WOO_ATTRIBUTES.map((attribute) => {
    const id = attribute.name.replace(/^attribute_/, '');
    const preset = options.defaults[attribute.name] ?? '';
    if (options.attributeInputs === 'radio') {
      return `<tr>
      <th class="label">${attribute.label}</th>
      <td class="value">
        ${attribute.options.map((o) => `<label><input type="radio" name="${attribute.name}" value="${o.value}"${preset === o.value ? ' checked' : ''}> ${o.label}</label>`).join('\n        ')}
      </td>
    </tr>`;
    }
    return `<tr>
      <th class="label"><label for="${id}">${attribute.label}</label></th>
      <td class="value">
        <select id="${id}" name="${attribute.name}" data-attribute_name="${attribute.name}" data-show_option_none="yes">
          <option value="">Choose an option</option>
          ${attribute.options.map((o) => `<option value="${o.value}" class="attached enabled"${preset === o.value ? ' selected="selected"' : ''}>${o.label}</option>`).join('\n          ')}
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
${script === 'woocommerce' ? `<script src="${JQUERY_PATH}"></script>` : ''}
<script>
(() => {
  const $ = ${script === 'woocommerce' ? 'window.jQuery' : 'undefined'};
  const LOCKED = ${String(options.locked)};
  const init = (form) => {
    const raw = form.getAttribute('data-product_variations');
    const variations = raw === 'false' ? null : JSON.parse(raw);
    const names = [...new Set([...form.querySelectorAll('.variations [name^="attribute_"]')].map((field) => field.name))];
    const idInput = form.querySelector('input.variation_id');
    const button = form.querySelector('.single_add_to_cart_button');
    const info = form.querySelector('.single_variation');
    const wrap = form.querySelector('.variations_button');
    let loading = true;
    let pending = null;
    const chosen = () =>
      Object.fromEntries(
        names.map((name) => {
          const select = form.querySelector('select[name="' + name + '"]');
          const value = select ? select.value : form.querySelector('input[name="' + name + '"]:checked')?.value;
          return [name, value ?? ''];
        }),
      );
    const onHide = () => {
      button.classList.remove('wc-variation-is-unavailable');
      button.classList.add('disabled', 'wc-variation-selection-needed');
      wrap.classList.add('woocommerce-variation-add-to-cart-disabled');
    };
    const onShow = (variation, purchasable) => {
      if (purchasable) {
        button.classList.remove('disabled', 'wc-variation-selection-needed', 'wc-variation-is-unavailable');
        wrap.classList.remove('woocommerce-variation-add-to-cart-disabled');
      } else {
        button.classList.remove('wc-variation-selection-needed');
        button.classList.add('disabled', 'wc-variation-is-unavailable');
        wrap.classList.add('woocommerce-variation-add-to-cart-disabled');
      }
    };
    const handlers = { show_variation: [onShow], hide_variation: [onHide] };
    if (LOCKED) handlers.show_variation.push(() => button.classList.add('disabled'));
    if ($) {
      for (const [type, list] of Object.entries(handlers)) {
        for (const handler of list) $(form).on(type, (event, ...args) => handler(...args));
      }
    }
    // WooCommerce triggers these on .single_variation and they bubble to the form.
    const emit = (type, args) => {
      if ($) $(info).trigger(type, args);
      else for (const handler of handlers[type]) handler(...args);
    };
    const found = (variation) => {
      idInput.value = String(variation.variation_id);
      const purchasable = variation.is_in_stock && variation.is_purchasable && variation.variation_is_visible;
      setTimeout(() => {
        info.innerHTML = variation.availability_html;
        emit('show_variation', [variation, purchasable]);
      }, 300);
    };
    const reset = () => {
      info.innerHTML = '';
      emit('hide_variation', []);
    };
    const noMatch = () => {
      reset();
      if (!loading) {
        info.insertAdjacentHTML('afterend', '<div role="alert"><p class="wc-no-matching-variations woocommerce-info">Sorry, no products matched your selection. Please choose a different combination.</p></div>');
      }
    };
    const check = () => {
      const attributes = chosen();
      if (Object.values(attributes).some((value) => !value)) {
        reset();
        return;
      }
      if (variations === null) {
        // WooCommerce aborts the previous lookup, so only the latest combination resolves.
        pending?.abort();
        const controller = new AbortController();
        pending = controller;
        fetch('/?wc-ajax=get_variation', {
          method: 'POST',
          body: new URLSearchParams({ ...attributes, product_id: '42' }),
          signal: controller.signal,
        })
          .then((response) => response.json())
          .then((variation) => (variation ? found(variation) : noMatch()))
          .catch(() => undefined);
        return;
      }
      const variation = variations.find((v) =>
        Object.entries(v.attributes).every(([name, value]) => value === '' || attributes[name] === value),
      );
      if (variation) found(variation);
      else noMatch();
    };
    const onChange = () => {
      idInput.value = '';
      form.querySelector('.wc-no-matching-variations')?.parentElement.remove();
      check();
    };
    if ($) $(form).on('change', '.variations select, .variations input', onChange);
    else form.addEventListener('change', (event) => event.target.closest('.variations') && onChange());
    button.addEventListener('click', (event) => {
      if (!button.classList.contains('disabled')) return;
      event.preventDefault();
      window.alert(
        button.classList.contains('wc-variation-is-unavailable')
          ? 'Sorry, this product is unavailable. Please choose a different combination.'
          : 'Please select some product options before adding this product to your cart.',
      );
    });
    // Like WooCommerce, resolve the preselected attributes once the page has settled.
    setTimeout(() => {
      check();
      loading = false;
    }, 100);
  };
  if ($) {
    $.fn.wc_variation_form = function () {
      return this.each(function () {
        init(this);
      });
    };
    $(() => $('.variations_form').wc_variation_form());
  } else {
    init(document.querySelector('form.variations_form'));
  }
})();
</script>`;
}
