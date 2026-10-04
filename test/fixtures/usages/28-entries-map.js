import { t } from './i18n.js';

const ICONS = { red: '#f00', blue: '#00f' };

export const names = Object.entries(ICONS).map(([id, color]) => ({ color, name: t(`icon.${id}.name`) }));
