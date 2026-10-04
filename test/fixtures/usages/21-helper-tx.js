import { t } from './i18n.js';

const tx = (key) => String(t(key)).replaceAll('&', '&amp;');

export const lake = tx('a.b');
export const rock = tx('c.d');
