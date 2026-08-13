# GitHub Pages — outstanding work

This repo builds all its demos into one static site with a shared three.js chunk
(`npm run build:all` → `dist-pages/`), deployed by
`.github/workflows/pages.yml` on every push to `main`.


## Pages is blocked by the account plan

This repo is private, and GitHub Pages on private repos requires a paid plan.
Enabling it returns:

> Your current plan does not support GitHub Pages for this repository.

Everything else is ready — `npm run build:all` builds 19 demos cleanly. To
publish, either make the repo public or upgrade the plan, then:

```bash
gh api -X POST repos/stevejtrettel/rendering-visualizer/pages -f build_type=workflow
git commit --allow-empty -m "Trigger Pages deploy" && git push
```

---

Setup mirrored from `stevejtrettel/threejs-demos`. To re-sync the build script
and workflow after a change there:

```bash
node ../threejs-demos/scripts/add-pages.mjs ../rendering-visualizer
```
