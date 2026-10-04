import { t as runtimeT } from './i18n.js';

const withLabel = (item, key) => Object.defineProperty(item, 'label', { get: () => runtimeT(key), enumerable: true });

export const group = withLabel({ id: 'g' }, 'a.b');
export const skills = ['p', 'q'].map((id) => withLabel({ id }, `game.skill.${id}`));
