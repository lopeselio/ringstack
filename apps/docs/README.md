# Docs site

The ringstack documentation site, built with [Astro Starlight](https://starlight.astro.build/).

```bash
pnpm --filter @ringstack/docs dev       # http://localhost:4321
pnpm --filter @ringstack/docs build     # static site in apps/docs/dist
```

Most pages are not written here. `scripts/sync.mjs` copies the repo's specs, guides and READMEs into `src/content/docs/` before every dev, build and typecheck run, so each page has one source of truth. Edit the source file (the generated page names it), not the copy. The sync adds frontmatter, drops the source's H1, and rewrites relative links: targets that are on the site become site routes, and everything else links to the file on GitHub.

Only `index.mdx`, `overview.md` and `getting-started.md` live here. The generated folders (`guides/`, `tools/`, `reference/`, `background/`) are git-ignored.

To add a page, append its source to `PAGES` in `scripts/sync.mjs` and its slug to the sidebar in `astro.config.mjs`.
