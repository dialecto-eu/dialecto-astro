import { t } from './i18n.js';

export const groups = { soccer: 'game.group.soccer' };
export const fixed = t('game.group.cello');
export const pick = (id) => t(groups[id]);
export const filter = ['game.'];
