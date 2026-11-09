import { describe, expect, it } from 'vitest';
import { StepRecorder, missingTags, tagsForUrl } from '@checkout-sentinel/core';

describe('tagsForUrl', () => {
  it.each([
    ['https://www.facebook.com/tr/?id=1&ev=PageView', ['meta']],
    ['https://www.facebook.com/tr?id=1&ev=AddToCart', ['meta']],
    ['https://connect.facebook.net/en_US/fbevents.js', ['meta']],
    ['https://region1.google-analytics.com/g/collect?v=2&tid=G-X', ['ga4']],
    ['https://www.googletagmanager.com/gtag/js?id=G-X', ['ga4']],
    ['https://www.googletagmanager.com/gtm.js?id=GTM-X', ['gtm']],
    ['https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/', ['google_ads']],
    ['https://analytics.tiktok.com/api/v2/pixel', ['tiktok']],
    ['https://ct.pinterest.com/v3/?event=init', ['pinterest']],
    ['https://s.pinimg.com/ct/core.js', ['pinterest']],
    ['https://static.klaviyo.com/onsite/js/klaviyo.js', ['klaviyo']],
  ])('%s -> %j', (url, tags) => {
    expect(tagsForUrl(url)).toEqual(tags);
  });

  it.each([
    'https://www.facebook.com/somepage',
    'https://evilfacebook.com/tr',
    'https://s.pinimg.com/images/pin.jpg',
    'https://store.example/tr',
    'not a url',
  ])('ignores %s', (url) => {
    expect(tagsForUrl(url)).toEqual([]);
  });
});

describe('missingTags', () => {
  it('lists expected tags that never fired, in a stable order', () => {
    expect(missingTags(['tiktok', 'meta', 'ga4'], ['ga4'])).toEqual(['meta', 'tiktok']);
    expect(missingTags([], ['ga4'])).toEqual([]);
  });
});

describe('StepRecorder tags', () => {
  it('records each tag once per step, only while a step runs', () => {
    const recorder = new StepRecorder();
    recorder.recordRequest('https://www.facebook.com/tr?ev=PageView');
    recorder.begin('open_product');
    recorder.recordRequest('https://www.facebook.com/tr?ev=PageView');
    recorder.recordRequest('https://www.facebook.com/tr?ev=ViewContent');
    recorder.recordRequest('https://region1.google-analytics.com/g/collect');
    expect(recorder.take('open_product').tags).toEqual(['meta', 'ga4']);
  });
});
