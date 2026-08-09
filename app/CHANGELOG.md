# Changelog

All notable changes to this application are documented in this file.

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
