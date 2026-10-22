# Alight Motion project XML: format notes

How Alight Motion (Android, v5.0.273) stores a project as XML, so that tools and
AI models can read and write files the app imports.

Every rule below is tagged with how sure we are:

- **[app]** seen in XML written by Alight Motion itself. The app ships 13 of its
  own exported projects inside the APK (`assets/effects/presets/*.xml`, used for
  the built-in presets), so the app's reader is known to accept this form.
- **[decomp]** from the community decompile of v5.0.273
  ([kuchingneko28/alight-motion-docs](https://github.com/kuchingneko28/alight-motion-docs)).
- **[guess]** inferred; not yet confirmed by importing into the app.

Two claims in the community docs are corrected here: keyframe `t` is not
seconds, and custom shapes use `<path d>`, not `<parameter><contour>`.

## 1. Document

```xml
<?xml version='1.0' encoding='UTF-8' ?>
<scene title="My Project" width="1080" height="1920" exportWidth="1080" exportHeight="1920"
       bgcolor="#FF000000" totalTime="5000" fps="30" modifiedTime="1761130000000"
       amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android">
  <media .../>        <!-- every media file, first -->
  <bookmark t="2500"/> <!-- optional timeline markers (ms) -->
  <shape .../>        <!-- layers, back to front -->
</scene>
```

| Attribute | Meaning | |
| --- | --- | --- |
| `width`, `height` | canvas pixels | [app] |
| `exportWidth`, `exportHeight` | export size, normally equal to the canvas | [app] |
| `bgcolor` | `#AARRGGBB` | [app] |
| `totalTime` | duration, integer milliseconds | [app] |
| `fps` | frame rate (12, 15, 18, 20, 24, 25, 30, 48, 50, 60) | [app] |
| `modifiedTime` | unix ms | [app] |
| `amver`, `am`, `amplatform` | writer build; v5 writes `1028425`, `com.alightcreative.motion/5.0.273.1028425`, `android` | [app] (older values) / [decomp] |
| `ffver` | format version: 106 project, 107 preset, 108 when a `speedMap` has >1 keyframe. Older exports use 101 and still load | [app] [decomp] |

Colors are always `#AARRGGBB` (alpha first). `#FF000000` is opaque black.

## 2. Layers

Layer tags: `shape`, `text`, `drawing`, `embedScene` (nested scene / group),
`audio`, `camera`, `nullobj`. Order in the file is stacking order: first is at
the back. [app] [decomp]

Common attributes, in the order the app writes them [app] [decomp]:

`id` (unique positive integer) · `label` · `hidden="true"` · `startTime`, `endTime`
(integer ms on the scene timeline) · `clippingMask` · `fillType`
(`color`, `gradient`, `media`, `none`) · `blending` (blend mode id, omitted when
normal) · `fillImage` / `fillVideo` (media uri) · `inTime`, `outTime` · `speed` ·
`mediaFillMode` · `parent` (id of the parent layer)

Child elements, in this order [app] [decomp]:

1. `<transform>`
2. `<fillColor>`
3. `<gradient>`
4. `<effect>` (stack order)
5. `<gain>`, `<speedMap>`
6. edge decorations: `<border>`, `<glow>`, `<path-stroke>`, `<shadow>`
7. `<property>` (shape template parameters)
8. `<path>` (custom shape outline)
9. `<content>` (text)

## 3. Transform

```xml
<transform>
  <location value="540.000000,960.000000,0.000000"/>
  <pivot value="0.000000,0.000000"/>
  <scale value="1.000000,1.000000"/>
  <skew value="0.000000,0.000000"/>
  <rotation value="0.000000"/>
  <opacity value="1.000000"/>
</transform>
```

- `location` is the layer's origin in canvas pixels, origin top-left, y down.
  v3 exports write `x,y`; v5 writes `x,y,z`. Both load. [app] [decomp]
- Omitted children take their defaults: pivot 0,0; scale 1,1; skew 0,0;
  rotation 0 (degrees); opacity 1. [app]
- A layer's own geometry is centered on its origin (shape paths, template
  shapes and text are all drawn around 0,0). [app]
- Any of these can be keyframed (section 8).

## 4. Shapes

### Template shapes

```xml
<shape id="2" label="Rectangle 1" startTime="0" endTime="5000" fillType="color" s=".rect">
  <transform><location value="540.000000,960.000000,0.000000"/></transform>
  <fillColor value="#FFE3914C"/>
  <property name="size" type="vec2" value="300.000000,150.000000"/>
</shape>
```

- `s=".<slug>"` names the template: `.rect .roundrect .circle .triangle .quad
  .penta .line .poly .star .multifoil .plus .arrow .wideline .pie .arc .moon
  .teardrop .callout.roundrect .stamp`. [app] (rect, circle, plus, multifoil,
  roundrect, pie) / [decomp] (the rest)
- **`size` is half-width, half-height.** `size="300,150"` is a 600×300
  rectangle; a full-frame rect on a 1080×1080 canvas is `size="540,540"`. The
  template geometry spans `-size..+size`, and the app's own exports use
  `540,540` on 1080 canvases and `960,…` on 1920 canvases. [app]
- Parameter names, types and defaults for every template are in
  `catalog/catalog.json` (`shapes`). Omitted parameters take their default.

### Custom paths

```xml
<shape id="3" label="Heart" startTime="0" endTime="5000" fillType="color">
  <transform><location value="540.000000,490.000000,0.000000"/></transform>
  <fillColor value="#FFFF4F9E"/>
  <path d="M 0.0 -70.0C 0.0 -150.0, -100.0 -200.0, -160.0 -150.0C …Z"/>
</shape>
```

- No `s` attribute; the outline is SVG path data in layer coordinates
  (relative to `location`). [app]
- The app writes only absolute `M`, `L`, `C` and `Z`, with `C` control
  points separated by commas. Write the same; `amx path` converts any SVG path
  (relative commands, H/V, Q/T, S, A) to this form. [app]
- Several subpaths in one `d` are allowed (each starts with `M`). [guess]

### Stroke

```xml
<path-stroke direction="centered">
  <color value="#FFD41374"/>
  <size value="16.000000"/>
</path-stroke>
```

`direction` is `centered`, `inside` or `outside`; `color` and `size` are
keyable child elements, not attributes. Works on template and custom shapes.
For an outline-only shape use `fillType="none"`. [app]

### Gradient fill

```xml
<shape … fillType="gradient" s=".rect">
  …
  <gradient type="linear" startColor="#FF17467A" endColor="#FF00FFB5"
            start="0.000000,0.000000" end="1.000000,1.000000"/>
</shape>
```

`type` is `linear`, `radial` or `sweep`; `start`/`end` are 0..1 across the
layer's bounds. [app]

## 5. Images and other media

Each file is declared once with `<media>` before the layers, then used as a
fill. An imported photo is a shape with a rectangle path and a media fill [app]:

```xml
<media uri="am-internal:///4073A9A25F28C7DEC1123EE4C83CFA9764359693.jpg"
       filename="4073A9A25F28C7DEC1123EE4C83CFA9764359693.jpg" title="beach.jpg"
       type="image/jpeg" size="1531118" sig="4073A9A25F28C7DEC1123EE4C83CFA9764359693"
       orientation="0" infoUpdated="1606907728401" width="4194" height="2796"/>
<shape id="12" label="beach.jpg" startTime="0" endTime="2032" fillType="media"
       fillImage="am-internal:///4073A9A25F28C7DEC1123EE4C83CFA9764359693.jpg">
  <transform><location value="540.000000,540.000000,0.000000"/></transform>
  <path d="M -540.0 -360.0L 540.0 -360.0L 540.0 360.0L -540.0 360.0L -540.0 -360.0Z"/>
</shape>
```

- On import the app sizes a picture to fit inside the canvas; the path is that
  fitted rectangle. [app]
- Any shape (template or path) can take a media fill, which clips the picture
  to the shape. [app]
- `sig` is 40 hex digits; this toolkit uses the SHA-1 of the file, upper
  case. Packaged media is stored under `<sig>.<ext>` and referenced as
  `am-internal:///<sig>.<ext>`. [app] (form) / [guess] (that sig is SHA-1)
- `mediaFillMode` is `fill` (cover) by default; `fit` and `stretch` also
  appear in the decompile. [decomp]
- Audio is an `<audio>` layer with `src="<uri>"`. [decomp]
- **Getting the files onto the phone**: a bare `.xml` imports with media
  marked missing, which the app lets you replace. This toolkit also writes a
  `.zip` with the XML and media named `<sig>.<ext>`, mirroring the app's
  "Share Zipped XML" option; that this exact zip layout imports is [guess].

## 6. Text

```xml
<text id="1" label="Title" startTime="0" endTime="3000" fillType="color" size="96.000000"
      font="googlefonts?name=Archivo Black&amp;weight=400" wrapWidth="900" align="center">
  <transform><location value="540.000000,540.000000,0.000000"/></transform>
  <fillColor value="#FFFFFFFF"/>
  <content>Hello world</content>
</text>
```

- `size` font size in px; `wrapWidth` line width in px; `align`
  `left|center|right`. [app]
- `font="googlefonts?name=<Google Fonts family>&weight=<100..900>"` (the `&`
  is escaped as `&amp;` in XML). [app]
- `<content>` holds the text; new lines are literal line breaks. [app]
- Text takes `path-stroke` / `border` decorations and text effects such as
  Text Progress (typewriter). [app]

## 7. Freehand drawing

```xml
<drawing id="5" label="Drawing 1" startTime="0" endTime="3000" fillType="none">
  <transform>…</transform>
  <stroke color="#FFFFFFFF" width="8.000000" type="pen" points="0,0,1;120,80,1"/>
</drawing>
```

`points` is `x,y,pressure` triples joined by `;`. [decomp] An app export
only shows this form in a comment, so prefer custom path shapes for anything
that must import. [guess]

## 8. Keyframes and easing

A keyable value is written either with `value="…"` (static) or with `<kf>`
children (animated) [app]:

```xml
<rotation>
  <kf t="0.000000" v="0.000000"/>
  <kf t="1.000000" v="360.000000" e="cubicBezier 0.42 0.0 0.58 1.0"/>
</rotation>
```

- **`t` is a fraction of the layer's duration**: 0 is the layer's
  `startTime`, 1 its `endTime`. It is not seconds. All 615 keyframes in the app's own
  exports have `t` within -0.017..1.003. A key at
  1.2 s on a layer that runs 0.5 s to 4.5 s has `t = 1.2 / 4 = 0.3`. [app]
- `v` uses the same format as the static value (`x,y,z`, `#AARRGGBB`, …). [app]
- `e` is the easing **into** this keyframe from the previous one; omitted
  means linear. `cubicBezier x1 y1 x2 y2` uses CSS conventions. [app] (the
  form) / [guess] (incoming segment; the first keyframe never carries one in
  app exports, which fits)
- Common curves from the app: ease in-out `0.42 0.0 0.58 1.0`, ease in
  `0.42 0.0 1.0 1.0`, ease out `0.0 0.0 0.58 1.0`, hold `1.0 0.0 1.0 0.0`.
  A `cyclic …` form also exists (5 numbers). [app]
- Keyframes may appear out of time order in app exports; sort by `t` when
  reading. [app]
- Animatable: every transform child, `fillColor`, `path-stroke` color/size,
  shape `<property>` values, effect `<property>` values. [app]

## 9. Effects

```xml
<effect id="com.alightcreative.effects.gaussianblur" locallyApplied="true">
  <property name="strength" type="float" value="0.350000"/>
</effect>
```

- `id` is the effect's full id from the catalog (it does not always match the
  asset file name). `locallyApplied="true"` is always written. [app]
