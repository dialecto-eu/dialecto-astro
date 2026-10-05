# dialecto-astro (@dialecto/astro)

Dev-only add-on for Astro sites that keep flat JSON (ICU) catalogs: click a translated string while
`astro dev` runs and edit it in Dialecto's sidebar. Public, MIT, in the `dialecto-eu` org. It talks to
the Dialecto app (`dlocal` repo, app.dialecto.eu); docs live at dialecto.eu/docs (`dialecto-web`);
specs are in `ddd-plan` (spec 16). Sibling add-ons: `dialecto-phoenix` (gettext) and `source-rewrite`
(the CI action that applies call-site rewrites). Main line: `main`.

## Layout

- `dialecto-in-context.mjs`: the integration and the CI CLI (`scan`, `usages`, `check`). A single
  module, Node 22.12+, no runtime dependencies.
- `dialecto-usages.mjs`: the code scanner behind `usages` and `check`. It reads code, never runs it.
- `test/`: node tests with fixtures.

## Run and verify

```sh
npm install
npm test        # node --test "test/*.test.mjs"
```

## Rules that bite

- Dev only: it does nothing in `astro build`, `astro preview` or tests.
- Keep the add-on dependency-free at runtime; parsers (`@babel/parser`, `@astrojs/compiler-rs`,
  `rolldown`) are dev dependencies the user's project supplies for CI.
- It covers flat catalogs only; the key-rename scan does not do nested catalogs.
- The overlay, the `/__dialecto/context` route and the loopback rules are shared with `dialecto-phoenix`
  and the Dialecto overlay; changing them is a major version.
- Option names and env vars in the README table (`DIALECTO_URL`, `DIALECTO_PROJECT`, ...) are public
  API; `DIALECTO_REPO` is a kept legacy alias.
