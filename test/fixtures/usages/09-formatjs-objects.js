import { defineMessages } from 'react-intl';

export const messages = defineMessages({
  title: { id: 'a.b', defaultMessage: 'Title' },
  other: { id: 'c.d', defaultMessage: 'Other' },
});

export const text = (intl) => intl.formatMessage({ id: 'a.b' });
