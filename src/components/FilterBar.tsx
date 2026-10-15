import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import {
  CONFIDENCE_LABEL,
  FILTER_GROUP_LABEL,
  FLAG_OPTIONS,
  type FacetOption,
  type FilterGroup,
} from '../types';

const MAX_RENDER = 150;

function Facet({
  group,
  options,
  total,
  align = 'left',
}: {
  group: FilterGroup;
  options: FacetOption[];
  total?: number;
  align?: 'left' | 'right';
}) {
  const selected = useApp((s) => s.filters[group]);
  const toggle = useApp((s) => s.toggleFilter);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const list = kw ? options.filter((o) => o.label.toLowerCase().includes(kw)) : options;
    return list;
  }, [options, q]);

  const shown = filtered.slice(0, MAX_RENDER);
  const hasAny = options.length > 0;

  return (
    <div className="facet" ref={ref}>
      <button
        className={`facet-btn ${selected.length ? 'on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={!hasAny}
        title={hasAny ? undefined : '当前范围下没有可选项'}
      >
        {FILTER_GROUP_LABEL[group]}
        {selected.length ? <b>{selected.length}</b> : null}
        <span className="caret">▾</span>
      </button>

      {open ? (
        <div className={`facet-pop ${align === 'right' ? 'right' : ''}`}>
          {options.length > 10 ? (
            <input
              className="facet-search"
              placeholder="输入关键词缩小范围…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          ) : null}
          <div className="facet-list">
            {shown.map((o) => (
              <label key={o.value} className="facet-opt">
                <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(group, o.value)} />
                <span className="facet-label" title={o.label}>
                  {o.label}
                </span>
                <span className="facet-count">{o.count}</span>
              </label>
            ))}
            {!shown.length ? <div className="facet-empty">没有匹配的选项</div> : null}
          </div>
          {filtered.length > shown.length || (total ?? 0) > options.length ? (
            <div className="facet-more">
              显示 {shown.length} / 共 {total ?? options.length} 项，输入关键词缩小范围
            </div>
          ) : null}
          {selected.length ? (
            <div className="facet-foot">
              <button className="btn small" onClick={() => selected.forEach((v) => toggle(group, v))}>
                清除本组
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function FilterBar() {
  const facets = useApp((s) => s.facets);
  const filters = useApp((s) => s.filters);
  const toggleFilter = useApp((s) => s.toggleFilter);
  const clearFilters = useApp((s) => s.clearFilters);

  const flagOptions = useMemo<FacetOption[]>(
    () =>
      FLAG_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: facets?.flags?.[o.value] ?? 0 })).filter(
        (o) => o.count > 0 || filters.flags.includes(o.value),
      ),
    [facets, filters.flags],
  );

  const confidenceOptions = useMemo<FacetOption[]>(
    () => (facets?.confidence ?? []).map((o) => ({ ...o, label: CONFIDENCE_LABEL[o.value] ?? o.value })),
    [facets],
  );

  const chips: { group: FilterGroup; value: string; label: string }[] = [];
  for (const group of Object.keys(filters) as FilterGroup[]) {
    for (const value of filters[group]) {
      let label = value;
      if (group === 'types') label = facets?.types.find((t) => t.value === value)?.label ?? value;
      else if (group === 'confidence') label = CONFIDENCE_LABEL[value] ?? value;
      else if (group === 'flags') label = FLAG_OPTIONS.find((f) => f.value === value)?.label ?? value;
      chips.push({ group, value, label });
    }
  }

  return (
    <div className="filter-bar">
      <div className="facet-row">
        <Facet group="years" options={facets?.years ?? []} />
        <Facet group="types" options={facets?.types ?? []} />
        <Facet group="venues" options={facets?.venues ?? []} total={facets?.venuesTotal} align="right" />
        <Facet group="authors" options={facets?.authors ?? []} total={facets?.authorsTotal} align="right" />
        <Facet group="tags" options={facets?.tags ?? []} align="right" />
        <Facet group="confidence" options={confidenceOptions} align="right" />
        <Facet group="flags" options={flagOptions} align="right" />
      </div>

      {chips.length ? (
        <div className="filter-chips">
          {chips.map((c) => (
            <button
              key={`${c.group}:${c.value}`}
              className="chip-btn"
              onClick={() => toggleFilter(c.group, c.value)}
              title="点击移除"
            >
              <span className="chip-group">{FILTER_GROUP_LABEL[c.group]}</span>
              {c.label}
              <span className="x">✕</span>
            </button>
          ))}
          <button className="btn small" onClick={clearFilters}>
            清除全部
          </button>
        </div>
      ) : null}
    </div>
  );
}
