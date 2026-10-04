import { getTranslator } from './i18n.js';

const say = getTranslator('en');
const log = (text) => text;

export const title = say('a.b');
export const noise = log('a.b');
