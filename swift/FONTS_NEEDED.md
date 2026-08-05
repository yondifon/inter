Not shipped as a package resource — a note for whoever completes the IBM
Plex typeface wiring in `Sources/DesignSystem.swift` (`ProseFace`, `MonoFace`).

Drop these eight files into `Sources/Resources/Fonts/`, unmodified:

    Sources/Resources/Fonts/IBMPlexSans-Regular.ttf
    Sources/Resources/Fonts/IBMPlexSans-Medium.ttf
    Sources/Resources/Fonts/IBMPlexSans-SemiBold.ttf
    Sources/Resources/Fonts/IBMPlexSans-Bold.ttf
    Sources/Resources/Fonts/IBMPlexMono-Regular.ttf
    Sources/Resources/Fonts/IBMPlexMono-Medium.ttf
    Sources/Resources/Fonts/IBMPlexMono-SemiBold.ttf
    Sources/Resources/Fonts/IBMPlexMono-Bold.ttf

Source: the "IBM Plex Sans" and "IBM Plex Mono" typefaces, part of the IBM
Plex family (github.com/IBM/plex). Use the static TTF instances from the
release, not the variable font: `Font.custom` in `DesignSystem.swift` has no
weight axis to drive, so each weight needs its own named instance.

The PostScript names this code asks for — IBMPlexSans-Regular,
IBMPlexSans-Medium, IBMPlexSans-SemiBold, IBMPlexSans-Bold and the Mono
equivalents — follow IBM Plex's documented, consistent naming convention
across every weight in the family, but this note was written without a font
inspection tool or network access, so they have not been confirmed by
opening the actual files. Verify with `fc-scan` or Font Book against the
downloaded release before shipping — a wrong PostScript name fails silently
into the system fallback, which looks identical to the font not being
installed at all.

Licence: IBM Plex is widely stated to ship under the SIL Open Font License
1.1, which permits bundling in a redistributed application. That claim comes
from the project's own README and is not re-verified here — confirm it
against the `LICENSE.txt` in the github.com/IBM/plex release before shipping,
the same as the prior Inter note asked for.

Until these land, `Fonts/` stays empty, `ProseFace.available` and
`MonoFace.available` resolve to `false`, and the app renders prose in the
system face and machine strings in the system monospaced design exactly as
it did before this typeface existed — nothing is blank or broken without
them.
