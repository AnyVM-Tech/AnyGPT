# LibreChat customization patch

The `apps/ui/librechat` checkout is intentionally ignored and pinned by the
outer AnyGPT repository. Keep reusable LibreChat source and design changes in
the optional tracked file `librechat.patch` in this directory.

The normal config sync automatically replays that patch. It first performs a
full `git apply --check`; if an overlapping local edit or an incompatible
LibreChat revision prevents a clean application, it stops without changing the
checkout. An already-applied patch is detected with a reverse check and is a
no-op.

To capture selected edits, including new or binary assets, from the ignored
checkout without staging its real Git index:

```bash
# Run from the AnyGPT repository root.
bash apps/ui/scripts/capture-customizations.sh \
  client/src/path/to/ChangedComponent.tsx \
  client/public/assets/AnyGPT.svg
git diff -- apps/ui/customizations/librechat.patch
```

Pass explicit intended paths. The capture helper rejects `.env`, `.git`, logs,
and `node_modules`. Keep endpoint settings in `apps/ui/config/librechat.yaml`,
environment defaults in `apps/ui/config/anygpt.env.example`, and the existing
AnyGPT/AnyVM master assets in `apps/ui/` rather than duplicating them in the
ignored checkout.
