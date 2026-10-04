import { t } from './i18n.js';

const range = (count) => Array.from({ length: count }, (_, i) => i + 1);
const BEATS = [{ id: 'cover', body: 2 }, { id: 'many', body: 1 }];

export const bodies = BEATS.map((beat) => range(beat.body).map((n) => t(`lesson.beat.${beat.id}.body${n}`)));
