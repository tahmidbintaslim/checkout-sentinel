import type { APIRequestContext, Page } from 'playwright';
import { z } from 'zod';
import type { Platform, StepResult } from './schema.js';

/**
 * Variant selection runs before the add-to-cart control is looked for. A product whose
 * default variant is sold out, or whose theme wants an option chosen first, keeps its button
 * disabled; a shopper picks an option, so the journey does too. It picks the first available
 * variant, or the one named by `?variant=` in a Shopify URL when that one is available, through
 * the same option inputs a shopper uses, and never touches the quantity.
 */

type Details = StepResult['details'];

export type VariantSelection =
  /** Nothing to choose: no product data, a single variant, or no variations form. */
  | { outcome: 'none' }
  | { outcome: 'selected'; details: Details }
  /** Every variant is sold out. */
  | { outcome: 'unavailable'; message: string; details: Details }
  /** A variant was chosen but the page never accepted it. */
  | { outcome: 'unresolved'; message: string; details: Details };

export interface VariantSelectionOptions {
  /** Budget for reading product data and applying the choice. */
  timeoutMs: number;
}

/** At most this many option combinations are tried on a WooCommerce form without variation data. */
export const MAX_OPTION_COMBINATIONS = 20;
/** How long one option combination may take to resolve on a WooCommerce form. */
const COMBINATION_WAIT_MS = 2_000;
/** How long the theme may take to move the form's variant id after an option changed. */
const FORM_ID_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
/** Product JSON in the page larger than this is not parsed. */
const MAX_EMBEDDED_JSON_CHARS = 1_000_000;

const OPTION_MARK = 'data-checkout-sentinel-option';
const LABEL_MARK = 'data-checkout-sentinel-option-label';
const FORM_MARK = 'data-checkout-sentinel-form';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

export function soldOutMessage(total: number, noun: 'variants' | 'variations', state: string) {
  if (total === 1) return `No available variant: the only ${noun.slice(0, -1)} is ${state}`;
  return `No available variant: all ${total} ${noun} are ${state}`;
}

// Shopify -------------------------------------------------------------------------------

const IdSchema = z.union([z.number(), z.string().min(1)]).transform(String);
const OptionValueSchema = z.string().nullable().optional();

const ShopifyVariantSchema = z.object({
  id: IdSchema,
  title: z.string().optional(),
  available: z.boolean(),
  options: z.array(z.string()).optional(),
  option1: OptionValueSchema,
  option2: OptionValueSchema,
  option3: OptionValueSchema,
});
export type ShopifyVariant = z.infer<typeof ShopifyVariantSchema>;

/** Accepts the AJAX API shape (option objects) and Liquid's `product | json` (option names). */
const ShopifyProductSchema = z.object({
  handle: z.string().optional(),
  options: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
  variants: z.array(ShopifyVariantSchema).min(1),
});

export interface ShopifyProduct {
  handle?: string;
  optionNames: string[];
  variants: ShopifyVariant[];
}

/** Reads a product object, or a bare variants array as some themes embed it. */
export function parseShopifyProduct(input: unknown): ShopifyProduct | null {
  const parsed = ShopifyProductSchema.safeParse(Array.isArray(input) ? { variants: input } : input);
  if (!parsed.success) return null;
  return {
    ...(parsed.data.handle !== undefined ? { handle: parsed.data.handle } : {}),
    optionNames: (parsed.data.options ?? []).map((option) =>
      typeof option === 'string' ? option : option.name,
    ),
    variants: parsed.data.variants,
  };
}

/**
 * The AJAX product endpoint for a product page URL. A locale prefix is kept so the option
 * values come back in the language the page shows; a collection prefix is dropped.
 */
export function shopifyProductJsPath(pageUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    return null;
  }
  const match = /^(.*?)(?:\/collections\/[^/]+)?\/products\/([^/.]+)\/?$/.exec(pathname);
  if (!match) return null;
  return `${match[1] ?? ''}/products/${match[2] ?? ''}.js`;
}

export function shopifyVariantOptions(variant: ShopifyVariant): string[] {
  if (variant.options) return variant.options;
  return [variant.option1, variant.option2, variant.option3].filter(
    (value): value is string => typeof value === 'string',
  );
}

export function shopifyVariantTitle(variant: ShopifyVariant): string {
  if (variant.title) return variant.title;
  const values = shopifyVariantOptions(variant);
  return values.length > 0 ? values.join(' / ') : variant.id;
}

