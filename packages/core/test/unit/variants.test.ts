import { describe, expect, it } from 'vitest';
import {
  MAX_OPTION_COMBINATIONS,
  chooseShopifyVariant,
  chooseWooVariation,
  isWooVariationAvailable,
  optionCombinations,
  parseShopifyProduct,
  parseWooVariations,
  shopifyProductJsPath,
  shopifyVariantOptions,
  shopifyVariantTitle,
  soldOutMessage,
} from '@checkout-sentinel/core';

describe('shopifyProductJsPath', () => {
  it.each([
    ['https://s.test/products/demo-tee', '/products/demo-tee.js'],
    ['https://s.test/products/demo-tee/', '/products/demo-tee.js'],
    ['https://s.test/products/demo-tee?variant=4302', '/products/demo-tee.js'],
    ['https://s.test/collections/summer/products/demo-tee', '/products/demo-tee.js'],
    // The locale prefix stays, so option values come back in the page's language.
    ['https://s.test/fr/products/t-shirt', '/fr/products/t-shirt.js'],
    ['https://s.test/en-th/collections/new/products/t-shirt', '/en-th/products/t-shirt.js'],
    ['https://s.test/products/demo-tee.js', null],
    ['https://s.test/product/demo-hoodie/', null],
    ['https://s.test/', null],
    ['not a url', null],
  ])('%s -> %s', (url, expected) => {
    expect(shopifyProductJsPath(url)).toBe(expected);
  });
});

const variant = (id: number, options: string[], available: boolean) => ({
  id,
  title: options.join(' / '),
  options,
  available,
});

describe('parseShopifyProduct', () => {
  it('reads the AJAX API shape, with option objects', () => {
    const product = parseShopifyProduct({
      title: 'Tee',
      options: [{ name: 'Size', position: 1, values: ['S', 'M'] }],
      variants: [variant(1, ['S'], false), variant(2, ['M'], true)],
    });
    expect(product?.optionNames).toEqual(['Size']);
    expect(product?.variants.map((v) => [v.id, v.available])).toEqual([
      ['1', false],
      ['2', true],
    ]);
  });

  it('reads the Liquid shape, with option names as strings and option1..3', () => {
    const product = parseShopifyProduct({
      options: ['Size', 'Color'],
      variants: [
        { id: 7, title: 'S / Red', option1: 'S', option2: 'Red', option3: null, available: true },
      ],
    });
    expect(product?.optionNames).toEqual(['Size', 'Color']);
    const first = product?.variants[0];
    expect(first && shopifyVariantOptions(first)).toEqual(['S', 'Red']);
  });

  it('reads a bare variants array, as some themes embed it', () => {
    const product = parseShopifyProduct([variant(1, ['S'], true)]);
    expect(product?.optionNames).toEqual([]);
    expect(product?.variants).toHaveLength(1);
  });

  it.each([
    ['null', null],
    ['a string', 'product'],
    ['no variants', { title: 'Tee' }],
    ['empty variants', { variants: [] }],
    ['variants without availability', { variants: [{ id: 1, title: 'Default Title' }] }],
  ])('rejects %s', (_label, input) => {
    expect(parseShopifyProduct(input)).toBeNull();
  });
});

describe('chooseShopifyVariant', () => {
  const product = parseShopifyProduct({
    options: ['Size'],
    variants: [
      variant(1, ['S'], false),
      variant(2, ['M'], true),
      variant(3, ['L'], true),
      variant(4, ['XL'], false),
    ],
  });
  if (!product) throw new Error('fixture product did not parse');

  it('chooses the first available variant', () => {
    expect(chooseShopifyVariant(product, null)?.id).toBe('2');
  });

  it('keeps the variant named in the URL when it is available', () => {
    expect(chooseShopifyVariant(product, '3')?.id).toBe('3');
  });

  it('ignores a variant in the URL that is sold out or unknown', () => {
    expect(chooseShopifyVariant(product, '4')?.id).toBe('2');
    expect(chooseShopifyVariant(product, '99')?.id).toBe('2');
  });

  it('returns null when every variant is sold out', () => {
    const soldOut = parseShopifyProduct({ variants: [variant(1, ['S'], false)] });
    expect(soldOut && chooseShopifyVariant(soldOut, null)).toBeNull();
  });
});

