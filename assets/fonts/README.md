# Bundled caption fonts

These fonts are burned into exported clips by ffmpeg/libass. They are bundled
because the caption font must exist **on the server**, not just in the browser —
otherwise libass silently substitutes a fallback and the exported video does not
match what the editor shows.

| File | Family | Source | Licence |
| --- | --- | --- | --- |
| `Montserrat-Bold.ttf` | Montserrat | [google/fonts](https://github.com/google/fonts/tree/main/ofl/montserrat) | SIL Open Font License 1.1 |
| `Oswald-Bold.ttf` | Oswald | [google/fonts](https://github.com/google/fonts/tree/main/ofl/oswald) | SIL Open Font License 1.1 |
| `Inter-Bold.ttf` | Inter | [google/fonts](https://github.com/google/fonts/tree/main/ofl/inter) | SIL Open Font License 1.1 |

All three are licensed under the [SIL Open Font License 1.1](https://openfontlicense.org/),
which permits bundling and redistribution with software.

`Impact` and `Arial Black` are not bundled: they ship with Windows and macOS and
are not redistributable. On a server without them, libass falls back — the
renderer reports this rather than failing silently (see below).

## Why these are static, not variable fonts

Google ships these families as *variable* fonts (`Montserrat[wght].ttf`). Those
do not work reliably here.

Captions set `Bold`, so libass asks its font provider for weight 700. On Windows
that provider is DirectWrite, which failed to match a 700 instance of the
variable Montserrat and silently picked Arial instead:

```
fontselect: (Montserrat, 700, 0) -> Arial-BoldMT
```

Exports therefore used Arial while the editor preview showed Montserrat. Oswald
and Inter happened to resolve, so the bug affected only some fonts — which made
it easy to miss.

The fix is to ship static instances pinned at `wght=700`, with family/subfamily,
`OS/2.usWeightClass`, `fsSelection` and `head.macStyle` all set consistently so
the match is unambiguous:

```
fontselect: (Montserrat, 700, 0) -> Montserrat-Bold
```

Regenerate them with:

```
python tools/make-static-fonts.py
```

That script reads the variable source files, so keep a copy if you need to
re-instance at a different weight.

## Substitution is reported, never silent

`detectFontSubstitution` in `server/render.ts` parses libass's `fontselect`
lines after each captioned render. If the family actually used differs from the
one requested, the clip is marked with a warning naming both, instead of
producing an export that quietly disagrees with the preview.
