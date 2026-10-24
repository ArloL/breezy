# Breezy

- Never open breezy.k5d.de in a copy of my Firefox profile: edits sync to the shared board my partner sees, and Playwright's `setOffline` doesn't reach its container tabs. Test against localhost (`npm run dev`).
- For stability work: branches with draft PRs, never merge to main. Measure flakes with `gh workflow run desktop-soak.yaml --ref <branch>` (or `android-soak.yaml`); failures are in `build/scenarios/*/timeline.txt` and `case.json`.