describe('shopifyVariantTitle', () => {
  it('uses the title, then the option values', () => {
    const product = parseShopifyProduct({
      variants: [
        { id: 1, title: 'S / Red', available: true },
        { id: 2, options: ['M', 'Blue'], available: true },
        { id: 3, available: true },
      ],
    });
    expect(product?.variants.map(shopifyVariantTitle)).toEqual(['S / Red', 'M / Blue', '3']);
  });
});

describe('soldOutMessage', () => {
  it('counts the variants', () => {
    expect(soldOutMessage(4, 'variants', 'sold out')).toBe(
      'No available variant: all 4 variants are sold out',
    );
    expect(soldOutMessage(1, 'variants', 'sold out')).toBe(
      'No available variant: the only variant is sold out',
    );
    expect(soldOutMessage(3, 'variations', 'out of stock')).toBe(
      'No available variant: all 3 variations are out of stock',
    );
  });
});

const wooVariation = (id: number, attributes: Record<string, string>, extra = {}) => ({
  variation_id: id,
  attributes,
  is_in_stock: true,
  is_purchasable: true,
  variation_is_active: true,
  variation_is_visible: true,
  ...extra,
});

describe('parseWooVariations', () => {
  it('parses the data-product_variations attribute', () => {
    const raw = JSON.stringify([wooVariation(101, { attribute_pa_size: 'small' })]);
    const parsed = parseWooVariations(raw);
    expect(parsed).not.toBe('ajax');
    expect(parsed && parsed !== 'ajax' ? parsed[0]?.id : null).toBe('101');
  });

  it('reports "false" as variations that load over AJAX', () => {
    expect(parseWooVariations('false')).toBe('ajax');
  });

  it.each([null, '', 'not json', '{"variation_id":1}', '[{"attributes":{}}]'])(
    'returns null for %j',
    (raw) => {
      expect(parseWooVariations(raw)).toBeNull();
    },
  );
});

describe('isWooVariationAvailable and chooseWooVariation', () => {
  const parse = (items: unknown[]) => {
    const parsed = parseWooVariations(JSON.stringify(items));
    if (parsed === null || parsed === 'ajax') throw new Error('did not parse');
    return parsed;
  };

  it.each([
    ['in stock', {}, true],
    ['out of stock', { is_in_stock: false }, false],
    ['not purchasable', { is_purchasable: false }, false],
    ['inactive', { variation_is_active: false }, false],
    ['hidden', { variation_is_visible: false }, false],
  ])('%s -> %s', (_label, extra, expected) => {
    const [only] = parse([wooVariation(1, {}, extra)]);
    expect(only && isWooVariationAvailable(only)).toBe(expected);
  });

  it('treats missing flags as available, as WooCommerce does', () => {
    const [only] = parse([{ variation_id: 5, attributes: { attribute_pa_size: 'small' } }]);
    expect(only && isWooVariationAvailable(only)).toBe(true);
  });

  it('chooses the first variation in stock, or null', () => {
    const variations = parse([
      wooVariation(1, {}, { is_in_stock: false }),
      wooVariation(2, {}),
      wooVariation(3, {}),
    ]);
    expect(chooseWooVariation(variations)?.id).toBe('2');
    expect(chooseWooVariation(parse([wooVariation(1, {}, { is_in_stock: false })]))).toBeNull();
  });
});

describe('optionCombinations', () => {
  it('lists combinations in option order, the first option changing slowest', () => {
    expect(
      optionCombinations([
        ['s', 'm'],
        ['blue', 'grey'],
      ]),
    ).toEqual({
      combinations: [
        ['s', 'blue'],
        ['s', 'grey'],
        ['m', 'blue'],
        ['m', 'grey'],
      ],
      total: 4,
    });
  });

  it('stops at the limit and still reports the total', () => {
    const many = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const { combinations, total } = optionCombinations([many, ['a', 'b']]);
    expect(combinations).toHaveLength(MAX_OPTION_COMBINATIONS);
    expect(total).toBe(60);
  });

  it('has no combinations when an option has no values', () => {
    expect(optionCombinations([['s'], []])).toEqual({ combinations: [], total: 0 });
    expect(optionCombinations([])).toEqual({ combinations: [], total: 0 });
  });
});
