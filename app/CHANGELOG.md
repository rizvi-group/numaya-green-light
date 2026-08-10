# Changelog

All notable changes to this application are documented in this file.

## 0.2.4

- **A licence pathway in the UI.** A new "Greenlight licence and enrichment" command opens a panel
  stating which mode the workspace is running, whether enrichment is on, the masked key, and when
  the licence was last checked. Until now that state was computed correctly and published nightly
  but surfaced nowhere a person could read it: an admin wondering why nothing was being enriched
  had to be told by a human, and one who wanted to fix it had nowhere to go, because `LICENCE_KEY`
  is a settings field that presumes you already hold a key.
- The panel offers a purchase route **only in the two states a purchase would fix** — no key at
  all, and a plan that excludes enrichment. An expired licence, a rejected key, a wrong
  environment or an unreachable service each have a specific remedy that the existing admin notice
  already names, and a "Get a licence" button beside that advice would send somebody to spend
  money on the wrong problem. A working licence never sees the button.
- The route reads the published state and never validates. Validation stays on the nightly run, so
  a human-triggered panel cannot put a network call to Numaya on the path, and there is only ever
  one resolver whose answer can be trusted. The panel says when the state was taken instead.
- The response carries the masked key only, and the route reads `LICENCE_KEY` solely to learn
  whether one is set — never its value.

## 0.2.3

- Application-variable defaults are now strings. `USE_TWENTY_AI` shipped `true` and
  `MONTHLY_ENRICHMENT_CAP` shipped `1000`, and Twenty encrypts every default on install
  (`encryptVersioned(input.value)`). On 2.12 that value reaches Node's cipher unconverted, so a
  boolean aborts the whole install with `The "data" argument must be of type string ... Received
  type boolean (true)` — from the UI as well as the CLI. Later servers coerce first, which is why
  this never showed up in development. Runtime behaviour is unchanged: values come back out of the
  API as text either way, which is what `readBooleanDefaultTrue()` and `readCap()` already parse.
- Vendor identity is now **Numaya AI** — package author, the marketplace author field, the ELv2
  licensor line, and the user-facing strings that name the vendor for support or licensing. The
  product is still called Greenlight and the app's display name is unchanged.

## 0.2.2

- Widened `engines.twenty` to `>=2.12.0 <3.0.0`. 0.2.1 declared a `2.26.0` floor, which is the
  `twenty-sdk` version the app is built against, and that floor stopped the app installing on a
  2.12.0 server. Two things make the wider range defensible: 2.12's manifest compiler already
  handles every entity kind this app ships (objects, fields, logic functions, front components,
  agents, skills, page layouts and tabs, view fields and field groups, roles, object and field
  permissions, application variables, command and navigation menu items), and the only 2.26-era
  SDK API that would have been a hard blocker — `enqueueJob` — is not used here.
- The range is now a claim about the oldest server this app has been *run* against rather than the
  newest SDK it was built with. It is not a claim that every release in between was tested.

## 0.2.1

- First release published from CI with npm provenance. 0.2.0 was published by hand with a bare
  `npm publish` from `app/`, which ships the working tree rather than the built app: the tarball
  had no `manifest.json` and could not be installed by a Twenty server, and a local publish cannot
  carry OIDC provenance, without which the app cannot be claimed in the marketplace. 0.2.0 is
  deprecated on npm.
- Declared `engines.twenty` as `>=2.26.0 <3.0.0`. The server validates this field on both tarball
  upload and workspace install; with the field absent the app claimed compatibility with every
  server version. The floor is the `twenty-sdk` version the app is built against; the ceiling is
  the next major, which is not something this release can claim to have been tested on.

## 0.2.0

- The application proper: ICP scoring, enrichment, the compliance gate, install hooks and the
  Greenlight views. Published to npm by hand and superseded by 0.2.1 — see above.

## 0.1.0

- Initial application scaffolded with [`create-twenty-app`](https://www.npmjs.com/package/create-twenty-app)
