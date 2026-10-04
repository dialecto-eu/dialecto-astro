import { t } from './i18n.js';

const tx = (key) => t(key);
const step = (name) => tx(`lesson.step.${name}.title`);

export const one = step('one');
export const two = step('two');
export const lit = tx('a.b');
