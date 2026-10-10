# Server-served site files

Served by `apps/server/src/static.ts` at the site root with `Cache-Control: public, max-age=86400`
(the names are fixed, so they can't be immutable): `favicon.ico` (16 + 32), `apple-touch-icon.png` (180),
`icon-192.png`, `icon-512.png`, `og-image.png` (the 1200×630 share card for every page), `manifest.webmanifest`
and `robots.txt` (OME-764).

The images are **placeholders** (plain shapes in the `apps/web/src/style.css` colours) until the M9 D1 set
([OME-762](/OME/issues/OME-762)) passes judging; then swap the files in place, same names and sizes. Images: CC BY-SA 4.0.
