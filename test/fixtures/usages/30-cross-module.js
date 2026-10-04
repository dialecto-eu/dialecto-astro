import { t } from './i18n.js';
import { STEPS } from './30-data.js';

export const titles = STEPS.map((step) => t(`lesson.step.${step.id}.title`));