/** The variant named in the URL when it is available, else the first available one. */
export function chooseShopifyVariant(
  product: ShopifyProduct,
  requestedId: string | null,
): ShopifyVariant | null {
  const requested = product.variants.find((v) => v.id === requestedId && v.available);
  return requested ?? product.variants.find((v) => v.available) ?? null;
}

async function readShopifyProduct(
  page: Page,
  request: APIRequestContext,
  deadline: number,
): Promise<{ product: ShopifyProduct; source: string } | null> {
  const path = shopifyProductJsPath(page.url());
  if (path) {
    try {
      const response = await request.get(new URL(path, page.url()).toString(), {
        headers: { accept: 'application/json' },
        failOnStatusCode: false,
        maxRedirects: 3,
        timeout: remaining(deadline),
      });
      if (response.ok()) {
        const product = parseShopifyProduct(await response.json());
        if (product) return { product, source: path };
      }
    } catch {
      // Unreachable or not JSON; the page may still carry the product.
    }
  }

  const embedded = await page.evaluate(
    ({ maxChars }) => {
      const texts = Array.from(document.querySelectorAll('script[type="application/json"]'))
        .map((script) => script.textContent ?? '')
        .filter((text) => text.length <= maxChars && text.includes('"available"'));
      const formIds = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          'form[action*="/cart/add"] [name="id"]',
        ),
      ).map((field) => field.value);
      return { texts: texts.slice(0, 20), formIds };
    },
    { maxChars: MAX_EMBEDDED_JSON_CHARS },
  );
  const handle = path ? /\/products\/([^/.]+)\.js$/.exec(path)?.[1] : undefined;
  const products: ShopifyProduct[] = [];
  for (const text of embedded.texts) {
    try {
      const product = parseShopifyProduct(JSON.parse(text));
      if (product) products.push(product);
    } catch {
      // Not JSON after all.
    }
  }
  // Pages also embed recommended products; prefer the one this page's form belongs to.
  const product =
    products.find((p) => handle !== undefined && p.handle === handle) ??
    products.find((p) => p.variants.some((v) => embedded.formIds.includes(v.id))) ??
    products[0];
  return product ? { product, source: 'product JSON in the page' } : null;
}

interface OptionSpec {
  name: string | null;
  position: number;
  value: string;
  optionMark: string;
  labelMark: string;
}

interface MarkedControl {
  kind: 'select' | 'radio';
  /** The control already shows this value. */
  current: boolean;
  /** The value to select, as the option element spells it. */
  optionValue: string;
  /** A label for the radio was marked too. */
  labelled: boolean;
}

/**
 * Runs in the page. Finds the select or radio that sets one option to a value, and marks it
 * (and a radio's label) for the locators that act on it. Scores: the control's name is the
 * option's (`options[Size]`, `Size-1`) 3, a label, legend or data attribute names it 2, the
 * option position (`data-index="option1"`) 2, the value alone 1; a visible control wins a tie.
 */
function markOptionControl(spec: OptionSpec): MarkedControl | null {
  for (const element of Array.from(
    document.querySelectorAll(`[${spec.optionMark}], [${spec.labelMark}]`),
  )) {
    element.removeAttribute(spec.optionMark);
    element.removeAttribute(spec.labelMark);
  }
  const norm = (text: string | null | undefined) =>
    (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const value = norm(spec.value);
  const name = spec.name === null ? null : norm(spec.name);
  const shown = (element: Element | null | undefined) =>
    element !== null && element !== undefined && element.getClientRects().length > 0;

  const nameScore = (control: HTMLInputElement | HTMLSelectElement): number => {
    let score = 0;
    if (name !== null) {
      const field = norm(control.getAttribute('name'));
      if (field === name || field === `options[${name}]` || field.startsWith(`${name}-`)) {
        score = 3;
      } else {
        const texts = [
          ...Array.from(control.labels ?? []).map((label) => norm(label.textContent)),
          norm(control.getAttribute('aria-label')),
          norm(control.getAttribute('data-option-name')),
          norm(control.getAttribute('data-name')),
          norm(control.closest('fieldset')?.querySelector('legend')?.textContent),
        ];
        if (texts.some((t) => t === name || t.startsWith(`${name}:`) || t.startsWith(`${name} `))) {
          score = 2;
        }
      }
    }
    if (score === 0 && control.getAttribute('data-index') === `option${spec.position}`) score = 2;
    return Math.max(score, 1);
  };

  type Candidate = { control: HTMLSelectElement | HTMLInputElement; score: number } & MarkedControl;
  const candidates: Candidate[] = [];
  for (const select of Array.from(document.querySelectorAll('select'))) {
    const field = select.getAttribute('name') ?? '';
    if (field === 'id' || field === 'quantity' || select.closest('form[action*="/localization"]')) {
      continue;
    }
    const options = Array.from(select.options);
    const option =
      options.find((o) => norm(o.value) === value) ?? options.find((o) => norm(o.text) === value);
    if (!option || option.disabled) continue;
    candidates.push({
      control: select,
      score: nameScore(select) + (shown(select) ? 0.5 : 0),
      kind: 'select',
      current: select.value === option.value,
      optionValue: option.value,
      labelled: false,
    });
  }
  for (const radio of Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  )) {
    if (norm(radio.value) !== value || radio.disabled) continue;
    const label = radio.labels?.[0];
    candidates.push({
      control: radio,
      score: nameScore(radio) + (shown(radio) || shown(label) ? 0.5 : 0),
      kind: 'radio',
      current: radio.checked,
      optionValue: radio.value,
      labelled: label !== undefined,
    });
  }

  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best) return null;
  best.control.setAttribute(spec.optionMark, '');
  if (best.kind === 'radio') best.control.labels?.[0]?.setAttribute(spec.labelMark, '');
  return {
    kind: best.kind,
    current: best.current,
    optionValue: best.optionValue,
    labelled: best.labelled,
  };
}

