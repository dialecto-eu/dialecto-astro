import { t } from './i18n.js';

const rows = [];
for (let index = 0; index < 2; index += 1) {
  rows.push(t(`m.${index}`));
}

export { rows };
