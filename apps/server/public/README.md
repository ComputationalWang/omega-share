# Server-served site files

Served by `apps/server/src/static.ts` at the site root with `Cache-Control: public, max-age=86400`
(the names are fixed, so they can't be immutable): `favicon.ico` (16 + 32), `apple-touch-icon.png` (180),
`icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (manifest `purpose: maskable`), `og-image.png` (the 1200×630 share card for every page), `manifest.webmanifest`
and `robots.txt` (OME-764).

The images are copies of the judged M9 D1 set (OME-762, swapped in by OME-785): `assets/site/<same name>`, except
`og-image.png`, which is `assets/site/og-card.png`. Regenerate with `bun assets/src/build.ts` and copy again; a server test
checks the bytes match. Images: CC BY-SA 4.0.
