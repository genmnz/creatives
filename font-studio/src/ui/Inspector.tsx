import { useState } from 'react';
import { useStudio } from '../store.ts';
import { Tabs } from './common.tsx';
import { GlyphPanel } from './GlyphPanel.tsx';
import { FormsPanel } from './FormsPanel.tsx';
import { PositioningPanel } from './PositioningPanel.tsx';
import { FontPanel } from './FontPanel.tsx';
import { BatchPanel } from './BatchPanel.tsx';

type Tab = 'glyph' | 'forms' | 'pos' | 'font' | 'batch';

export function Inspector() {
  useStudio();
  const [tab, setTab] = useState<Tab>('glyph');
  return (
    <aside className="inspector">
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[['glyph', 'Glyph'], ['forms', 'Forms'], ['pos', 'Anchors & kerning'], ['font', 'Font'], ['batch', 'Batch']]} />
      <div className="inspector-body">
        {tab === 'glyph' && <GlyphPanel />}
        {tab === 'forms' && <FormsPanel />}
        {tab === 'pos' && <PositioningPanel />}
        {tab === 'font' && <FontPanel />}
        {tab === 'batch' && <BatchPanel />}
      </div>
    </aside>
  );
}
