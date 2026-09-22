# TODO

## Now

- [ ] Cut `v1.0.0-beta.1`: the release commit is on `main` and CI is green, but no tag exists, so npm and GitHub Releases still stop at `alpha.7`. Push the tag, let `publish-npm.yml` publish and verify both packages, then move the stale `latest` dist-tag off `1.0.0-alpha.1`.

## Next

- [ ] Wallet-mode `@` entity source: SPEC 8.3's renderer side works, but no site-contract surface declares entities, so mentions are standalone-only today. Add the declaration, validation, and consent disclosure, then cover it in the hosted suite.
- [ ] ChatKit server adapter (`docs/CHATKIT_REVIEW.md`): translate the ChatKit server event stream into section 14 so a site with a custom ChatKit backend can drop in this renderer without touching the backend.
- [ ] Distribution: Chrome Web Store listing review, Firefox AMO signing, publish `arjunah-widget` to npm, and a desktop installer/tray path (the companion is still a Node CLI plus a browser dashboard).

## Deferred

- [ ] Verify OpenCode Zen against the live paid service with a real key; every adapter test so far uses a mock. Run the hosted and widget suites on Firefox, not only Chrome for Testing.
- [ ] Test `arjunah-desktop install|uninstall` on real Linux and Windows machines; only `status` has run here.
- [ ] T3 follow-ups (`docs/T3CODE.md`): `subscribeServerConfig` push instead of polling, `provider.auth.*` sign-in from the dashboard, direct `model-manifest.json` fetch, and runners for Cursor/Grok/Antigravity.

## Out of this repository

- [ ] **Secure inputs for Host Control's अर्जुनः model path** (machine-manager): passwords and SSH key passphrases are excluded from model-visible schemas and rejected in tool arguments, but the CBOR chat does not yet provide a secure collection flow. Add a backend `secure_input_required` event, show a masked one-time prompt in Host Control, return the value directly to the pending operation (never the transcript/model/logs), then retry it with cancellation, timeout, redaction, and regression tests. Not अर्जुनः code; kept here so it is not lost.
