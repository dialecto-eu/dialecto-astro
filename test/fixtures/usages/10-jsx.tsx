import { FormattedMessage } from 'react-intl';

export function View() {
  return (
    <section id="a.b">
      <FormattedMessage id="a.b" />
      <FormattedMessage id={'a.b'} defaultMessage="Title" />
    </section>
  );
}
