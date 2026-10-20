# Changelog

## 1.000 (2026-10-20)

First release of Melad Display, rebuilt from Jomhuria to replace the machine-made interim
"MeladOriginal".

**Shape and weight**
- Condensed by measured set width (78 / 84 / 90 % statics; variable `wdth` 78–100). The width axis
  is calibrated per weight, so changing weight doesn't change line length.
- Weight added by a point-preserving outline offset (+46 x / +40 y per side at wght 900),
  slightly stronger horizontally to make up for the condensing. wght 400 is Jomhuria's own weight.
- Gap-aware growth: each outline point grows only as far as the white space in front of it
  allows. Counters (ه و ف ق م ص), the teeth of س ش and dot clearances keep at least 80% of
  any gap under 120 units, so they don't clog the way MeladOriginal's did.
- A miter limit stops pointed tips (alef, lam, kaf) from growing spikes.
- Dots, hamza and harakat are condensed less (√ of the letter factor), get 50–70% of the extra
  weight and are moved clear of the thicker body. Shadda and hamza stay open at 300px.
- Pieces that touch in Jomhuria (k, ﷼, ڇ…) are bridged before growing, so they don't overlap.

**Joins and kashida**
- Every connecting stroke is pinned to the same height: −40…476 at wght 900, checked on 1,014 join
  edges. Neighbouring letters overlap by 140 units or more, so there are no seams under the
  stacked shadow.
- New tatweel (U+0640): one 360-unit segment per character that overlaps its neighbours, so any
  number of them reads as one continuous stroke at the join height.
- Removed Jomhuria's `rlig` lookups that collapsed tatweel runs into fixed lengths and
  swallowed tatweels before final alef (in Jomhuria الفستـــان showed no kashida at all).
- New elongated alternates in `ss02` / `jalt`: ـهـ، ـسـ، ـشـ، ـلـ، final ى ی ي، final ن.

**Fixes to inherited issues**
- U+0674 high hamza is now a spacing letter (Jomhuria classed it as a mark).
- ‸ (U+2038) has a real advance. Rebuilt cmap. `ss01` is named. Smart-dropout `prep`. No
  Mac name records.

**Metrics and naming**
- Identical line box to Jomhuria: 3000 UPM, hhea/typo 1840 / −1160, USE_TYPO_METRICS.
- Family "Melad Display". OFL 1.1, Jomhuria copyright lines kept, melad's added.
