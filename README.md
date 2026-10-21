# ethnmz.com

Personal site, built with [Eleventy](https://www.11ty.dev/) and deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.

## Run it locally

```sh
npm install
npm start        # http://localhost:8423, rebuilds on save
npm run build    # writes the site to _site/
```

## Where things live

| what | where |
| --- | --- |
| pages | `src/<page>/index.njk` (the home page is `src/index.njk`) |
| shared head, sidebar, mobile notice, theme script | `src/_includes/layouts/page.njk`, `src/_includes/partials/sidebar.njk` |
| CSS every page shares | `assets/site.css` (each page keeps its own rules in its `pageStyle` block) |
| pixel art, cats, cursors | `assets/v2.js`, `assets/v2.css` |
| images | `media/` |
| unlisted pages | `src/colorstack/index.html`, `src/open-source/index.html` (copied as-is) |

## Adding things

Most lists are data files in `src/_data/`. Edit the JSON, push, done.

- **EDC item**: add `{ "name", "img", "alt", "tags": [] }` to `edc.json`.
- **Daily app**: add an entry to `apps.json` (`id`, `name`, `brand` color, `icon`, `tags`, `about`, `shots`).
- **Favorite album or game**: add `{ "img", "alt" }` to `albums` or `games` in `favorites.json`. The counts update themselves.
- **Project**: add to `projects.json` (`name`, `lang`, optional `collab`, `about`, optional `images` and `links`).
- **VG song of the day**: `playlist.json`.
- **Sidebar link**: edit `src/_includes/partials/sidebar.njk` once.

Text fields can contain HTML entities like `&rsquo;`.

Only `assets/`, `media/`, `CNAME` and `playlist.json` are copied into the build (see `eleventy.config.mjs`), so folders that live only on this machine never get published.
