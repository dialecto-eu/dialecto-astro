import { t } from './i18n.js';

const badge = (opts) => t(`q.${opts.kind}`);

export const on = badge({ kind: 'on' });
register(badge);
