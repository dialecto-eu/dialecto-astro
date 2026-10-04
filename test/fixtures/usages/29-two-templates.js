import { t } from './i18n.js';

export const rows = ['add', 'build'].map((icon) => ({ icon, heading: t(`lesson.takeaway.${icon}.heading`), text: t(`lesson.takeaway.${icon}.text`) }));
