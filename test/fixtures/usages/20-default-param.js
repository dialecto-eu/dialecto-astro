import { t as runtimeT } from './i18n.js';

export function heading(translate = runtimeT) {
  return translate('a.b');
}

export const lede = ({ say = runtimeT } = {}) => say('a.b');