- Parameters are `<property name type value>`; omitted parameters use their
  default. Types: `float`, `int` (dropdowns), `bool`, `color`, `vec2`,
  `vec3`, `quat`, `string`. [app]
- `catalog/catalog.json` lists all 282 effects (196 current) with parameter
  ids, types, defaults, ranges and dropdown choices, extracted from the APK
  assets. Effects marked `membersOnly` need a subscription to export.
- The layer's own outline/shadow/glow decorations (`<border>`, `<shadow>`,
  `<glow>`) are not effects; their exact form is [decomp] only. For glows
  and shadows prefer the Glow (`com.alightcreative.glow`) and Long Shadow
  effects, which are certain.

## 10. Nested scenes, parents, nulls

- `<embedScene>` holds a complete `<scene>` after its transform; the nested
  scene is drawn centered on the layer's location. [decomp]
- `parent="<id>"` attaches a layer to another layer's transform; a
  `<nullobj>` is an invisible parent. [decomp]

## 11. What a minimal file needs

1. `<scene>` with width, height, exportWidth, exportHeight, bgcolor, totalTime, fps
   (plus modifiedTime, amver, ffver, am, amplatform to look like the app).
2. Unique integer ids and `startTime < endTime` on every layer.
3. A `<transform>` with at least `location` on every visual layer.
4. Full effect ids; keyframe `t` within 0..1.

`amx validate` checks all of these; the app's own 13 exports pass it.
