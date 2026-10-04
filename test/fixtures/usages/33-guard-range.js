import { t } from './i18n.js';

const COUNT = 3;

export function story(param) {
  const index = Number.isInteger(param) && param >= 1 && param <= COUNT ? param - 1 : 0;
  return t(`m.${index}`);
}
