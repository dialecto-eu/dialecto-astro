import { t } from './i18n.js';

const IDS = ['a', 'b'];
IDS.push(window.extra);

export const labels = IDS.map((id) => t(`nested.${id}`));
