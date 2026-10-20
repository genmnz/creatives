import { useState } from 'react';
import { studio } from '../store.ts';

export function NewFontForm({ onClose }: { onClose: () => void }) {
  const [o, setO] = useState({ family: 'My Font', style: 'Regular', upm: 1000, ascender: 800, descender: -200, xHeight: 500, capHeight: 700, designer: '' });
  const set = (k: keyof typeof o, v: string) => setO({ ...o, [k]: typeof o[k] === 'number' ? Number(v) : v });
  const field = (k: keyof typeof o, label: string) => (
    <label className="form-row"><span>{label}</span>
      <input value={o[k]} type={typeof o[k] === 'number' ? 'number' : 'text'} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  return (
    <div className="modal-back" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
        e.preventDefault();
        if (!o.family.trim()) return;
        studio.createFont({ ...o, family: o.family.trim() });
        onClose();
      }}>
        <h2>New font</h2>
        <p className="muted">Starts with .notdef and space. Add glyphs from the glyph list, draw them with the pen,
          rectangle and ellipse tools, and set metrics in the Font tab.</p>
        {field('family', 'Family name')}
        {field('style', 'Style')}
        {field('designer', 'Designer')}
        {field('upm', 'Units per em')}
        {field('ascender', 'Ascender')}
        {field('descender', 'Descender')}
        {field('xHeight', 'x-height')}
        {field('capHeight', 'Cap height')}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Create</button>
        </div>
      </form>
    </div>
  );
}
