import { t } from './i18n.js';

const typed = window.name;

export const orKey = t(typed || 'a.b');
export const andKey = t(typed && 'a.b');
export const nullish = t(typed ?? 'a.b');
export const lookup = t({ small: 'a.b', large: 'c.d' }[typed]);
export const nested = t(typed ? 'a.b' : typed === 'x' ? 'c.d' : 'a.b');
