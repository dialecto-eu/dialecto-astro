import { t } from './i18n.js';

export const nested = t('a.b', { detail: t('a.c', { n: 1 }) });
