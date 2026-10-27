# Breezy

- Never open breezy.k5d.de in a copy of my Firefox profile: edits sync to the shared board my partner sees, and Playwright's `setOffline` doesn't reach its container tabs. Test against localhost (`npm run dev`).
- Small PRs off main, no stacks, merged when Main is green. Only Main runs on a pull request; to try a branch on real devices, `gh workflow run ios.yaml --ref <branch>` (or `nightly.yaml`); failures are in `build/scenarios/*/timeline.txt` and `case.json`.
- A bug found by hand, or by a nightly run, is fixed with a test at the lowest level that shows it, the fake taught when it was wrong, and a row in `docs/escapes.md`; `TESTING.md` says which level owns which class of bug.
