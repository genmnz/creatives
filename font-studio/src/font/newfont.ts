// A new, empty but valid TrueType font to start from.
import { FontProject, defaultOS2 } from './font.ts';
import { emptyGlyph } from './glyf.ts';
import { nowLongDateTime } from './tables.ts';
import { rectContour } from './ops.ts';

export interface NewFontOptions {
  family: string; style?: string; upm?: number; ascender?: number; descender?: number;
  xHeight?: number; capHeight?: number; designer?: string;
}

export function newFont(o: NewFontOptions): FontProject {
  const upm = o.upm ?? 1000;
  const k = upm / 1000;
  const asc = o.ascender ?? Math.round(800 * k), desc = o.descender ?? -Math.round(200 * k);
  const style = o.style || 'Regular';
  const p = new FontProject();
  const now = nowLongDateTime();
  p.head = {
    majorVersion: 1, minorVersion: 0, fontRevision: 0x00010000, flags: 0b1011, unitsPerEm: upm,
    created: now, modified: now, macStyle: 0, lowestRecPPEM: 8, fontDirectionHint: 2,
    indexToLocFormat: 1, glyphDataFormat: 0,
  };
  p.hhea = { version: 0x00010000, ascender: asc, descender: desc, lineGap: 0, caretSlopeRise: 1, caretSlopeRun: 0 };
  p.maxp = { version: 0x00010000, numGlyphs: 2, maxZones: 1 };
  p.os2 = {
    ...defaultOS2(), sTypoAscender: asc, sTypoDescender: desc, usWinAscent: asc, usWinDescent: -desc,
    sxHeight: o.xHeight ?? Math.round(500 * k), sCapHeight: o.capHeight ?? Math.round(700 * k),
    usWeightClass: /bold/i.test(style) ? 700 : 400, fsSelection: 0x80 | (/bold/i.test(style) ? 0x20 : 0x40),
  };
  p.post = { italicAngle: 0, underlinePosition: -Math.round(100 * k), underlineThickness: Math.round(50 * k), isFixedPitch: 0 };
  const ps = (o.family + '-' + style).replace(/[^A-Za-z0-9-]/g, '');
  const names: [number, string][] = [
    [1, o.family], [2, style], [3, `1.000;NONE;${ps}`], [4, `${o.family} ${style}`.replace(/ Regular$/, '')],
    [5, 'Version 1.000'], [6, ps],
  ];
  if (o.designer) names.push([9, o.designer]);
  p.nameRecords = names.map(([nameID, value]) => ({ platformID: 3, encodingID: 1, languageID: 0x409, nameID, value }));

  const notdef = emptyGlyph();
  const w = Math.round(500 * k), m = Math.round(50 * k), t = Math.round(60 * k);
  notdef.contours = [rectContour(m, 0, w - m, asc - m), rectContour(m + t, t, w - m - t, asc - m - t).reverse()];
  // keep the inner box counter-clockwise but starting on its first corner
  notdef.contours[1] = [notdef.contours[1][notdef.contours[1].length - 1], ...notdef.contours[1].slice(0, -1)];
  p.glyphs = [notdef, emptyGlyph()];
  p.names = ['.notdef', 'space'];
  p.adv = [w, Math.round(250 * k)];
  p.cmap = new Map([[0x20, 1]]);
  p.glyphVersion = [0, 0];
  p.originalNumGlyphs = 2;
  return p;
}