/** Sets one option through the theme's own control. */
async function setShopifyOption(
  page: Page,
  spec: Omit<OptionSpec, 'optionMark' | 'labelMark'>,
  deadline: number,
): Promise<'missing' | 'unchanged' | 'changed'> {
  const marked = await page.evaluate(markOptionControl, {
    ...spec,
    optionMark: OPTION_MARK,
    labelMark: LABEL_MARK,
  });
  if (!marked) return 'missing';
  if (marked.current) return 'unchanged';
  const control = page.locator(`[${OPTION_MARK}]`).first();
  try {
    if (marked.kind === 'select') {
      // Swatch apps often hide the select and drive it from their own buttons.
      const visible = await control.isVisible();
      await control.selectOption(marked.optionValue, {
        force: !visible,
        timeout: remaining(deadline),
      });
    } else {
      const label = page.locator(`[${LABEL_MARK}]`).first();
      if (marked.labelled && (await label.isVisible())) {
        await label.click({ timeout: remaining(deadline) });
      }
      if (!(await control.isChecked())) {
        // A hidden radio without a visible label: click it the way its label would.
        await control.evaluate((element) => (element as HTMLInputElement).click());
      }
    }
    return 'changed';
  } catch {
    return 'missing';
  }
}

/**
 * Runs in the page. Marks the product's add form: the first `/cart/add` form whose variant id
 * belongs to this product (pages also carry quick-add forms for other products), else the
 * first one with a variant id. Returns that form's current variant id.
 */
function markProductForm(args: { ids: string[]; formMark: string }): string | null {
  const idField = (form: HTMLFormElement) =>
    form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="id"]') ??
    (form.id
      ? document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `[name="id"][form="${CSS.escape(form.id)}"]`,
        )
      : null);
  const forms = Array.from(
    document.querySelectorAll<HTMLFormElement>('form[action*="/cart/add"]'),
  ).filter((form) => idField(form) !== null);
  const form = forms.find((f) => args.ids.includes(idField(f)?.value ?? '')) ?? forms[0];
  if (!form) return null;
  form.setAttribute(args.formMark, '');
  return idField(form)?.value ?? null;
}

