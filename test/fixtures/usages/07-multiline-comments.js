import { t } from './i18n.js';

// t('a.b') was the old title; keep 'a.b' in the docs
export const heading = t(
  // 'a.b' — keep in sync with the design
  /* t('a.b') */ 'a.b',
  { n: 1 },
);

/* const unused = t('a.b'); */
