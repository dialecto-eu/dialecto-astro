import { t } from './i18n.js';

const BEATS = [{ id: 'cover' }, { id: 'many' }];

export const rows = BEATS.map((beat) => {
  const key = `lesson.beat.${beat.id}`;
  return { heading: t(`${key}.heading`), body: t(`${key}.body`) };
});
