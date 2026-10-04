import { t } from './i18n.js';

const GROUPS = [
  { id: 'x', items: [{ id: 'a' }, { id: 'b' }] },
  { id: 'y', items: [{ id: 'a' }, { id: 'c' }] },
];

export const labels = GROUPS.map((group) => group.items.map((item) => t(`nested.${group.id}.${item.id}`)));