/** Runs in the page: the marked form's variant id, or sets it when `set` is given. */
function productFormId(args: { formMark: string; set?: string }): string | null {
  const form = document.querySelector<HTMLFormElement>(`[${args.formMark}]`);
  if (!form) return null;
  const field =
    form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="id"]') ??
    (form.id
      ? document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `[name="id"][form="${CSS.escape(form.id)}"]`,
        )
      : null);
  if (!field) return null;
  if (args.set !== undefined) {
    if (field instanceof HTMLSelectElement) {
      if (!Array.from(field.options).some((o) => o.value === args.set)) return field.value;
      field.value = args.set;
    } else {
      field.value = args.set;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return field.value;
}

async function waitForFormId(page: Page, id: string, until: number): Promise<boolean> {
  while (true) {
    if ((await page.evaluate(productFormId, { formMark: FORM_MARK })) === id) return true;
    if (Date.now() >= until) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function selectShopifyVariant(
  page: Page,
  request: APIRequestContext,
  deadline: number,
): Promise<VariantSelection> {
  const found = await readShopifyProduct(page, request, deadline);
  if (!found) return { outcome: 'none' };
  const { product, source } = found;
  const counts: Details = {
    variantSource: source,
    availableVariants: product.variants.filter((v) => v.available).length,
    totalVariants: product.variants.length,
  };
  const target = chooseShopifyVariant(product, new URL(page.url()).searchParams.get('variant'));
  if (!target) {
    return {
      outcome: 'unavailable',
      message: soldOutMessage(product.variants.length, 'variants', 'sold out'),
      details: counts,
    };
  }
  if (product.variants.length === 1) return { outcome: 'none' };

  const selected = (by: string): VariantSelection => ({
    outcome: 'selected',
    details: {
      variant: shopifyVariantTitle(target),
      variantId: target.id,
      variantSelectedBy: by,
      ...counts,
    },
  });
  const hasForm =
    (await page.evaluate(markProductForm, {
      ids: product.variants.map((v) => v.id),
      formMark: FORM_MARK,
    })) !== null;

  try {
    const values = shopifyVariantOptions(target);
    let applied = 0;
    let changed = 0;
    for (const [index, value] of values.entries()) {
      const outcome = await setShopifyOption(
        page,
        { name: product.optionNames[index] ?? null, position: index + 1, value },
        deadline,
      );
      if (outcome !== 'missing') applied += 1;
      if (outcome === 'changed') changed += 1;
    }
    const byTheme = changed === 0 ? 'already selected' : 'theme options';
    if (applied === values.length && values.length > 0) {
      if (!hasForm) return selected(byTheme);
      const until = Math.min(deadline, Date.now() + FORM_ID_WAIT_MS);
      if (await waitForFormId(page, target.id, until)) return selected(byTheme);
    }
    // The theme's picker is not one we recognise, or it did not move the form's variant id:
    // set the id the form submits.
    if (hasForm) {
      await page.evaluate(productFormId, { formMark: FORM_MARK, set: target.id });
      const until = Math.min(deadline, Date.now() + 1_000);
      if (await waitForFormId(page, target.id, until)) return selected('hidden input');
    }
    return selected('not applied');
  } finally {
    await page
      .evaluate(
        (marks) => {
          for (const mark of marks) {
            for (const element of Array.from(document.querySelectorAll(`[${mark}]`))) {
              element.removeAttribute(mark);
            }
          }
        },
        [OPTION_MARK, LABEL_MARK, FORM_MARK],
      )
      .catch(() => undefined);
  }
}

// WooCommerce ---------------------------------------------------------------------------

const WooVariationSchema = z
  .object({
    variation_id: IdSchema,
    attributes: z.record(z.string(), z.string()).default({}),
    is_in_stock: z.boolean().optional(),
    is_purchasable: z.boolean().optional(),
    variation_is_active: z.boolean().optional(),
    variation_is_visible: z.boolean().optional(),
  })
  .transform((v) => ({
    id: v.variation_id,
    attributes: v.attributes,
    inStock: v.is_in_stock,
    purchasable: v.is_purchasable,
    active: v.variation_is_active,
    visible: v.variation_is_visible,
  }));
export type WooVariation = z.output<typeof WooVariationSchema>;

/**
 * Reads `data-product_variations`. WooCommerce writes "false" when a product has more
 * variations than its AJAX threshold and asks the store for each combination instead.
 */
export function parseWooVariations(raw: string | null): WooVariation[] | 'ajax' | null {
  if (raw === null || raw.trim() === '') return null;
  if (raw.trim() === 'false') return 'ajax';
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = z.array(WooVariationSchema).safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Missing flags count as true, as they do in WooCommerce's own script. */
export function isWooVariationAvailable(variation: WooVariation): boolean {
  return (
    variation.inStock !== false &&
    variation.purchasable !== false &&
    variation.active !== false &&
    variation.visible !== false
  );
}

export function chooseWooVariation(variations: readonly WooVariation[]): WooVariation | null {
  return variations.find(isWooVariationAvailable) ?? null;
}

/** Combinations in option order (the first option changes slowest), at most `limit`. */
export function optionCombinations(
  lists: readonly (readonly string[])[],
  limit = MAX_OPTION_COMBINATIONS,
): { combinations: string[][]; total: number } {
  if (lists.length === 0 || lists.some((list) => list.length === 0)) {
    return { combinations: [], total: 0 };
  }
  const total = lists.reduce((product, list) => product * list.length, 1);
  const combinations: string[][] = [];
  const walk = (prefix: string[], depth: number) => {
    if (combinations.length >= limit) return;
    const list = lists[depth];
    if (!list) {
      combinations.push(prefix);
      return;
    }
    for (const value of list) walk([...prefix, value], depth + 1);
  };
  walk([], 0);
  return { combinations, total };
}

interface WooAttribute {
  name: string;
  label: string;
  value: string;
  options: Array<{ value: string; text: string }>;
}

const VARIATIONS_FORM = 'form.variations_form';

/** Runs in the page: the attribute selects of the variations form, in page order. */
function readWooAttributes(formSelector: string): WooAttribute[] {
  const form = document.querySelector(formSelector);
  if (!form) return [];
  return Array.from(
    form.querySelectorAll<HTMLSelectElement>(
      'select[name^="attribute_"], select[data-attribute_name]',
    ),
  ).map((select) => {
    const name = select.getAttribute('data-attribute_name') ?? select.name;
    const label = (select.labels?.[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      name,
      label: label || name.replace(/^attribute_(pa_)?/, ''),
      value: select.value,
      options: Array.from(select.options)
        .filter((o) => o.value !== '' && !o.disabled)
        .map((o) => ({ value: o.value, text: o.text.replace(/\s+/g, ' ').trim() })),
    };
  });
}

type WooState = { state: 'available'; id: string } | { state: 'unavailable' | 'pending' };

/** Runs in the page: what the variations form shows right now. */
function readWooState(formSelector: string) {
  const form = document.querySelector(formSelector);
  const button = form?.querySelector<HTMLButtonElement>('.single_add_to_cart_button');
  return {
    id:
      form?.querySelector<HTMLInputElement>('input[name="variation_id"], input.variation_id')
        ?.value ?? '',
    enabled:
      button !== null &&
      button !== undefined &&
      !button.disabled &&
      !button.classList.contains('disabled'),
    unavailable: button?.classList.contains('wc-variation-is-unavailable') ?? false,
    noMatch: form?.querySelector('.wc-no-matching-variations') !== null,
  };
}

/**
 * Waits for WooCommerce to resolve the chosen attributes. Its script clears the variation id on
 * every change, so an id means this combination resolved; only then does an "unavailable"
 * button describe it rather than the previous one.
 */
async function waitForWooState(
  page: Page,
  expectedId: string | null,
  until: number,
): Promise<WooState> {
  while (true) {
    const s = await page.evaluate(readWooState, VARIATIONS_FORM);
    const resolved = s.id !== '' && s.id !== '0' && (expectedId === null || s.id === expectedId);
    if (resolved && s.enabled) return { state: 'available', id: s.id };
    if (s.noMatch || (resolved && s.unavailable)) return { state: 'unavailable' };
    if (Date.now() >= until) return { state: 'pending' };
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Selects each attribute that differs from what the form shows, in page order. */
async function applyWooAttributes(
  page: Page,
  attributes: readonly WooAttribute[],
  values: readonly string[],
  deadline: number,
): Promise<void> {
  const current = await page.evaluate(readWooAttributes, VARIATIONS_FORM);
  for (const [index, attribute] of attributes.entries()) {
    const value = values[index];
    if (value === undefined || current[index]?.value === value) continue;
    const select = page
      .locator(`${VARIATIONS_FORM} select[name=${JSON.stringify(attribute.name)}]`)
      .first();
    // Swatch plugins hide the select and drive it from their own buttons.
    const visible = await select.isVisible();
    await select.selectOption(value, { force: !visible, timeout: remaining(deadline) });
  }
}

function wooTitle(attributes: readonly WooAttribute[], values: readonly string[]): string {
  return attributes
    .map((attribute, index) => {
      const value = values[index] ?? '';
      const text = attribute.options.find((o) => o.value === value)?.text ?? value;
      return `${attribute.label}: ${text}`;
    })
    .join(', ');
}

async function selectWooVariation(page: Page, deadline: number): Promise<VariantSelection> {
  const form = page.locator(VARIATIONS_FORM).first();
  if ((await form.count()) === 0) return { outcome: 'none' };
  const attributes = await page.evaluate(readWooAttributes, VARIATIONS_FORM);
  if (attributes.length === 0) return { outcome: 'none' };
  const variations = parseWooVariations(await form.getAttribute('data-product_variations'));

  if (variations !== null && variations !== 'ajax') {
    const counts: Details = {
      variantSource: 'data-product_variations',
      availableVariants: variations.filter(isWooVariationAvailable).length,
      totalVariants: variations.length,
    };
    const target = chooseWooVariation(variations);
    if (!target) {
      return {
        outcome: 'unavailable',
        message:
          variations.length === 0
            ? 'No available variant: the variations form lists no variations'
            : soldOutMessage(variations.length, 'variations', 'out of stock'),
        details: counts,
      };
    }
    // An empty attribute value means "any": take the first option the form offers.
    const values = attributes.map(
      (attribute) => target.attributes[attribute.name] || (attribute.options[0]?.value ?? ''),
    );
    const details: Details = {
      variant: wooTitle(attributes, values),
      variantId: target.id,
      variantSelectedBy: 'theme options',
      ...counts,
    };
    const missing = attributes.find(
      (attribute, index) => !attribute.options.some((o) => o.value === values[index]),
    );
    if (missing) {
      return {
        outcome: 'unresolved',
        message: `Variation ${details.variant} is in stock but the form has no option ${JSON.stringify(values[attributes.indexOf(missing)])} for ${missing.label}`,
        details,
      };
    }
    try {
      await applyWooAttributes(page, attributes, values, deadline);
    } catch {
      // Reported below: the button did not enable.
    }
    const outcome = await waitForWooState(page, target.id, deadline);
    if (outcome.state === 'available') return { outcome: 'selected', details };
    return {
      outcome: 'unresolved',
      message: `Chose ${String(details.variant)} but the add-to-cart button did not enable`,
      details,
    };
  }

  // No variation data in the page: try combinations the way a shopper would, in order.
  const { combinations, total } = optionCombinations(
    attributes.map((attribute) => attribute.options.map((o) => o.value)),
  );
  const source = 'wc-ajax=get_variation';
  if (total === 0) {
    return {
      outcome: 'unavailable',
      message: 'No available variant: the variations form has no options to choose',
      details: { variantSource: source },
    };
  }
  let tried = 0;
  for (const values of combinations) {
    if (Date.now() >= deadline) break;
    tried += 1;
    try {
      await applyWooAttributes(page, attributes, values, deadline);
    } catch {
      continue;
    }
    const outcome = await waitForWooState(
      page,
      null,
      Math.min(deadline, Date.now() + COMBINATION_WAIT_MS),
    );
    if (outcome.state === 'available') {
      return {
        outcome: 'selected',
        details: {
          variant: wooTitle(attributes, values),
          variantId: outcome.id,
          variantSelectedBy: 'theme options',
          variantSource: source,
        },
      };
    }
  }
  const details: Details = { variantSource: source, combinationsTried: tried };
  if (tried < combinations.length) {
    return {
      outcome: 'unresolved',
      message: `No variation resolved within the step timeout (${tried} of ${total} option combinations tried)`,
      details,
    };
  }
  return {
    outcome: 'unavailable',
    message:
      total > combinations.length
        ? `No available variant among the first ${combinations.length} of ${total} option combinations`
        : `No available variant: none of the ${total} option combinations is in stock`,
    details,
  };
}

// Entry point ---------------------------------------------------------------------------

/** Which variant form the page has, for stores whose platform was not detected. */
async function variantFormOnPage(page: Page): Promise<'shopify' | 'woocommerce' | null> {
  return page.evaluate((wooForm) => {
    if (document.querySelector(wooForm)) return 'woocommerce';
    if (document.querySelector('form[action*="/cart/add"]')) return 'shopify';
    return null;
  }, VARIATIONS_FORM);
}

/**
 * Chooses an available variant before the add-to-cart control is looked for. `request` must
 * be the journey context's request client, so product data is read with the page's cookies
 * and through the same egress checks.
 */
export async function selectVariant(
  page: Page,
  request: APIRequestContext,
  platform: Platform,
  options: VariantSelectionOptions,
): Promise<VariantSelection> {
  const deadline = Date.now() + options.timeoutMs;
  const kind = platform === 'unknown' ? await variantFormOnPage(page) : platform;
  if (kind === 'woocommerce') return selectWooVariation(page, deadline);
  if (kind === 'shopify') return selectShopifyVariant(page, request, deadline);
  return { outcome: 'none' };
}
